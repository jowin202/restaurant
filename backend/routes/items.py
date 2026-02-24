import asyncio
import base64
import hashlib
import mimetypes
import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional, Tuple
from urllib.parse import urlparse

import requests
from bson import ObjectId
from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field

from db import get_db


MAX_IMAGE_SIZE = 12 * 1024 * 1024  # 12 MiB
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"}
EAN_RE = re.compile(r"^\d{8,14}$")

router = APIRouter()


class OrderAttributeDefinition(BaseModel):
    key: str = Field(min_length=1, max_length=120)
    label: Optional[str] = Field(default=None, max_length=120)
    input_type: Literal["string", "select", "boolean"] = "string"
    options: List[str] = Field(default_factory=list)
    required: bool = False


class ItemBase(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    item_type: Literal["essen", "getränk"] = "essen"
    attributes: Dict[str, Any] = Field(default_factory=dict)
    order_attributes: List[OrderAttributeDefinition] = Field(default_factory=list)
    in_stock: bool = True
    quantity: Optional[float] = None
    unit: Optional[str] = None
    ean: Optional[str] = None


class ItemCreate(ItemBase):
    metadata_source: Optional[str] = None


class ItemUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    item_type: Optional[Literal["essen", "getränk"]] = None
    attributes: Optional[Dict[str, Any]] = None
    order_attributes: Optional[List[OrderAttributeDefinition]] = None
    in_stock: Optional[bool] = None
    quantity: Optional[float] = None
    unit: Optional[str] = None
    ean: Optional[str] = None
    metadata_source: Optional[str] = None


class ItemOut(ItemBase):
    id: str
    created_at: datetime
    updated_at: datetime
    has_image: bool = False
    image_data_url: Optional[str] = None
    image_data_urls: List[str] = Field(default_factory=list)
    images: List[Dict[str, Any]] = Field(default_factory=list)


class StockIncreaseByEan(BaseModel):
    ean: str
    quantity_delta: float = Field(default=1, gt=0)


class StockAdjustRequest(BaseModel):
    item_id: Optional[str] = None
    ean: Optional[str] = None
    quantity_delta: float
    reason: Optional[Literal["consume", "restock", "inventory"]] = None


class ImageFromUrlRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2048)


def _normalize_attributes(attributes: Dict[str, Any]) -> Dict[str, Any]:
    normalized: Dict[str, Any] = {}
    for key, value in attributes.items():
        clean_key = str(key).strip()
        if not clean_key:
            continue
        normalized[clean_key] = value
    return normalized


def _normalize_order_attributes(order_attributes: List[Any]) -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    seen_keys: set[str] = set()

    for row in order_attributes:
        source = row.model_dump() if isinstance(row, BaseModel) else row
        if not isinstance(source, dict):
            continue

        clean_key = str(source.get("key", "")).strip()
        if not clean_key:
            continue

        lowered_key = clean_key.lower()
        if lowered_key in seen_keys:
            continue

        input_type = str(source.get("input_type", "string")).strip().lower()
        if input_type not in {"string", "select", "boolean"}:
            input_type = "string"

        label = str(source.get("label", "")).strip() or clean_key
        required = bool(source.get("required", False))

        options: List[str] = []
        raw_options = source.get("options") or []
        if input_type == "select":
            if not isinstance(raw_options, list):
                raw_options = [raw_options]

            for option in raw_options:
                clean_option = str(option).strip()
                if clean_option and clean_option not in options:
                    options.append(clean_option)

            if not options:
                input_type = "string"

        normalized.append(
            {
                "key": clean_key,
                "label": label,
                "input_type": input_type,
                "options": options if input_type == "select" else [],
                "required": required,
            }
        )
        seen_keys.add(lowered_key)

    return normalized


def _normalize_ean(ean: Optional[str]) -> Optional[str]:
    if ean is None:
        return None

    digits_only = "".join(ch for ch in str(ean) if ch.isdigit())
    if not digits_only:
        return None

    if not EAN_RE.match(digits_only):
        raise HTTPException(status_code=400, detail="Ungültiger EAN (erlaubt: 8 bis 14 Ziffern)")

    return digits_only


def _build_data_url(image: Optional[Dict[str, Any]]) -> Optional[str]:
    if not image:
        return None

    content_type = image.get("content_type")
    data = image.get("data_base64")
    if not content_type or not data:
        return None

    return f"data:{content_type};base64,{data}"


def _normalize_image_entries(doc: Dict[str, Any]) -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []

    raw_images = doc.get("images")
    if isinstance(raw_images, list):
        for row in raw_images:
            if not isinstance(row, dict):
                continue

            content_type = row.get("content_type")
            data = row.get("data_base64")
            if not content_type or not data:
                continue

            entries.append(
                {
                    "id": str(row.get("id") or f"img-{hashlib.md5(str(data).encode('utf-8')).hexdigest()[:12]}"),
                    "filename": str(row.get("filename") or "image"),
                    "content_type": str(content_type),
                    "data_base64": str(data),
                    "created_at": row.get("created_at"),
                }
            )

    legacy_image = doc.get("image")
    if isinstance(legacy_image, dict):
        content_type = legacy_image.get("content_type")
        data = legacy_image.get("data_base64")
        if content_type and data:
            legacy_id = str(legacy_image.get("id") or "legacy")
            if not any(x["id"] == legacy_id for x in entries):
                entries.append(
                    {
                        "id": legacy_id,
                        "filename": str(legacy_image.get("filename") or "image"),
                        "content_type": str(content_type),
                        "data_base64": str(data),
                        "created_at": legacy_image.get("created_at"),
                    }
                )

    return entries


def _new_image_entry(filename: str, content_type: str, data_base64: str) -> Dict[str, Any]:
    return {
        "id": str(ObjectId()),
        "filename": (filename or "image")[:140],
        "content_type": content_type,
        "data_base64": data_base64,
        "created_at": datetime.now(timezone.utc),
    }


def _extract_filename_from_url(url: str) -> str:
    path = urlparse(url).path
    filename = os.path.basename(path).strip()
    if filename:
        return filename[:140]
    return "image"


def _resolve_content_type(url: str, response_content_type: Optional[str]) -> Optional[str]:
    header_type = (response_content_type or "").split(";")[0].strip().lower()
    if header_type in ALLOWED_IMAGE_TYPES:
        return header_type

    guessed_type, _ = mimetypes.guess_type(url)
    if guessed_type in ALLOWED_IMAGE_TYPES:
        return guessed_type

    return None


def _download_image_from_url(url: str) -> Tuple[bytes, str, str]:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(status_code=400, detail="Nur http/https URLs sind erlaubt")

    try:
        response = requests.get(url, timeout=12, allow_redirects=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Bild-URL konnte nicht geladen werden")

    if response.status_code >= 400:
        raise HTTPException(status_code=400, detail="Bild-URL liefert keinen gültigen Inhalt")

    content = response.content or b""
    if not content:
        raise HTTPException(status_code=400, detail="Die Bild-URL ist leer")

    if len(content) > MAX_IMAGE_SIZE:
        raise HTTPException(status_code=413, detail="Bild ist zu groß (max. 12MB)")

    final_url = response.url or url
    content_type = _resolve_content_type(final_url, response.headers.get("content-type"))
    if not content_type:
        raise HTTPException(status_code=400, detail="Ungültiger Dateityp. Erlaubt: JPEG, PNG, WEBP, GIF")

    return content, content_type, _extract_filename_from_url(final_url)


def _to_item_out(doc: Dict[str, Any], include_image_data: bool) -> Dict[str, Any]:
    image_entries = _normalize_image_entries(doc)
    image_meta = [
        {
            "id": image.get("id"),
            "filename": image.get("filename"),
            "content_type": image.get("content_type"),
            "created_at": image.get("created_at"),
        }
        for image in image_entries
    ]
    image_data_urls = [_build_data_url(image) for image in image_entries] if include_image_data else []
    image_data_urls = [x for x in image_data_urls if x]

    return {
        "id": str(doc["_id"]),
        "name": doc.get("name", ""),
        "item_type": doc.get("item_type", "essen"),
        "attributes": doc.get("attributes", {}),
        "order_attributes": doc.get("order_attributes", []),
        "in_stock": doc.get("in_stock", True),
        "quantity": doc.get("quantity"),
        "unit": doc.get("unit"),
        "ean": doc.get("ean"),
        "created_at": doc.get("created_at"),
        "updated_at": doc.get("updated_at"),
        "has_image": len(image_entries) > 0,
        "image_data_url": image_data_urls[0] if len(image_data_urls) > 0 else None,
        "image_data_urls": image_data_urls,
        "images": image_meta,
    }


def _parse_item_id(item_id: str) -> ObjectId:
    if not ObjectId.is_valid(item_id):
        raise HTTPException(status_code=400, detail="Ungültige Item-ID")
    return ObjectId(item_id)


def _is_numeric(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


async def _apply_stock_delta(existing: Dict[str, Any], delta: float):
    db = await get_db()
    current_quantity = existing.get("quantity")
    numeric_quantity = float(current_quantity) if _is_numeric(current_quantity) else 0.0
    new_quantity = round(numeric_quantity + delta, 3)

    if new_quantity < 0:
        raise HTTPException(
            status_code=409,
            detail=f"Bestand kann nicht negativ werden (aktuell: {numeric_quantity}, delta: {delta})",
        )

    await db.items.update_one(
        {"_id": existing["_id"]},
        {
            "$set": {
                "quantity": new_quantity,
                "in_stock": new_quantity > 0,
                "updated_at": datetime.now(timezone.utc),
            }
        },
    )

    updated = await db.items.find_one({"_id": existing["_id"]})
    return updated


async def _append_image_entry(item_oid: ObjectId, image_entry: Dict[str, Any]):
    db = await get_db()
    existing = await db.items.find_one({"_id": item_oid})
    if not existing:
        raise HTTPException(404, "Item nicht gefunden")

    entries = _normalize_image_entries(existing)
    entries.append(image_entry)

    await db.items.update_one(
        {"_id": item_oid},
        {
            "$set": {
                "images": entries,
                "updated_at": datetime.now(timezone.utc),
            },
            "$unset": {"image": ""},
        },
    )


def _infer_item_type(name: str, category: str) -> Literal["essen", "getränk"]:
    text = f"{name} {category}".lower()
    beverage_keywords = [
        "drink",
        "beverage",
        "juice",
        "water",
        "cola",
        "soda",
        "bier",
        "beer",
        "wein",
        "wine",
        "tee",
        "kaffee",
        "coffee",
        "getränk",
    ]
    return "getränk" if any(keyword in text for keyword in beverage_keywords) else "essen"


def _safe_get_json(url: str, headers: Optional[Dict[str, str]] = None, params: Optional[Dict[str, str]] = None) -> Optional[Dict[str, Any]]:
    try:
        response = requests.get(url, headers=headers, params=params, timeout=5)
        if response.status_code >= 400:
            return None
        return response.json()
    except Exception:
        return None


async def _provider_openfoodfacts(ean: str) -> Optional[Dict[str, Any]]:
    data = await asyncio.to_thread(
        _safe_get_json,
        f"https://world.openfoodfacts.org/api/v2/product/{ean}.json",
    )
    if not data or data.get("status") != 1:
        return None

    product = data.get("product", {})
    name = product.get("product_name_de") or product.get("product_name") or ""
    brand = product.get("brands")
    quantity = product.get("quantity")
    categories = product.get("categories") or ""
    image_url = product.get("image_front_url") or product.get("image_url")

    if not name:
        return None

    attributes: Dict[str, Any] = {}
    if brand:
        attributes["marke"] = brand
    if categories:
        attributes["kategorie"] = categories
    if product.get("nutriscore_grade"):
        attributes["nutriscore"] = product.get("nutriscore_grade")

    return {
        "source": "openfoodfacts",
        "name": name,
        "brand": brand,
        "quantity": quantity,
        "category": categories,
        "image_url": image_url,
        "item_type": _infer_item_type(name, categories),
        "attributes": attributes,
    }


async def _provider_upcitemdb(ean: str) -> Optional[Dict[str, Any]]:
    api_key = os.getenv("UPCITEMDB_API_KEY", "").strip()
    if not api_key:
        return None

    data = await asyncio.to_thread(
        _safe_get_json,
        "https://api.upcitemdb.com/prod/trial/lookup",
        {"user_key": api_key},
        {"upc": ean},
    )
    if not data:
        return None

    items = data.get("items") or []
    if not items:
        return None

    item = items[0]
    title = item.get("title") or ""
    brand = item.get("brand") or item.get("manufacturer")
    category = item.get("category") or ""

    if not title:
        return None

    attributes: Dict[str, Any] = {}
    if brand:
        attributes["marke"] = brand
    if category:
        attributes["kategorie"] = category

    return {
        "source": "upcitemdb",
        "name": title,
        "brand": brand,
        "quantity": None,
        "category": category,
        "image_url": (item.get("images") or [None])[0],
        "item_type": _infer_item_type(title, category),
        "attributes": attributes,
    }


async def _provider_barcodelookup(ean: str) -> Optional[Dict[str, Any]]:
    api_key = os.getenv("BARCODELOOKUP_API_KEY", "").strip()
    if not api_key:
        return None

    data = await asyncio.to_thread(
        _safe_get_json,
        "https://api.barcodelookup.com/v3/products",
        None,
        {"barcode": ean, "formatted": "y", "key": api_key},
    )
    if not data:
        return None

    products = data.get("products") or []
    if not products:
        return None

    product = products[0]
    title = product.get("title") or ""
    brand = product.get("brand")
    category = product.get("category") or ""

    if not title:
        return None

    attributes: Dict[str, Any] = {}
    if brand:
        attributes["marke"] = brand
    if category:
        attributes["kategorie"] = category

    return {
        "source": "barcodelookup",
        "name": title,
        "brand": brand,
        "quantity": None,
        "category": category,
        "image_url": product.get("images", [None])[0] if product.get("images") else None,
        "item_type": _infer_item_type(title, category),
        "attributes": attributes,
    }


async def _fetch_ean_metadata(ean: str) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    providers = [
        ("openfoodfacts", _provider_openfoodfacts),
        ("upcitemdb", _provider_upcitemdb),
        ("barcodelookup", _provider_barcodelookup),
    ]

    queried: List[str] = []
    for provider_name, provider_fn in providers:
        queried.append(provider_name)
        metadata = await provider_fn(ean)
        if metadata:
            return metadata, queried

    return None, queried


@router.get("/ean/{ean}/lookup/")
async def lookup_ean(ean: str):
    db = await get_db()
    normalized_ean = _normalize_ean(ean)
    if not normalized_ean:
        raise HTTPException(status_code=400, detail="EAN fehlt")

    existing = await db.items.find_one({"ean": normalized_ean})
    if existing:
        return {
            "ean": normalized_ean,
            "known": True,
            "action": "increase_stock",
            "item": _to_item_out(existing, include_image_data=False),
            "metadata_found": True,
            "metadata": {
                "source": "local_db",
                "name": existing.get("name"),
                "item_type": existing.get("item_type"),
                "unit": existing.get("unit"),
                "attributes": existing.get("attributes", {}),
                "order_attributes": existing.get("order_attributes", []),
            },
            "providers_queried": ["local_db"],
        }

    metadata, providers_queried = await _fetch_ean_metadata(normalized_ean)
    return {
        "ean": normalized_ean,
        "known": False,
        "action": "create_item",
        "item": None,
        "metadata_found": metadata is not None,
        "metadata": metadata,
        "providers_queried": providers_queried,
    }


@router.post("/ean/stock-increase/")
async def increase_stock_by_ean(data: StockIncreaseByEan, request: Request):
    if getattr(request.state, "admin", 0) <= 0:
        raise HTTPException(status_code=403, detail="Nur Admins dürfen Lagerbestand anpassen")

    db = await get_db()
    normalized_ean = _normalize_ean(data.ean)
    if not normalized_ean:
        raise HTTPException(status_code=400, detail="EAN fehlt")

    existing = await db.items.find_one({"ean": normalized_ean})
    if not existing:
        raise HTTPException(status_code=404, detail="EAN ist unbekannt. Bitte Produkt zuerst anlegen.")

    updated = await _apply_stock_delta(existing, data.quantity_delta)
    return {
        "status": "success",
        "action": "stock_increased",
        "item": _to_item_out(updated, include_image_data=False),
    }


@router.post("/stock-adjust/")
async def adjust_stock(data: StockAdjustRequest, request: Request):
    if getattr(request.state, "admin", 0) <= 0:
        raise HTTPException(status_code=403, detail="Nur Admins dürfen Lagerbestand anpassen")

    if data.quantity_delta == 0:
        raise HTTPException(status_code=400, detail="quantity_delta darf nicht 0 sein")

    db = await get_db()
    existing = None

    if data.item_id:
        oid = _parse_item_id(data.item_id)
        existing = await db.items.find_one({"_id": oid})
    elif data.ean:
        normalized_ean = _normalize_ean(data.ean)
        if not normalized_ean:
            raise HTTPException(status_code=400, detail="EAN fehlt")
        existing = await db.items.find_one({"ean": normalized_ean})
    else:
        raise HTTPException(status_code=400, detail="Bitte item_id oder ean angeben")

    if not existing:
        raise HTTPException(status_code=404, detail="Item nicht gefunden")

    updated = await _apply_stock_delta(existing, data.quantity_delta)
    action = "restocked" if data.quantity_delta > 0 else "consumed"

    return {
        "status": "success",
        "action": action,
        "reason": data.reason,
        "delta": data.quantity_delta,
        "item": _to_item_out(updated, include_image_data=False),
    }


@router.get("/", response_model=List[ItemOut])
async def get_all_items(
    search: Optional[str] = Query(default=None),
    item_type: Optional[Literal["essen", "getränk"]] = Query(default=None),
    in_stock: Optional[bool] = Query(default=None),
    include_images: bool = Query(default=True),
):
    db = await get_db()

    mongo_query: Dict[str, Any] = {}
    if search:
        mongo_query["name"] = {"$regex": search, "$options": "i"}
    if item_type:
        mongo_query["item_type"] = item_type
    if in_stock is not None:
        mongo_query["in_stock"] = in_stock

    docs = await db.items.find(mongo_query).sort("updated_at", -1).to_list(length=200)
    return [_to_item_out(doc, include_image_data=include_images) for doc in docs]


@router.get("/{item_id}/", response_model=ItemOut)
async def get_one_item(item_id: str, include_images: bool = Query(default=True)):
    db = await get_db()
    oid = _parse_item_id(item_id)

    doc = await db.items.find_one({"_id": oid})
    if not doc:
        raise HTTPException(404, "Item nicht gefunden")

    return _to_item_out(doc, include_image_data=include_images)


@router.post("/", response_model=ItemOut)
async def create_item(data: ItemCreate):
    db = await get_db()
    now = datetime.now(timezone.utc)
    normalized_ean = _normalize_ean(data.ean)

    if normalized_ean:
        existing = await db.items.find_one({"ean": normalized_ean}, {"_id": 1})
        if existing:
            raise HTTPException(status_code=409, detail="EAN bereits vorhanden")

    payload = {
        "name": data.name,
        "item_type": data.item_type,
        "attributes": _normalize_attributes(data.attributes),
        "order_attributes": _normalize_order_attributes(data.order_attributes),
        "in_stock": data.in_stock,
        "quantity": data.quantity,
        "unit": data.unit,
        "ean": normalized_ean,
        "metadata_source": data.metadata_source,
        "created_at": now,
        "updated_at": now,
    }

    result = await db.items.insert_one(payload)
    created = await db.items.find_one({"_id": result.inserted_id})
    return _to_item_out(created, include_image_data=True)


@router.put("/{item_id}/", response_model=ItemOut)
async def update_item(item_id: str, data: ItemUpdate):
    db = await get_db()
    oid = _parse_item_id(item_id)

    fields = data.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(400, "Keine Felder zum Aktualisieren übergeben")

    if "attributes" in fields and fields["attributes"] is not None:
        fields["attributes"] = _normalize_attributes(fields["attributes"])

    if "order_attributes" in fields and fields["order_attributes"] is not None:
        fields["order_attributes"] = _normalize_order_attributes(fields["order_attributes"])

    if "ean" in fields:
        normalized_ean = _normalize_ean(fields["ean"])
        fields["ean"] = normalized_ean
        if normalized_ean:
            existing = await db.items.find_one({"ean": normalized_ean, "_id": {"$ne": oid}}, {"_id": 1})
            if existing:
                raise HTTPException(status_code=409, detail="EAN bereits vorhanden")

    fields["updated_at"] = datetime.now(timezone.utc)

    result = await db.items.update_one({"_id": oid}, {"$set": fields})
    if result.matched_count == 0:
        raise HTTPException(404, "Item nicht gefunden")

    updated = await db.items.find_one({"_id": oid})
    return _to_item_out(updated, include_image_data=True)


@router.delete("/{item_id}/")
async def delete_item(item_id: str):
    db = await get_db()
    oid = _parse_item_id(item_id)

    result = await db.items.delete_one({"_id": oid})
    if result.deleted_count == 0:
        raise HTTPException(404, "Item nicht gefunden")

    return {"status": "success", "deleted_id": item_id}


@router.post("/{item_id}/image/")
async def upload_item_image(item_id: str, file: UploadFile = File(...)):
    oid = _parse_item_id(item_id)

    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(400, "Ungültiger Dateityp. Erlaubt: JPEG, PNG, WEBP, GIF")

    content = await file.read()
    if len(content) > MAX_IMAGE_SIZE:
        raise HTTPException(413, "Bild ist zu groß (max. 12MB)")

    encoded = base64.b64encode(content).decode("utf-8")
    image_entry = _new_image_entry(file.filename or "image", file.content_type, encoded)
    await _append_image_entry(oid, image_entry)

    return {"status": "success", "item_id": item_id, "image_id": image_entry["id"]}


@router.delete("/{item_id}/image/")
async def delete_item_image(item_id: str, image_id: Optional[str] = Query(default=None)):
    db = await get_db()
    oid = _parse_item_id(item_id)
    existing = await db.items.find_one({"_id": oid})
    if not existing:
        raise HTTPException(404, "Item nicht gefunden")

    entries = _normalize_image_entries(existing)

    if image_id:
        remaining = [x for x in entries if x.get("id") != image_id]
        if len(remaining) == len(entries):
            raise HTTPException(404, "Bild nicht gefunden")
    else:
        remaining = []

    if len(remaining) == 0:
        await db.items.update_one(
            {"_id": oid},
            {
                "$unset": {"image": "", "images": ""},
                "$set": {"updated_at": datetime.now(timezone.utc)},
            },
        )
    else:
        await db.items.update_one(
            {"_id": oid},
            {
                "$set": {"images": remaining, "updated_at": datetime.now(timezone.utc)},
                "$unset": {"image": ""},
            },
        )

    return {"status": "success", "item_id": item_id, "remaining_images": len(remaining)}


@router.post("/{item_id}/image/from-url/")
async def upload_item_image_from_url(item_id: str, data: ImageFromUrlRequest):
    oid = _parse_item_id(item_id)

    content, content_type, filename = await asyncio.to_thread(_download_image_from_url, data.url.strip())
    encoded = base64.b64encode(content).decode("utf-8")
    image_entry = _new_image_entry(filename, content_type, encoded)
    await _append_image_entry(oid, image_entry)

    return {"status": "success", "item_id": item_id, "image_id": image_entry["id"]}

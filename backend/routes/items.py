import asyncio
import base64
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from pymongo.errors import DuplicateKeyError

from db import get_db
from routes.items_images import (
    ALLOWED_IMAGE_TYPES,
    MAX_IMAGE_SIZE,
    download_image_from_url as _download_image_from_url,
    new_image_entry as _new_image_entry,
    normalize_image_entries as _normalize_image_entries,
)
from routes.items_metadata import fetch_ean_metadata as _fetch_ean_metadata
from routes.items_models import (
    ImageFromUrlRequest,
    ItemCreate,
    ItemOut,
    ItemUpdate,
    StockAdjustRequest,
    StockIncreaseByEan,
)
from routes.items_normalize import (
    normalize_description_html as _normalize_description_html,
    normalize_ean as _normalize_ean,
    normalize_order_attributes as _normalize_order_attributes,
    parse_item_id as _parse_item_id,
)
from routes.items_service import (
    append_image_entry as _append_image_entry,
    apply_stock_delta as _apply_stock_delta,
    to_item_out as _to_item_out,
)


router = APIRouter()


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
    available: Optional[bool] = Query(default=None),
    include_images: bool = Query(default=True),
):
    db = await get_db()

    mongo_query: Dict[str, Any] = {}
    if search:
        mongo_query["name"] = {"$regex": search, "$options": "i"}
    if item_type:
        mongo_query["item_type"] = item_type
    if available is True:
        mongo_query["quantity"] = {"$type": "number", "$gt": 0}
    elif available is False:
        mongo_query["$or"] = [
            {"quantity": {"$exists": False}},
            {"quantity": None},
            {"quantity": {"$lte": 0}},
        ]

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
        "order_attributes": _normalize_order_attributes(data.order_attributes),
        "quantity": data.quantity if data.quantity is not None else 0,
        "unit": data.unit,
        "metadata_source": data.metadata_source,
        "created_at": now,
        "updated_at": now,
    }
    normalized_description = _normalize_description_html(data.description_html)
    if normalized_description is not None:
        payload["description_html"] = normalized_description

    if normalized_ean:
        payload["ean"] = normalized_ean

    try:
        result = await db.items.insert_one(payload)
    except DuplicateKeyError:
        if normalized_ean:
            raise HTTPException(status_code=409, detail="EAN bereits vorhanden")
        raise HTTPException(status_code=500, detail="Datenbankindexfehler bei EAN (null). Bitte Migration/Neustart prüfen.")

    created = await db.items.find_one({"_id": result.inserted_id})
    return _to_item_out(created, include_image_data=True)


@router.put("/{item_id}/", response_model=ItemOut)
async def update_item(item_id: str, data: ItemUpdate):
    db = await get_db()
    oid = _parse_item_id(item_id)

    fields = data.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(400, "Keine Felder zum Aktualisieren übergeben")
    unset_fields: Dict[str, str] = {}

    if "order_attributes" in fields and fields["order_attributes"] is not None:
        fields["order_attributes"] = _normalize_order_attributes(fields["order_attributes"])

    if "description_html" in fields:
        normalized_description = _normalize_description_html(fields.get("description_html"))
        if normalized_description is None:
            fields.pop("description_html", None)
            unset_fields["description_html"] = ""
        else:
            fields["description_html"] = normalized_description

    if "ean" in fields:
        normalized_ean = _normalize_ean(fields["ean"])
        if normalized_ean:
            fields["ean"] = normalized_ean
            existing = await db.items.find_one({"ean": normalized_ean, "_id": {"$ne": oid}}, {"_id": 1})
            if existing:
                raise HTTPException(status_code=409, detail="EAN bereits vorhanden")
        else:
            fields.pop("ean", None)
            unset_fields["ean"] = ""

    if "quantity" in fields and fields["quantity"] is None:
        fields["quantity"] = 0

    fields["updated_at"] = datetime.now(timezone.utc)

    update_doc: Dict[str, Any] = {"$set": fields}
    if unset_fields:
        update_doc["$unset"] = unset_fields

    try:
        result = await db.items.update_one({"_id": oid}, update_doc)
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="EAN bereits vorhanden")
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
                "$unset": {"images": ""},
                "$set": {"updated_at": datetime.now(timezone.utc)},
            },
        )
    else:
        await db.items.update_one(
            {"_id": oid},
            {
                "$set": {"images": remaining, "updated_at": datetime.now(timezone.utc)},
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

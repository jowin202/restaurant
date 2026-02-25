from datetime import datetime, timezone
from typing import Any, Dict

from bson import ObjectId
from fastapi import HTTPException

from db import get_db
from routes.items_images import build_data_url, normalize_image_entries
from routes.items_normalize import is_numeric


def to_item_out(doc: Dict[str, Any], include_image_data: bool) -> Dict[str, Any]:
    image_entries = normalize_image_entries(doc)
    image_meta = [
        {
            "id": image.get("id"),
            "filename": image.get("filename"),
            "content_type": image.get("content_type"),
            "created_at": image.get("created_at"),
        }
        for image in image_entries
    ]
    image_data_urls = [build_data_url(image) for image in image_entries] if include_image_data else []
    image_data_urls = [x for x in image_data_urls if x]

    return {
        "id": str(doc["_id"]),
        "name": doc.get("name", ""),
        "item_type": doc.get("item_type", "essen"),
        "attributes": doc.get("attributes", {}),
        "order_attributes": doc.get("order_attributes", []),
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


async def apply_stock_delta(existing: Dict[str, Any], delta: float):
    db = await get_db()
    current_quantity = existing.get("quantity")
    numeric_quantity = float(current_quantity) if is_numeric(current_quantity) else 0.0
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
                "updated_at": datetime.now(timezone.utc),
            }
        },
    )

    updated = await db.items.find_one({"_id": existing["_id"]})
    return updated


async def append_image_entry(item_oid: ObjectId, image_entry: Dict[str, Any]):
    db = await get_db()
    existing = await db.items.find_one({"_id": item_oid})
    if not existing:
        raise HTTPException(404, "Item nicht gefunden")

    entries = normalize_image_entries(existing)
    entries.append(image_entry)

    await db.items.update_one(
        {"_id": item_oid},
        {
            "$set": {
                "images": entries,
                "updated_at": datetime.now(timezone.utc),
            },
        },
    )

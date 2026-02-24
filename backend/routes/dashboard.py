from fastapi import APIRouter, HTTPException

from db import get_db

router = APIRouter()


@router.get("/")
async def get_dashboard_data():
    db = await get_db()
    try:
        total_items = await db.items.count_documents({})
        total_food = await db.items.count_documents({"item_type": "essen"})
        total_drinks = await db.items.count_documents({"item_type": "getränk"})
        total_with_images = await db.items.count_documents(
            {
                "$or": [
                    {"images.0": {"$exists": True}},
                    {"image.data_base64": {"$exists": True}},
                ]
            }
        )

        latest_items = await db.items.find(
            {},
            {"_id": 1, "name": 1, "item_type": 1, "updated_at": 1, "quantity": 1, "unit": 1, "in_stock": 1},
        ).sort("updated_at", -1).limit(10).to_list(length=10)

        low_stock_items = await db.items.find(
            {"quantity": {"$type": "number", "$lte": 1}},
            {"_id": 1, "name": 1, "item_type": 1, "quantity": 1, "unit": 1},
        ).sort("quantity", 1).limit(10).to_list(length=10)

        return {
            "summary": {
                "total_items": total_items,
                "total_food": total_food,
                "total_drinks": total_drinks,
                "total_with_images": total_with_images,
            },
            "latest_items": [
                {
                    "id": str(item["_id"]),
                    "name": item.get("name"),
                    "item_type": item.get("item_type"),
                    "updated_at": item.get("updated_at"),
                    "quantity": item.get("quantity"),
                    "unit": item.get("unit"),
                    "in_stock": item.get("in_stock", True),
                }
                for item in latest_items
            ],
            "alerts": {
                "low_stock": [
                    {
                        "id": str(item["_id"]),
                        "name": item.get("name"),
                        "item_type": item.get("item_type"),
                        "quantity": item.get("quantity"),
                        "unit": item.get("unit"),
                    }
                    for item in low_stock_items
                ]
            },
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Dashboard Fehler: {str(e)}")


@router.get("/activity_feed")
async def get_activity_feed(limit: int = 20):
    db = await get_db()
    rows = await db.items.find(
        {},
        {"_id": 1, "name": 1, "updated_at": 1, "item_type": 1},
    ).sort("updated_at", -1).limit(limit).to_list(length=limit)

    return [
        {
            "target_id": str(row["_id"]),
            "target_name": row.get("name"),
            "timestamp": row.get("updated_at"),
            "action": f"{row.get('item_type', 'item').capitalize()} aktualisiert",
        }
        for row in rows
    ]

import os
from typing import Optional

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from pymongo import ReturnDocument

from helper import calc_hmac


mongo_client: Optional[AsyncIOMotorClient] = None
mongo_db: Optional[AsyncIOMotorDatabase] = None


def normalize_username(username: str) -> str:
    return str(username or "").strip().lower()


def _mongo_uri() -> str:
    return os.getenv("MONGODB_URI", "mongodb://localhost:27017")


def _mongo_db_name() -> str:
    return os.getenv("MONGODB_DB", "restaurant")


async def initialize_connection_pool() -> None:
    global mongo_client, mongo_db

    if mongo_client is not None and mongo_db is not None:
        return

    mongo_client = AsyncIOMotorClient(_mongo_uri())
    mongo_db = mongo_client[_mongo_db_name()]

    # Quick connectivity check
    await mongo_client.admin.command("ping")


async def get_db() -> AsyncIOMotorDatabase:
    global mongo_db
    if mongo_db is None:
        raise RuntimeError("MongoDB is not initialized. Call initialize_connection_pool() first.")
    return mongo_db


async def get_next_sequence(name: str) -> int:
    db = await get_db()
    doc = await db.counters.find_one_and_update(
        {"_id": name},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    return int(doc["seq"])


async def db_init() -> None:
    db = await get_db()

    await db.users.create_index("username", unique=True)
    await db.users.create_index("username_normalized", unique=True, sparse=True)
    await db.users.create_index("token")
    await db.users.create_index("magic_login_token", unique=True, sparse=True)
    await db.items.create_index("name")
    await db.items.create_index("item_type")
    await db.items.create_index(
        [("ean", 1)],
        unique=True,
        partialFilterExpression={"ean": {"$type": "string"}},
    )
    await db.orders.create_index("created_at")
    await db.orders.create_index("user_id")
    await db.voucher_codes.create_index("code_raw", unique=True)
    await db.voucher_codes.create_index("expires_at")
    await db.voucher_codes.create_index("redeemed_by_user_id")
    await db.credit_transactions.create_index("user_id")
    await db.credit_transactions.create_index("created_at")

    admin_user = await db.users.find_one({"username_normalized": normalize_username("admin")})
    if not admin_user:
        admin_password = os.getenv("ADMIN_DEFAULT_PASSWORD", "admin")
        await db.users.insert_one(
            {
                "id": await get_next_sequence("users"),
                "username": "admin",
                "username_normalized": normalize_username("admin"),
                "name": "Administrator",
                "password": calc_hmac(admin_password),
                "token": "",
                "mail": "admin@admin.com",
                "admin": 2,
            }
        )

    default_settings = {
        "receipt_printer_ip": "",
        "label_printer_ip": "",
        "label_printer_width_mm": "",
        "label_printer_height_mm": "",
        "label_printer_dpi": 203,
        "label_printer_zpl_template": "",
        "guest_qr_invite_text": "Lieber [Name], Bitte scanne den QR Code ab um zu unserem Restaurant zu gelangen.",
        "display_timezone": "Europe/Vienna",
        "prices_enabled": False,
        "voucher_codes_enabled": False,
    }
    for key, value in default_settings.items():
        await db.settings.update_one(
            {"key": key},
            {"$setOnInsert": {"key": key, "value": value}},
            upsert=True,
        )


async def db_remove() -> None:
    db = await get_db()
    await db.users.drop()
    await db.items.drop()
    await db.orders.drop()
    await db.settings.drop()
    await db.voucher_codes.drop()
    await db.credit_transactions.drop()
    await db.counters.drop()


async def close_connection_pool() -> None:
    global mongo_client, mongo_db
    if mongo_client is not None:
        mongo_client.close()
    mongo_client = None
    mongo_db = None

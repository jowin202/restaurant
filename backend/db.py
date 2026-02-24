import os
from typing import Any, Optional

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
    """Backwards-compatible name used by the app startup."""
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


async def pg_db_init() -> None:
    """Backwards-compatible name used by app startup.
    Initializes MongoDB collections and default documents.
    """
    db = await get_db()

    await db.users.create_index("username", unique=True)
    await db.users.create_index("username_normalized", unique=True, sparse=True)
    await db.users.create_index("token")
    await db.items.create_index("name")
    await db.items.create_index("item_type")
    desired_ean_partial = {"ean": {"$type": "string"}}
    async for idx in db.items.list_indexes():
        key_doc = idx.get("key") or {}
        if list(key_doc.items()) != [("ean", 1)]:
            continue
        if idx.get("unique") and idx.get("partialFilterExpression") == desired_ean_partial:
            continue
        await db.items.drop_index(idx["name"])

    await db.items.create_index(
        [("ean", 1)],
        unique=True,
        partialFilterExpression=desired_ean_partial,
    )
    await db.orders.create_index("created_at")
    await db.orders.create_index("user_id")

    await db.users.update_many(
        {"username": {"$type": "string"}},
        [
            {
                "$set": {
                    "username_normalized": {"$toLower": {"$trim": {"input": "$username"}}},
                }
            }
        ],
    )

    await db.items.update_many(
        {"in_stock": {"$exists": True}},
        {"$unset": {"in_stock": ""}},
    )

    await db.items.update_many(
        {"$or": [{"quantity": {"$exists": False}}, {"quantity": None}]},
        {"$set": {"quantity": 0}},
    )

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
                "deleted": False,
                "admin": 2,
            }
        )


async def pg_db_remove() -> None:
    db = await get_db()
    await db.users.drop()
    await db.items.drop()
    await db.orders.drop()
    await db.settings.drop()
    await db.counters.drop()


async def close_connection_pool() -> None:
    global mongo_client, mongo_db
    if mongo_client is not None:
        mongo_client.close()
    mongo_client = None
    mongo_db = None


async def get_pg_connection() -> Any:
    raise RuntimeError("PostgreSQL helpers are no longer available. Use MongoDB helpers.")


async def release_pg_connection(connection: Any) -> None:
    _ = connection
    return

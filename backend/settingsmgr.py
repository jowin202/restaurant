from typing import Dict, Union

from db import get_db


class SettingsManager:
    _instance = None
    _initialized = False

    settings: Dict[str, Union[str, int, bool]] = {}

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(SettingsManager, cls).__new__(cls)
        return cls._instance

    async def initialize(self):
        if self._initialized:
            return
        await self._load_settings()
        self._initialized = True

    async def _load_settings(self):
        db = await get_db()
        rows = await db.settings.find({}, {"_id": 0, "key": 1, "value": 1}).to_list(length=None)
        self.settings = {row["key"]: row.get("value") for row in rows}

    def get_setting(self, key):
        return self.settings.get(key)

    async def set_setting(self, key: str, value: Union[str, int, bool]):
        db = await get_db()
        await db.settings.update_one({"key": key}, {"$set": {"value": value}}, upsert=True)
        await self._load_settings()

    async def set_setting_if_not_exists(self, key: str, value: Union[str, int, bool]):
        db = await get_db()
        existing = await db.settings.find_one({"key": key}, {"_id": 1})
        if not existing:
            await db.settings.insert_one({"key": key, "value": value})
        await self._load_settings()

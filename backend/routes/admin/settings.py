from typing import Any, Dict, List

from fastapi import APIRouter

from settingsmgr import SettingsManager

router = APIRouter()

manager = SettingsManager()


@router.post("/set_settings/")
async def set_settings(settings: Dict[str, Any]):
    for key, value in settings.items():
        if isinstance(value, (str, int, bool)):
            await manager.set_setting(key, value)
        else:
            return {"error": f"Unsupported value type for key '{key}': {type(value).__name__}"}
    return {"status": "success"}


@router.post("/get_settings/")
async def get_settings(keys: List[str]):
    result = {}
    for key in keys:
        result[key] = manager.get_setting(key)
    return result

import re
from typing import Any, Dict, List, Optional

from bson import ObjectId
from fastapi import HTTPException
from pydantic import BaseModel


EAN_RE = re.compile(r"^\d{8,14}$")


def normalize_attributes(attributes: Dict[str, Any]) -> Dict[str, Any]:
    normalized: Dict[str, Any] = {}
    for key, value in attributes.items():
        clean_key = str(key).strip()
        if not clean_key:
            continue
        normalized[clean_key] = value
    return normalized


def normalize_order_attributes(order_attributes: List[Any]) -> List[Dict[str, Any]]:
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


def normalize_ean(ean: Optional[str]) -> Optional[str]:
    if ean is None:
        return None

    digits_only = "".join(ch for ch in str(ean) if ch.isdigit())
    if not digits_only:
        return None

    if not EAN_RE.match(digits_only):
        raise HTTPException(status_code=400, detail="Ungültiger EAN (erlaubt: 8 bis 14 Ziffern)")

    return digits_only


def parse_item_id(item_id: str) -> ObjectId:
    if not ObjectId.is_valid(item_id):
        raise HTTPException(status_code=400, detail="Ungültige Item-ID")
    return ObjectId(item_id)


def is_numeric(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)

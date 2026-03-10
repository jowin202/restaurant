import secrets
from datetime import datetime, timezone
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from db import get_db
from settingsmgr import SettingsManager

router = APIRouter()
settings_manager = SettingsManager()

CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
CODE_LENGTH = 25


class GenerateVoucherCodesRequest(BaseModel):
    amount_eur: float = Field(gt=0, le=10000)
    expires_at: datetime
    count: int = Field(default=1, ge=1, le=100)


class RedeemVoucherCodeRequest(BaseModel):
    code: str = Field(min_length=5, max_length=128)


def _setting_enabled(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on", "ja"}
    return False


def _to_cents(amount_eur: float) -> int:
    return max(0, int(round(float(amount_eur) * 100)))


def _from_cents(value: int) -> float:
    return round(max(0, int(value)) / 100.0, 2)


def _format_code(raw: str) -> str:
    safe_raw = (raw or "").upper()
    return "-".join([safe_raw[i:i + 5] for i in range(0, len(safe_raw), 5)])


def _normalize_code(value: str) -> str:
    return "".join([ch for ch in (value or "").upper() if ch.isalnum()])


def _generate_code_raw() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def _to_utc_aware(value: Any) -> Any:
    if not isinstance(value, datetime):
        return value
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _serialize_admin_voucher(doc: Dict[str, Any], now: datetime) -> Dict[str, Any]:
    expires_at = _to_utc_aware(doc.get("expires_at"))
    redeemed_at = _to_utc_aware(doc.get("redeemed_at"))
    created_at = _to_utc_aware(doc.get("created_at"))

    if redeemed_at:
        status = "redeemed"
    elif isinstance(expires_at, datetime) and expires_at < now:
        status = "expired"
    else:
        status = "active"

    return {
        "id": str(doc.get("_id")),
        "code": _format_code(str(doc.get("code_raw") or "")),
        "amount_eur": _from_cents(int(doc.get("amount_cents") or 0)),
        "expires_at": expires_at.isoformat() if isinstance(expires_at, datetime) else None,
        "created_at": created_at.isoformat() if isinstance(created_at, datetime) else None,
        "created_by_name": doc.get("created_by_name"),
        "redeemed_at": redeemed_at.isoformat() if isinstance(redeemed_at, datetime) else None,
        "redeemed_by_name": doc.get("redeemed_by_name"),
        "status": status,
    }


def _normalize_datetime_input(value: Any) -> Any:
    if not isinstance(value, datetime):
        return value
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


@router.get("/")
async def list_voucher_codes(request: Request, limit: int = Query(default=120, ge=1, le=500)):
    if getattr(request.state, "admin", 0) <= 0:
        raise HTTPException(status_code=403, detail="Nur Admins dürfen Gutschein-Codes sehen")

    db = await get_db()
    now = datetime.now(timezone.utc)

    docs = await db.voucher_codes.find(
        {},
        {
            "code_raw": 1,
            "amount_cents": 1,
            "expires_at": 1,
            "created_at": 1,
            "created_by_name": 1,
            "redeemed_at": 1,
            "redeemed_by_name": 1,
        },
    ).sort("created_at", -1).limit(limit).to_list(length=limit)
    docs = [
        {
            **doc,
            "expires_at": _normalize_datetime_input(doc.get("expires_at")),
            "created_at": _normalize_datetime_input(doc.get("created_at")),
            "redeemed_at": _normalize_datetime_input(doc.get("redeemed_at")),
        }
        for doc in docs
    ]

    return {
        "status": "success",
        "vouchers_enabled": _setting_enabled(settings_manager.get_setting("voucher_codes_enabled")),
        "items": [_serialize_admin_voucher(doc, now) for doc in docs],
    }


@router.post("/generate/")
async def generate_voucher_codes(data: GenerateVoucherCodesRequest, request: Request):
    if getattr(request.state, "admin", 0) <= 0:
        raise HTTPException(status_code=403, detail="Nur Admins dürfen Gutschein-Codes erstellen")

    if not _setting_enabled(settings_manager.get_setting("voucher_codes_enabled")):
        raise HTTPException(status_code=400, detail="Gutschein-Codes sind in den Einstellungen deaktiviert")

    expires_at = data.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    else:
        expires_at = expires_at.astimezone(timezone.utc)

    now = datetime.now(timezone.utc)
    if expires_at <= now:
        raise HTTPException(status_code=400, detail="Ablaufdatum muss in der Zukunft liegen")

    amount_cents = _to_cents(data.amount_eur)
    if amount_cents <= 0:
        raise HTTPException(status_code=400, detail="Gutscheinwert ist ungültig")

    db = await get_db()
    created: List[Dict[str, Any]] = []

    for _ in range(data.count):
        created_doc: Dict[str, Any] | None = None
        for _attempt in range(50):
            code_raw = _generate_code_raw()
            candidate = {
                "code_raw": code_raw,
                "amount_cents": amount_cents,
                "expires_at": expires_at,
                "created_at": now,
                "created_by_user_id": request.state.user_id,
                "created_by_name": request.state.name,
                "redeemed_at": None,
                "redeemed_by_user_id": None,
                "redeemed_by_name": None,
            }
            try:
                result = await db.voucher_codes.insert_one(candidate)
                created_doc = {**candidate, "_id": result.inserted_id}
                break
            except DuplicateKeyError:
                continue

        if not created_doc:
            raise HTTPException(status_code=500, detail="Konnte keinen eindeutigen Gutschein-Code generieren")

        created.append(created_doc)

    return {
        "status": "success",
        "created_count": len(created),
        "items": [_serialize_admin_voucher(doc, now) for doc in created],
    }


@router.post("/redeem/")
async def redeem_voucher_code(data: RedeemVoucherCodeRequest, request: Request):
    if not _setting_enabled(settings_manager.get_setting("voucher_codes_enabled")):
        raise HTTPException(status_code=403, detail="Gutschein-Codes sind deaktiviert")

    normalized_code = _normalize_code(data.code)
    if len(normalized_code) != CODE_LENGTH:
        raise HTTPException(status_code=400, detail="Code muss 25 Zeichen enthalten (A-Z, 0-9)")

    now = datetime.now(timezone.utc)
    db = await get_db()

    redeemed = await db.voucher_codes.find_one_and_update(
        {
            "code_raw": normalized_code,
            "redeemed_at": None,
            "expires_at": {"$gte": now},
        },
        {
            "$set": {
                "redeemed_at": now,
                "redeemed_by_user_id": request.state.user_id,
                "redeemed_by_name": request.state.name,
            }
        },
        return_document=ReturnDocument.AFTER,
    )

    if not redeemed:
        existing = await db.voucher_codes.find_one({"code_raw": normalized_code}, {"redeemed_at": 1, "expires_at": 1})
        if not existing:
            raise HTTPException(status_code=404, detail="Gutschein-Code nicht gefunden")

        if existing.get("redeemed_at"):
            raise HTTPException(status_code=409, detail="Gutschein-Code wurde bereits eingelöst")

        raise HTTPException(status_code=409, detail="Gutschein-Code ist abgelaufen")

    amount_cents = max(0, int(redeemed.get("amount_cents") or 0))
    if amount_cents <= 0:
        raise HTTPException(status_code=409, detail="Gutschein-Code hat keinen gültigen Wert")

    updated_user = await db.users.find_one_and_update(
        {"id": request.state.user_id},
        {"$inc": {"credit_balance_cents": amount_cents}},
        return_document=ReturnDocument.AFTER,
        projection={"_id": 0, "credit_balance_cents": 1},
    )
    if not updated_user:
        raise HTTPException(status_code=404, detail="Benutzer nicht gefunden")

    await db.credit_transactions.insert_one(
        {
            "user_id": request.state.user_id,
            "type": "voucher_redeemed",
            "amount_cents": amount_cents,
            "created_at": now,
            "meta": {
                "code": _format_code(normalized_code),
            },
        }
    )

    balance_cents = max(0, int(updated_user.get("credit_balance_cents") or 0))
    return {
        "status": "success",
        "message": "Gutschein wurde eingelöst.",
        "code": _format_code(normalized_code),
        "added_credit_eur": _from_cents(amount_cents),
        "balance_eur": _from_cents(balance_cents),
    }


@router.get("/me/balance/")
async def get_my_credit_balance(request: Request):
    vouchers_enabled = _setting_enabled(settings_manager.get_setting("voucher_codes_enabled"))
    db = await get_db()

    user_doc = await db.users.find_one(
        {"id": request.state.user_id},
        {"_id": 0, "credit_balance_cents": 1},
    )
    balance_cents = max(0, int((user_doc or {}).get("credit_balance_cents") or 0))

    return {
        "status": "success",
        "vouchers_enabled": vouchers_enabled,
        "balance_eur": _from_cents(balance_cents),
    }

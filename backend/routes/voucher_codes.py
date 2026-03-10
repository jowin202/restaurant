import secrets
from io import BytesIO
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas

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


def _voucher_query_for_status(status: Literal["active", "redeemed", "expired", "all"], now: datetime) -> Dict[str, Any]:
    if status == "all":
        return {}
    if status == "redeemed":
        return {"redeemed_at": {"$ne": None}}
    if status == "expired":
        return {"redeemed_at": None, "expires_at": {"$lt": now}}
    return {"redeemed_at": None, "expires_at": {"$gte": now}}


async def _load_voucher_docs(
    db: Any,
    status: Literal["active", "redeemed", "expired", "all"],
    limit: int,
    now: datetime,
) -> List[Dict[str, Any]]:
    docs = await db.voucher_codes.find(
        _voucher_query_for_status(status, now),
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

    return [
        {
            **doc,
            "expires_at": _to_utc_aware(doc.get("expires_at")),
            "created_at": _to_utc_aware(doc.get("created_at")),
            "redeemed_at": _to_utc_aware(doc.get("redeemed_at")),
        }
        for doc in docs
    ]


def _format_pdf_valid_until(value: Any) -> str:
    if not isinstance(value, datetime):
        return "-"
    return _to_utc_aware(value).strftime("%d.%m.%Y %H:%M UTC")


def _build_voucher_pdf_bytes(items: List[Dict[str, Any]]) -> bytes:
    page_width, page_height = A4
    margin_x = 12 * mm
    margin_y = 12 * mm
    gap_x = 8 * mm
    gap_y = 8 * mm
    cards_per_row = 2
    rows_per_page = 4
    cards_per_page = cards_per_row * rows_per_page

    card_width = (page_width - (2 * margin_x) - gap_x) / cards_per_row
    card_height = (page_height - (2 * margin_y) - (gap_y * (rows_per_page - 1))) / rows_per_page

    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)

    def fit_font_size(text: str, font_name: str, start_size: float, min_size: float, max_width: float) -> float:
        size = start_size
        while size > min_size and pdfmetrics.stringWidth(text, font_name, size) > max_width:
            size -= 0.5
        return max(min_size, size)

    for index, item in enumerate(items):
        slot = index % cards_per_page
        if index > 0 and slot == 0:
            pdf.showPage()

        row = slot // cards_per_row
        col = slot % cards_per_row

        x = margin_x + col * (card_width + gap_x)
        y = page_height - margin_y - ((row + 1) * card_height) - (row * gap_y)

        pdf.roundRect(x, y, card_width, card_height, 6, stroke=1, fill=0)

        inner_x = x + 6 * mm
        top_y = y + card_height - 7 * mm

        code = _format_code(str(item.get("code_raw") or ""))
        if not code.strip("-"):
            code = "-"
        amount_eur = _from_cents(int(item.get("amount_cents") or 0))
        valid_until = _format_pdf_valid_until(item.get("expires_at"))

        pdf.setFont("Helvetica-Bold", 11)
        pdf.drawString(inner_x, top_y, "Gutschein-Code")

        code_font_name = "Courier-Bold"
        code_max_width = card_width - (12 * mm)
        code_font_size = fit_font_size(
            text=code,
            font_name=code_font_name,
            start_size=16,
            min_size=8,
            max_width=code_max_width,
        )
        pdf.setFont(code_font_name, code_font_size)
        pdf.drawCentredString(x + (card_width / 2), top_y - (8 * mm), code)

        pdf.setFont("Helvetica", 12)
        pdf.drawString(inner_x, top_y - (16 * mm), f"Betrag: {amount_eur:.2f} EUR")
        pdf.drawString(inner_x, top_y - (22 * mm), f"Gueltig bis: {valid_until}")

    pdf.save()
    return buffer.getvalue()


@router.get("/")
async def list_voucher_codes(
    request: Request,
    status: Literal["active", "redeemed", "expired", "all"] = Query(default="active"),
    limit: int = Query(default=120, ge=1, le=500),
):
    if getattr(request.state, "admin", 0) <= 0:
        raise HTTPException(status_code=403, detail="Nur Admins dürfen Gutschein-Codes sehen")

    db = await get_db()
    now = datetime.now(timezone.utc)

    docs = await _load_voucher_docs(db=db, status=status, limit=limit, now=now)

    return {
        "status": "success",
        "filter": status,
        "vouchers_enabled": _setting_enabled(settings_manager.get_setting("voucher_codes_enabled")),
        "items": [_serialize_admin_voucher(doc, now) for doc in docs],
    }


@router.get("/export/pdf/")
async def export_voucher_codes_pdf_default(
    request: Request,
    status: Literal["active", "redeemed", "expired", "all"] = Query(default="active"),
    limit: int = Query(default=1000, ge=1, le=5000),
):
    return await _export_voucher_codes_pdf_impl(request=request, status=status, limit=limit)


@router.get("/export/pdf/{status}/")
async def export_voucher_codes_pdf_by_path(
    request: Request,
    status: Literal["active", "redeemed", "expired", "all"],
    limit: int = Query(default=1000, ge=1, le=5000),
):
    return await _export_voucher_codes_pdf_impl(request=request, status=status, limit=limit)


async def _export_voucher_codes_pdf_impl(
    request: Request,
    status: Literal["active", "redeemed", "expired", "all"],
    limit: int,
):
    if getattr(request.state, "admin", 0) <= 0:
        raise HTTPException(status_code=403, detail="Nur Admins dürfen Gutschein-Codes exportieren")

    db = await get_db()
    now = datetime.now(timezone.utc)
    docs = await _load_voucher_docs(db=db, status=status, limit=limit, now=now)
    if not docs:
        raise HTTPException(status_code=404, detail="Keine Gutschein-Codes für den gewählten Filter gefunden")

    pdf_bytes = _build_voucher_pdf_bytes(docs)
    timestamp = now.strftime("%Y%m%d-%H%M%S")
    filename = f"gutschein-codes-{status}-{timestamp}.pdf"

    return StreamingResponse(
        BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


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

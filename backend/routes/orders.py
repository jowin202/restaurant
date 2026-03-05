import asyncio
import socket
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from db import get_db
from settingsmgr import SettingsManager

router = APIRouter()
settings_manager = SettingsManager()

RECEIPT_LINE_WIDTH = 42
RECEIPT_PORT = 9100
RECEIPT_TIMEOUT_SECONDS = 2.5


class OrderItem(BaseModel):
    item_id: str
    quantity: float = Field(default=1, gt=0)
    order_answers: Dict[str, Any] = Field(default_factory=dict)


class CheckoutOrder(BaseModel):
    items: List[OrderItem]
    comment: Optional[str] = None


def _format_quantity(value: Any) -> str:
    if not _is_numeric(value):
        return str(value or "")
    return f"{float(value):g}"


def _stringify_print_value(value: Any) -> str:
    if isinstance(value, bool):
        return "Ja" if value else "Nein"
    if value is None:
        return "-"
    if isinstance(value, (dict, list)):
        return str(value)
    return str(value)


def _wrap_receipt_text(text: str, width: int = RECEIPT_LINE_WIDTH) -> List[str]:
    words = str(text or "").split()
    if not words:
        return [""]

    lines: List[str] = []
    current = words[0]
    for word in words[1:]:
        test = f"{current} {word}"
        if len(test) <= width:
            current = test
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def _build_escpos_order_payload(order_document: Dict[str, Any], order_id: str, mode: str) -> bytes:
    created_at = order_document.get("created_at")
    if isinstance(created_at, datetime):
        created_text = created_at.astimezone().strftime("%d.%m.%Y %H:%M")
    else:
        created_text = datetime.now().astimezone().strftime("%d.%m.%Y %H:%M")

    user_name = str(order_document.get("user_name") or "Unbekannt")
    comment = str(order_document.get("comment") or "").strip()
    items = order_document.get("items")
    safe_items = items if isinstance(items, list) else []

    body_lines: List[str] = []
    body_lines.append(f"Bestellung #{order_id[-8:]}")
    body_lines.append(f"Zeit: {created_text}")
    body_lines.append(f"Von: {user_name}")
    body_lines.append("-" * RECEIPT_LINE_WIDTH)

    for idx, line in enumerate(safe_items, start=1):
        if not isinstance(line, dict):
            continue
        name = str(line.get("name") or "Artikel")
        qty = _format_quantity(line.get("ordered_quantity"))
        unit = str(line.get("unit") or "").strip()

        for name_line in _wrap_receipt_text(f"{idx}. {name}"):
            body_lines.append(name_line)
        qty_line = f"   Menge: {qty} {unit}".strip()
        body_lines.append(qty_line)

        raw_answers = line.get("order_answers")
        answers = raw_answers if isinstance(raw_answers, dict) else {}
        for key in sorted(answers.keys()):
            label = str(key)
            value = _stringify_print_value(answers.get(key))
            for answer_line in _wrap_receipt_text(f"   - {label}: {value}"):
                body_lines.append(answer_line)
        body_lines.append("")

    if comment:
        body_lines.append("Kommentar:")
        for c_line in _wrap_receipt_text(comment):
            body_lines.append(c_line)
        body_lines.append("")

    body_lines.append("-" * RECEIPT_LINE_WIDTH)

    body_text = "\n".join(body_lines).strip() + "\n"
    encoded_body = body_text.encode("cp1252", errors="replace")

    return b"".join(
        [
            b"\x1b\x40",       # init
            b"\x1b\x61\x01",   # center
            b"\x1b\x45\x01",   # bold on
            "Bestellung\n".encode("cp1252", errors="replace"),
            b"\x1b\x45\x00",   # bold off
            b"\x1b\x61\x00",   # left
            encoded_body,
            b"\n\n\n",
            b"\x1d\x56\x41\x00",  # cut
        ]
    )


def _send_escpos_raw(ip_address: str, payload: bytes, timeout_seconds: float = RECEIPT_TIMEOUT_SECONDS) -> None:
    with socket.create_connection((ip_address, RECEIPT_PORT), timeout=timeout_seconds) as sock:
        sock.sendall(payload)


async def _try_print_escpos(ip_address: str, payload: bytes) -> Optional[str]:
    try:
        await asyncio.to_thread(_send_escpos_raw, ip_address, payload)
        return None
    except Exception as exc:
        return str(exc)


def _get_receipt_printer_ip() -> str:
    return str(settings_manager.get_setting("receipt_printer_ip") or "").strip()


def _print_status_message(status: str, mode: str) -> str:
    if status == "printed":
        return "Bestellung wurde gedruckt." if mode == "manual" else "Bestellung wurde automatisch gedruckt."
    if status == "printer_not_configured":
        return "Bondrucker ist nicht konfiguriert (receipt_printer_ip)."
    if status == "printer_offline":
        return "Bondruck fehlgeschlagen (Drucker nicht erreichbar)."
    return "Druckstatus unbekannt."


async def _attempt_order_print(
    db: Any,
    order_oid: ObjectId,
    order_id: str,
    order_document: Dict[str, Any],
    mode: str,
) -> Dict[str, Any]:
    printer_ip = _get_receipt_printer_ip()
    now = datetime.now(timezone.utc)

    status = "printer_not_configured"
    error = ""
    if printer_ip:
        payload = _build_escpos_order_payload(order_document, order_id=order_id, mode=mode)
        print_error = await _try_print_escpos(printer_ip, payload)
        if print_error:
            status = "printer_offline"
            error = print_error
        else:
            status = "printed"

    event = {
        "at": now,
        "mode": mode,
        "status": status,
        "printer_ip": printer_ip or None,
        "error": error or None,
    }
    await db.orders.update_one(
        {"_id": order_oid},
        {
            "$set": {
                "print_status": status,
                "print_error": error or None,
                "print_last_mode": mode,
                "print_last_attempt_at": now,
            },
            "$push": {"print_events": event},
        },
    )

    return {
        "status": status,
        "mode": mode,
        "printer_ip": printer_ip or None,
        "error": error or None,
        "message": _print_status_message(status, mode),
    }


async def trigger_order_backend(order_document: Dict[str, Any]) -> Dict[str, Any]:
    """Platzhalter für spätere Integration (Mail, ERP, Payment, etc.)."""
    _ = order_document
    return {
        "triggered": True,
        "integration": "not_implemented",
        "message": "Order-Trigger aufgerufen, konkrete Integration folgt.",
    }


def _is_numeric(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _normalize_order_attributes(order_attributes: Any) -> List[Dict[str, Any]]:
    if not isinstance(order_attributes, list):
        return []

    normalized: List[Dict[str, Any]] = []
    seen_keys: set[str] = set()

    for row in order_attributes:
        if not isinstance(row, dict):
            continue

        key = str(row.get("key", "")).strip()
        if not key:
            continue

        lowered = key.lower()
        if lowered in seen_keys:
            continue

        input_type = str(row.get("input_type", "string")).strip().lower()
        if input_type not in {"string", "select", "boolean"}:
            input_type = "string"

        label = str(row.get("label", "")).strip() or key
        required = bool(row.get("required", False))

        options: List[str] = []
        raw_options = row.get("options") or []
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
                "key": key,
                "label": label,
                "input_type": input_type,
                "required": required,
                "options": options if input_type == "select" else [],
            }
        )
        seen_keys.add(lowered)

    return normalized


def _validate_order_answers(
    item_name: str,
    order_attributes: List[Dict[str, Any]],
    raw_answers: Dict[str, Any],
) -> Dict[str, Any]:
    if not isinstance(raw_answers, dict):
        raise HTTPException(status_code=400, detail=f"Ungültige Antwortdaten für '{item_name}'.")

    allowed_keys = {row["key"] for row in order_attributes}
    unknown_keys = [key for key in raw_answers.keys() if key not in allowed_keys]
    if unknown_keys:
        raise HTTPException(
            status_code=400,
            detail=f"Unbekannte Antwort-Felder für '{item_name}': {', '.join(unknown_keys)}",
        )

    answers: Dict[str, Any] = {}

    for row in order_attributes:
        key = row["key"]
        label = row["label"]
        input_type = row["input_type"]
        required = row["required"]
        options = row["options"]

        has_value = key in raw_answers
        value = raw_answers.get(key)

        if input_type == "boolean":
            if not has_value:
                if required:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Bitte '{label}' für '{item_name}' beantworten.",
                    )
                continue

            if not isinstance(value, bool):
                raise HTTPException(
                    status_code=400,
                    detail=f"'{label}' für '{item_name}' muss eine Checkbox-Antwort (true/false) sein.",
                )
            answers[key] = value
            continue

        if not has_value:
            if required:
                raise HTTPException(
                    status_code=400,
                    detail=f"Bitte '{label}' für '{item_name}' beantworten.",
                )
            continue

        if not isinstance(value, str):
            raise HTTPException(
                status_code=400,
                detail=f"'{label}' für '{item_name}' muss als Text übergeben werden.",
            )

        text_value = value.strip()
        if required and not text_value:
            raise HTTPException(
                status_code=400,
                detail=f"Bitte '{label}' für '{item_name}' ausfüllen.",
            )

        if not text_value:
            continue

        if input_type == "select" and text_value not in options:
            raise HTTPException(
                status_code=400,
                detail=f"Ungültige Auswahl für '{label}' bei '{item_name}'.",
            )

        answers[key] = text_value

    return answers


@router.post('/checkout/')
async def checkout(data: CheckoutOrder, request: Request):
    if getattr(request.state, 'admin', 0) != 0:
        raise HTTPException(status_code=403, detail='Nur Nutzer dürfen über den Shop bestellen')

    if not data.items:
        raise HTTPException(status_code=400, detail='Der Warenkorb ist leer')

    db = await get_db()

    object_ids: List[ObjectId] = []
    requested_quantity_by_item: Dict[str, float] = {}
    incoming_lines: List[Dict[str, Any]] = []

    for item in data.items:
        if not ObjectId.is_valid(item.item_id):
            raise HTTPException(status_code=400, detail=f'Ungültige Item-ID: {item.item_id}')
        oid = ObjectId(item.item_id)
        oid_str = str(oid)

        if oid_str not in requested_quantity_by_item:
            object_ids.append(oid)
            requested_quantity_by_item[oid_str] = 0.0

        requested_quantity_by_item[oid_str] = round(requested_quantity_by_item[oid_str] + item.quantity, 3)
        incoming_lines.append(
            {
                'item_id': oid_str,
                'quantity': item.quantity,
                'order_answers': dict(item.order_answers),
            }
        )

    db_items = await db.items.find(
        {'_id': {'$in': object_ids}},
        {'name': 1, 'item_type': 1, 'ean': 1, 'unit': 1, 'quantity': 1, 'order_attributes': 1},
    ).to_list(length=len(object_ids))

    if len(db_items) != len(object_ids):
        raise HTTPException(status_code=404, detail='Mindestens ein Item wurde nicht gefunden')

    item_meta_by_id: Dict[str, Dict[str, Any]] = {}
    stock_updates: List[Dict[str, Any]] = []

    for doc in db_items:
        doc_id = str(doc['_id'])
        ordered_quantity = requested_quantity_by_item[doc_id]

        available_quantity = doc.get('quantity')
        if not _is_numeric(available_quantity):
            raise HTTPException(
                status_code=409,
                detail=f"'{doc.get('name')}' hat keinen gültigen Lagerbestand.",
            )

        if float(available_quantity) <= 0:
            raise HTTPException(
                status_code=409,
                detail=f"'{doc.get('name')}' ist aktuell nicht verfügbar.",
            )

        remaining = round(float(available_quantity) - ordered_quantity, 3)
        if remaining < 0:
            raise HTTPException(
                status_code=409,
                detail=f"Nicht genug Bestand für '{doc.get('name')}'. Verfügbar: {available_quantity}",
            )

        stock_updates.append(
            {
                '_id': doc['_id'],
                'new_quantity': remaining,
            }
        )

        item_meta_by_id[doc_id] = {
            'ean': doc.get('ean'),
            'name': doc.get('name'),
            'item_type': doc.get('item_type'),
            'unit': doc.get('unit'),
            'available_quantity_before': available_quantity,
            'order_attributes': _normalize_order_attributes(doc.get('order_attributes')),
        }

    order_lines: List[Dict[str, Any]] = []
    for line in incoming_lines:
        line_item_id = line['item_id']
        line_meta = item_meta_by_id[line_item_id]
        validated_answers = _validate_order_answers(
            item_name=str(line_meta.get('name', 'Item')),
            order_attributes=line_meta['order_attributes'],
            raw_answers=line.get('order_answers', {}),
        )

        order_lines.append(
            {
                'item_id': line_item_id,
                'ean': line_meta.get('ean'),
                'name': line_meta.get('name'),
                'item_type': line_meta.get('item_type'),
                'ordered_quantity': line['quantity'],
                'unit': line_meta.get('unit'),
                'available_quantity_before': line_meta.get('available_quantity_before'),
                'order_attributes': line_meta['order_attributes'],
                'order_answers': validated_answers,
            }
        )

    now = datetime.now(timezone.utc)

    for update in stock_updates:
        await db.items.update_one(
            {'_id': update['_id']},
            {'$set': {'quantity': update['new_quantity'], 'updated_at': now}},
        )

    order_document = {
        'user_id': request.state.user_id,
        'user_name': request.state.name,
        'items': order_lines,
        'comment': data.comment,
        'status': 'pending_integration',
        'print_status': 'pending',
        'created_at': now,
    }

    insert_result = await db.orders.insert_one(order_document)
    trigger_result = await trigger_order_backend(order_document)
    order_oid = insert_result.inserted_id
    order_id = str(order_oid)
    print_result = await _attempt_order_print(
        db=db,
        order_oid=order_oid,
        order_id=order_id,
        order_document=order_document,
        mode='auto',
    )

    return {
        'status': 'accepted',
        'order_id': order_id,
        'trigger': trigger_result,
        'print': print_result,
        'stock_updated_items': len(stock_updates),
    }


def _serialize_order_line(line: Dict[str, Any]) -> Dict[str, Any]:
    return {
        'name': line.get('name'),
        'ordered_quantity': line.get('ordered_quantity'),
        'unit': line.get('unit'),
        'order_answers': line.get('order_answers', {}),
    }


def _serialize_order_for_admin(doc: Dict[str, Any]) -> Dict[str, Any]:
    raw_items = doc.get('items')
    items = raw_items if isinstance(raw_items, list) else []

    total_quantity = 0.0
    for line in items:
        quantity = line.get('ordered_quantity') if isinstance(line, dict) else None
        if _is_numeric(quantity):
            total_quantity += float(quantity)

    created_at = doc.get('created_at')
    created_at_iso = created_at.isoformat() if isinstance(created_at, datetime) else str(created_at or '')

    return {
        'id': str(doc['_id']),
        'user_id': doc.get('user_id'),
        'user_name': doc.get('user_name'),
        'status': str(doc.get('status') or 'pending_integration'),
        'print_status': str(doc.get('print_status') or ''),
        'print_error': str(doc.get('print_error') or ''),
        'comment': str(doc.get('comment') or ''),
        'created_at': created_at_iso,
        'item_count': len(items),
        'total_quantity': round(total_quantity, 3),
        'items': [_serialize_order_line(line) for line in items if isinstance(line, dict)],
    }


@router.get('/')
async def list_orders(request: Request, limit: int = Query(default=40, ge=1, le=200)):
    if getattr(request.state, 'admin', 0) <= 0:
        raise HTTPException(status_code=403, detail='Nur Admins dürfen Bestellungen einsehen')

    db = await get_db()
    docs = await db.orders.find(
        {},
        {
            'user_id': 1,
            'user_name': 1,
            'status': 1,
            'print_status': 1,
            'print_error': 1,
            'comment': 1,
            'created_at': 1,
            'items': 1,
        },
    ).sort('created_at', -1).limit(limit).to_list(length=limit)

    return [_serialize_order_for_admin(doc) for doc in docs]


@router.post('/{order_id}/manage/')
async def manage_order(order_id: str, request: Request):
    if getattr(request.state, 'admin', 0) <= 0:
        raise HTTPException(status_code=403, detail='Nur Admins dürfen Bestellungen verwalten')

    if not ObjectId.is_valid(order_id):
        raise HTTPException(status_code=400, detail='Ungültige Bestell-ID')

    db = await get_db()
    order = await db.orders.find_one({'_id': ObjectId(order_id)}, {'_id': 1})
    if not order:
        raise HTTPException(status_code=404, detail='Bestellung nicht gefunden')

    return {
        'status': 'not_implemented',
        'order_id': order_id,
        'action': 'manage',
        'message': 'Verwaltungsfunktion vorbereitet (noch nicht implementiert).',
    }


@router.post('/{order_id}/prepare-print/')
async def prepare_print(order_id: str, request: Request):
    if getattr(request.state, 'admin', 0) <= 0:
        raise HTTPException(status_code=403, detail='Nur Admins dürfen Bestellungen drucken')

    if not ObjectId.is_valid(order_id):
        raise HTTPException(status_code=400, detail='Ungültige Bestell-ID')

    db = await get_db()
    order_oid = ObjectId(order_id)
    order = await db.orders.find_one(
        {'_id': order_oid},
        {'_id': 1, 'user_name': 1, 'comment': 1, 'created_at': 1, 'items': 1},
    )
    if not order:
        raise HTTPException(status_code=404, detail='Bestellung nicht gefunden')

    print_result = await _attempt_order_print(
        db=db,
        order_oid=order_oid,
        order_id=order_id,
        order_document=order,
        mode='manual',
    )

    return {
        'status': print_result['status'],
        'order_id': order_id,
        'action': 'prepare_print',
        'print': print_result,
        'message': print_result['message'],
    }

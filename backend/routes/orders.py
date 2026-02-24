from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from db import get_db

router = APIRouter()


class OrderItem(BaseModel):
    item_id: str
    quantity: float = Field(default=1, gt=0)
    order_answers: Dict[str, Any] = Field(default_factory=dict)


class CheckoutOrder(BaseModel):
    items: List[OrderItem]
    comment: Optional[str] = None


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
    quantity_map: Dict[str, float] = {}
    answer_map: Dict[str, Dict[str, Any]] = {}

    for item in data.items:
        if not ObjectId.is_valid(item.item_id):
            raise HTTPException(status_code=400, detail=f'Ungültige Item-ID: {item.item_id}')
        oid = ObjectId(item.item_id)
        oid_str = str(oid)

        if oid_str not in quantity_map:
            object_ids.append(oid)
            quantity_map[oid_str] = item.quantity
            answer_map[oid_str] = dict(item.order_answers)
            continue

        quantity_map[oid_str] = round(quantity_map[oid_str] + item.quantity, 3)

        existing_answers = answer_map[oid_str]
        incoming_answers = dict(item.order_answers)
        if incoming_answers and incoming_answers != existing_answers:
            raise HTTPException(
                status_code=400,
                detail='Gleiches Item mehrfach mit unterschiedlichen Attribut-Antworten übergeben.',
            )

    db_items = await db.items.find(
        {'_id': {'$in': object_ids}},
        {'name': 1, 'item_type': 1, 'ean': 1, 'unit': 1, 'quantity': 1, 'order_attributes': 1},
    ).to_list(length=len(object_ids))

    if len(db_items) != len(object_ids):
        raise HTTPException(status_code=404, detail='Mindestens ein Item wurde nicht gefunden')

    order_lines: List[Dict[str, Any]] = []
    stock_updates: List[Dict[str, Any]] = []

    for doc in db_items:
        doc_id = str(doc['_id'])
        ordered_quantity = quantity_map[doc_id]
        item_order_attributes = _normalize_order_attributes(doc.get('order_attributes'))
        validated_answers = _validate_order_answers(
            item_name=str(doc.get('name', 'Item')),
            order_attributes=item_order_attributes,
            raw_answers=answer_map.get(doc_id, {}),
        )

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

        order_lines.append(
            {
                'item_id': doc_id,
                'ean': doc.get('ean'),
                'name': doc.get('name'),
                'item_type': doc.get('item_type'),
                'ordered_quantity': ordered_quantity,
                'unit': doc.get('unit'),
                'available_quantity_before': available_quantity,
                'order_attributes': item_order_attributes,
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
        'created_at': now,
    }

    insert_result = await db.orders.insert_one(order_document)
    trigger_result = await trigger_order_backend(order_document)

    return {
        'status': 'accepted',
        'order_id': str(insert_result.inserted_id),
        'trigger': trigger_result,
        'stock_updated_items': len(stock_updates),
    }

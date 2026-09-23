import asyncio
import math

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Query

from db import get_db
from settingsmgr import SettingsManager

router = APIRouter()

_LABEL_PORT = 9100
_LABEL_TIMEOUT = 3.0


def _mm_to_dots(mm: float, dpi: int) -> int:
    return max(1, math.ceil(mm * dpi / 25.4))


def _build_default_zpl(name: str, ean: str, price: str, width_mm: float, height_mm: float, dpi: int, count: int) -> str:
    w = _mm_to_dots(width_mm, dpi)
    h = _mm_to_dots(height_mm, dpi)

    # Name, QR and price are stacked and spread across the label's *full* height
    # (top margin to bottom margin) instead of being clustered in the top half.
    # Text is kept compact so the QR - the main scannable element - gets most of
    # the space. Since Link-OS 6.8, ^BQ's magnification factor goes up to 100
    # (older firmware only supports up to 10); if the printer is on older firmware
    # and rejects/clamps values above 10, lower _QR_MAX_MAGNIFICATION below.
    _QR_MAX_MAGNIFICATION = 100
    font_aspect = 0.56  # width:height ratio of Zebra font D, used to keep text looking normal
    margin_mm = min(width_mm, height_mm) * 0.05
    gap_mm = height_mm * 0.03
    name_h_mm = height_mm * 0.12
    price_h_mm = height_mm * 0.09

    name_y_mm = margin_mm
    price_y_mm = height_mm - margin_mm - price_h_mm
    qr_y_mm = name_y_mm + name_h_mm + gap_mm
    qr_available_mm = max(0.0, price_y_mm - gap_mm - qr_y_mm)

    qr_module_target_mm = qr_available_mm / 25  # ~25 modules is typical for a short EAN
    qr_mag = min(_QR_MAX_MAGNIFICATION, max(1, round(qr_module_target_mm * dpi / 25.4)))

    left = _mm_to_dots(margin_mm, dpi)
    name_y = _mm_to_dots(name_y_mm, dpi)
    name_h = _mm_to_dots(name_h_mm, dpi)
    name_w = _mm_to_dots(name_h_mm * font_aspect, dpi)
    qr_y = _mm_to_dots(qr_y_mm, dpi)
    price_h = _mm_to_dots(price_h_mm, dpi)
    price_w = _mm_to_dots(price_h_mm * font_aspect, dpi)
    price_y = _mm_to_dots(price_y_mm, dpi)

    lines = [
        "^XA",
        f"^PW{w}",
        f"^LL{h}",
        f"^FO{left},{name_y}^ADN,{name_h},{name_w}^FD" + name[:40] + "^FS",
    ]

    if ean:
        lines.append(f"^FO{left},{qr_y}^BQN,2,{qr_mag}^FDQA,{ean}^FS")
        if price:
            lines.append(f"^FO{left},{price_y}^ADN,{price_h},{price_w}^FD{price}^FS")
    elif price:
        lines.append(f"^FO{left},{price_y}^ADN,{price_h},{price_w}^FD{price}^FS")

    lines.append(f"^PQ{count}")
    lines.append("^XZ")
    return "\n".join(lines)


def _inject_count(zpl: str, count: int) -> str:
    """Insert ^PQn before ^XZ if not already present in the template."""
    if "^PQ" in zpl:
        return zpl
    return zpl.replace("^XZ", f"^PQ{count}\n^XZ")


def _apply_template(template: str, name: str, ean: str, price: str, count: int) -> str:
    zpl = (
        template
        .replace("{NAME}", name)
        .replace("{EAN}", ean)
        .replace("{PRICE}", price)
    )
    return _inject_count(zpl, count)


async def _send_zpl(ip: str, zpl: str) -> None:
    data = zpl.encode("ascii", errors="replace")
    loop = asyncio.get_event_loop()

    def _connect_and_send():
        import socket
        with socket.create_connection((ip, _LABEL_PORT), timeout=_LABEL_TIMEOUT) as sock:
            sock.sendall(data)

    await loop.run_in_executor(None, _connect_and_send)


@router.post("/{item_id}/print-label/")
async def print_label(
    item_id: str,
    count: int = Query(default=1, ge=1, le=100),
):
    mgr = SettingsManager()

    printer_ip = str(mgr.get_setting("label_printer_ip") or "").strip()
    if not printer_ip:
        raise HTTPException(status_code=400, detail="Etikettendrucker-IP nicht konfiguriert.")

    db = await get_db()
    try:
        oid = ObjectId(item_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Item nicht gefunden.")

    item = await db.items.find_one({"_id": oid})
    if not item:
        raise HTTPException(status_code=404, detail="Item nicht gefunden.")

    prices_enabled = bool(mgr.get_setting("prices_enabled"))
    name = str(item.get("name", "")).strip()
    ean = str(item.get("ean") or "").strip()

    price = ""
    if prices_enabled and item.get("price_eur") is not None:
        val = float(item["price_eur"])
        price = f"{val:.2f} EUR".replace(".", ",")

    zpl_template = str(mgr.get_setting("label_printer_zpl_template") or "").strip()

    if zpl_template:
        zpl = _apply_template(zpl_template, name, ean, price, count)
    else:
        try:
            width_mm = float(mgr.get_setting("label_printer_width_mm") or 62)
            height_mm = float(mgr.get_setting("label_printer_height_mm") or 29)
        except (TypeError, ValueError):
            width_mm, height_mm = 62.0, 29.0
        dpi = int(mgr.get_setting("label_printer_dpi") or 203)
        zpl = _build_default_zpl(name, ean, price, width_mm, height_mm, dpi, count)

    try:
        await _send_zpl(printer_ip, zpl)
    except OSError as e:
        raise HTTPException(status_code=502, detail=f"Drucker nicht erreichbar: {e}")

    return {"status": "printed", "count": count}

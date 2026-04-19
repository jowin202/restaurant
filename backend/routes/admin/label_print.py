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

    lines = [
        "^XA",
        f"^PW{w}",
        f"^LL{h}",
        "^FO20,15^ADN,36,20^FD" + name[:40] + "^FS",
    ]

    if ean:
        lines.append(f"^FO20,60^BQN,2,4^FDQA,{ean}^FS")
        if price:
            lines.append(f"^FO220,75^ADN,28,15^FD{price}^FS")
    elif price:
        lines.append(f"^FO20,75^ADN,28,15^FD{price}^FS")

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

import asyncio
import re
import socket
import unicodedata
from typing import Any, Dict, List, Optional
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from pymongo.errors import DuplicateKeyError

from db import get_db, get_next_sequence, normalize_username
from helper import calc_hmac, token_generate
from settingsmgr import SettingsManager


class UserBase(BaseModel):
    username: str
    name: Optional[str] = None
    mail: Optional[str] = None


class UserCreate(UserBase):
    password: str
    admin: int = Field(default=0, ge=0, le=2)


class UserUpdate(BaseModel):
    name: Optional[str] = None
    mail: Optional[str] = None
    password: Optional[str] = None


class UserOut(UserBase):
    id: int
    admin: int


class UserListOut(UserOut):
    login_link: Optional[str] = None


class BulkImportUsersRequest(BaseModel):
    lines: str = Field(min_length=1, max_length=50000)
    base_url: Optional[str] = Field(default=None, max_length=500)


router = APIRouter()
settings_manager = SettingsManager()


def _slugify_name(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value or "")
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii")
    lowered = ascii_text.strip().lower()
    lowered = re.sub(r"[^a-z0-9]+", ".", lowered)
    lowered = lowered.strip(".")
    return lowered


def _username_base_from_full_name(full_name: str) -> str:
    slug = _slugify_name(full_name)
    if not slug:
        return "nutzer"

    parts = [x for x in slug.split(".") if x]
    if len(parts) == 1:
        return parts[0][:48]

    base = f"{parts[0]}.{parts[-1]}"
    return base[:48].strip(".") or "nutzer"


def _build_login_base_url(request: Request, override_base_url: Optional[str]) -> str:
    if override_base_url:
        cleaned = override_base_url.strip().rstrip("/")
        if cleaned:
            return cleaned

    origin = request.headers.get("origin", "").strip().rstrip("/")
    if origin.startswith("http://") or origin.startswith("https://"):
        return origin

    forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
    forwarded_host = request.headers.get("x-forwarded-host", "").split(",")[0].strip()
    scheme = forwarded_proto or request.url.scheme
    host = forwarded_host or request.headers.get("host") or request.url.netloc
    return f"{scheme}://{host}".rstrip("/")


def _build_magic_login_link(base_url: str, token: str) -> str:
    encoded = quote(token, safe="")
    return f"{base_url}/login?magic={encoded}"


def _build_escpos_welcome_payload(message: str) -> bytes:
    text = (message or "").strip()
    if not text:
        text = "Willkommen!"

    encoded = text.encode("cp1252", errors="replace")
    return b"".join(
        [
            b"\x1b\x40",       # init
            b"\x1b\x61\x01",   # center
            encoded,
            b"\n\n",
            b"\x1b\x61\x00",   # left
            b"\n\n\n",
            b"\x1d\x56\x41\x00",  # full cut
        ]
    )


def _send_escpos_raw(ip_address: str, payload: bytes, timeout_seconds: float = 2.0) -> None:
    with socket.create_connection((ip_address, 9100), timeout=timeout_seconds) as sock:
        sock.sendall(payload)


async def _try_print_welcome(ip_address: str, message: str) -> Optional[str]:
    payload = _build_escpos_welcome_payload(message)
    try:
        await asyncio.to_thread(_send_escpos_raw, ip_address, payload)
        return None
    except Exception as exc:
        return str(exc)


def _resolve_welcome_text(template: str, name: str, username: str, link: str) -> str:
    text = str(template or "Lieber [Name], Bitte scanne den QR Code ab um zu unserem Restaurant zu gelangen.")
    text = re.sub(r"\[name\]", name, text, flags=re.IGNORECASE)
    text = re.sub(r"\[username\]", username, text, flags=re.IGNORECASE)
    text = re.sub(r"\[link\]", link, text, flags=re.IGNORECASE)
    return text


async def _reserve_unique_username(db: Any, base_username: str) -> str:
    base = normalize_username(base_username) or "nutzer"
    suffix = 0

    while True:
        candidate = base if suffix == 0 else f"{base}{suffix + 1}"
        candidate = candidate[:60]
        existing = await db.users.find_one(
            {"username_normalized": candidate},
            {"_id": 0, "id": 1},
        )
        if not existing:
            return candidate
        suffix += 1
        if suffix > 500:
            raise HTTPException(500, "Konnte keinen freien Username generieren")


async def _load_target_user_for_action(db: Any, user_id: int, current_admin_level: int) -> Dict[str, Any]:
    target = await db.users.find_one(
        {"id": user_id},
        {"_id": 0, "id": 1, "username": 1, "name": 1, "admin": 1, "magic_login_token": 1},
    )
    if not target:
        raise HTTPException(404, "Benutzer nicht gefunden")

    if current_admin_level <= int(target.get("admin", 0)):
        raise HTTPException(403, "Unzureichende Berechtigung")

    if int(target.get("admin", 0)) > 0:
        raise HTTPException(400, "Login-Link und Druck sind nur für Nutzer ohne Adminrechte vorgesehen")

    return target


async def _ensure_user_magic_login_token(db: Any, user: Dict[str, Any]) -> str:
    existing = str(user.get("magic_login_token") or "").strip()
    if existing:
        return existing

    new_token = token_generate()
    await db.users.update_one({"id": user["id"]}, {"$set": {"magic_login_token": new_token}})
    return new_token


@router.get("/", response_model=List[UserListOut])
async def get_all_users(request: Request):
    db = await get_db()
    rows = await db.users.find(
        {},
        {"_id": 0, "id": 1, "username": 1, "name": 1, "mail": 1, "admin": 1, "magic_login_token": 1},
    ).sort("id", 1).to_list(length=None)

    login_base_url = _build_login_base_url(request, None)
    for row in rows:
        if int(row.get("admin", 0)) == 0:
            login_token = await _ensure_user_magic_login_token(db, row)
            row["login_link"] = _build_magic_login_link(login_base_url, login_token)
        row.pop("magic_login_token", None)

    return rows


@router.post("/", response_model=UserOut)
async def create_user(data: UserCreate, request: Request):
    current_admin_level = request.state.admin

    if data.admin >= current_admin_level:
        raise HTTPException(
            403,
            f"Du darfst keine User mit Level {data.admin} erstellen (Dein Level: {current_admin_level})",
        )

    db = await get_db()
    username_normalized = normalize_username(data.username)
    if not username_normalized:
        raise HTTPException(400, "Username darf nicht leer sein")

    existing_user = await db.users.find_one(
        {"username_normalized": username_normalized},
        {"_id": 0, "id": 1},
    )

    if existing_user:
        raise HTTPException(400, "Username bereits vergeben")

    new_id = await get_next_sequence("users")
    await db.users.insert_one(
        {
            "id": new_id,
            "username": data.username.strip(),
            "username_normalized": username_normalized,
            "name": data.name,
            "mail": data.mail,
            "password": calc_hmac(data.password),
            "token": "",
            "admin": data.admin,
        }
    )

    row = await db.users.find_one(
        {"id": new_id},
        {"_id": 0, "id": 1, "username": 1, "name": 1, "mail": 1, "admin": 1},
    )
    return row


@router.put("/{user_id}/", response_model=UserOut)
async def update_user(user_id: int, data: UserUpdate, request: Request):
    current_admin_level = request.state.admin
    db = await get_db()

    target = await db.users.find_one({"id": user_id}, {"_id": 0, "admin": 1})
    if not target:
        raise HTTPException(404, "Benutzer nicht gefunden")

    if current_admin_level <= target["admin"]:
        raise HTTPException(
            403,
            "Unzureichende Berechtigung: Dein Level muss höher sein als das des Ziel-Users",
        )

    fields = data.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(400, "Keine Felder zum Aktualisieren")

    if "password" in fields:
        fields["password"] = calc_hmac(fields["password"])

    await db.users.update_one({"id": user_id}, {"$set": fields})
    row = await db.users.find_one(
        {"id": user_id},
        {"_id": 0, "id": 1, "username": 1, "name": 1, "mail": 1, "admin": 1},
    )
    return row


@router.delete("/{user_id}/")
async def delete_user(user_id: int, request: Request):
    current_admin_level = request.state.admin

    db = await get_db()
    target = await db.users.find_one({"id": user_id}, {"_id": 0, "admin": 1})

    if not target:
        raise HTTPException(404, "Benutzer nicht gefunden")

    if current_admin_level <= target["admin"]:
        raise HTTPException(403, f"Level {current_admin_level} darf Level {target['admin']} nicht löschen!")

    result = await db.users.delete_one({"id": user_id})
    if result.deleted_count == 0:
        raise HTTPException(404, "Benutzer nicht gefunden")
    return {"status": "success", "deleted_id": user_id}


@router.post("/bulk-import/")
async def bulk_import_users(data: BulkImportUsersRequest, request: Request):
    db = await get_db()

    names = [line.strip() for line in data.lines.splitlines() if line.strip()]
    if not names:
        raise HTTPException(400, "Keine gültigen Zeilen gefunden")

    login_base_url = _build_login_base_url(request, data.base_url)
    printer_ip = str(
        settings_manager.get_setting("receipt_printer_ip")
        or settings_manager.get_setting("label_printer_ip")
        or ""
    ).strip()
    welcome_template = str(
        settings_manager.get_setting("guest_qr_invite_text")
        or "Lieber [Name], Bitte scanne den QR Code ab um zu unserem Restaurant zu gelangen."
    )

    results: List[Dict[str, Any]] = []
    warnings: List[str] = []

    if not printer_ip:
        warnings.append("Drucker-IP ist nicht konfiguriert. Ausdruck wurde übersprungen.")

    for line_index, full_name in enumerate(names, start=1):
        username_base = _username_base_from_full_name(full_name)
        username = await _reserve_unique_username(db, username_base)

        magic_login_token = token_generate()
        login_link = _build_magic_login_link(login_base_url, magic_login_token)

        created_doc = {
            "id": await get_next_sequence("users"),
            "username": username,
            "username_normalized": normalize_username(username),
            "name": full_name,
            "mail": None,
            "password": calc_hmac(token_generate()),
            "token": "",
            "magic_login_token": magic_login_token,
            "admin": 0,
        }

        try:
            await db.users.insert_one(created_doc)
        except DuplicateKeyError:
            # sehr selten bei Rennen; noch einmal mit neuer Reservierung probieren
            fallback_username = await _reserve_unique_username(db, f"{username_base}x")
            created_doc["username"] = fallback_username
            created_doc["username_normalized"] = normalize_username(fallback_username)
            await db.users.insert_one(created_doc)

        print_status = "skipped"
        print_error = ""
        if printer_ip:
            message = _resolve_welcome_text(
                template=welcome_template,
                name=full_name,
                username=created_doc["username"],
                link=login_link,
            )
            error = await _try_print_welcome(printer_ip, message)
            if error:
                print_status = "printer_offline"
                print_error = error
                warnings.append(f"Zeile {line_index} ({full_name}): Druck fehlgeschlagen ({error})")
            else:
                print_status = "printed"
        else:
            print_status = "printer_not_configured"

        results.append(
            {
                "id": created_doc["id"],
                "name": full_name,
                "username": created_doc["username"],
                "login_link": login_link,
                "print_status": print_status,
                "print_error": print_error,
            }
        )

    return {
        "status": "success",
        "created_count": len(results),
        "line_count": len(names),
        "printer_ip": printer_ip or None,
        "warnings": warnings,
        "users": results,
    }


@router.post("/{user_id}/login-link/")
async def get_user_login_link(user_id: int, request: Request):
    db = await get_db()
    target = await _load_target_user_for_action(db, user_id, int(getattr(request.state, "admin", 0)))

    login_token = await _ensure_user_magic_login_token(db, target)
    login_base_url = _build_login_base_url(request, None)
    login_link = _build_magic_login_link(login_base_url, login_token)

    return {
        "status": "success",
        "user_id": target["id"],
        "username": target.get("username"),
        "name": target.get("name"),
        "login_link": login_link,
    }


@router.post("/{user_id}/reprint-welcome/")
async def reprint_welcome(user_id: int, request: Request):
    db = await get_db()
    target = await _load_target_user_for_action(db, user_id, int(getattr(request.state, "admin", 0)))

    login_token = await _ensure_user_magic_login_token(db, target)
    login_base_url = _build_login_base_url(request, None)
    login_link = _build_magic_login_link(login_base_url, login_token)

    printer_ip = str(
        settings_manager.get_setting("receipt_printer_ip")
        or settings_manager.get_setting("label_printer_ip")
        or ""
    ).strip()
    if not printer_ip:
        return {
            "status": "printer_not_configured",
            "user_id": target["id"],
            "login_link": login_link,
            "message": "Drucker-IP ist nicht konfiguriert.",
        }

    welcome_template = str(
        settings_manager.get_setting("guest_qr_invite_text")
        or "Lieber [Name], Bitte scanne den QR Code ab um zu unserem Restaurant zu gelangen."
    )
    welcome_text = _resolve_welcome_text(
        template=welcome_template,
        name=str(target.get("name") or target.get("username") or "Gast"),
        username=str(target.get("username") or ""),
        link=login_link,
    )
    error = await _try_print_welcome(printer_ip, welcome_text)
    if error:
        return {
            "status": "printer_offline",
            "user_id": target["id"],
            "login_link": login_link,
            "message": f"Druck fehlgeschlagen: {error}",
        }

    return {
        "status": "printed",
        "user_id": target["id"],
        "login_link": login_link,
        "message": "Willkommenstext wurde gedruckt.",
    }

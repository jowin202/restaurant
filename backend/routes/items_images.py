import hashlib
import mimetypes
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import requests
from bson import ObjectId
from fastapi import HTTPException


MAX_IMAGE_SIZE = 12 * 1024 * 1024  # 12 MiB
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"}


def build_data_url(image: Optional[Dict[str, Any]]) -> Optional[str]:
    if not image:
        return None

    content_type = image.get("content_type")
    data = image.get("data_base64")
    if not content_type or not data:
        return None

    return f"data:{content_type};base64,{data}"


def normalize_image_entries(doc: Dict[str, Any]) -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []

    raw_images = doc.get("images")
    if isinstance(raw_images, list):
        for row in raw_images:
            if not isinstance(row, dict):
                continue

            content_type = row.get("content_type")
            data = row.get("data_base64")
            if not content_type or not data:
                continue

            entries.append(
                {
                    "id": str(row.get("id") or f"img-{hashlib.md5(str(data).encode('utf-8')).hexdigest()[:12]}"),
                    "filename": str(row.get("filename") or "image"),
                    "content_type": str(content_type),
                    "data_base64": str(data),
                    "created_at": row.get("created_at"),
                }
            )

    return entries


def new_image_entry(filename: str, content_type: str, data_base64: str) -> Dict[str, Any]:
    return {
        "id": str(ObjectId()),
        "filename": (filename or "image")[:140],
        "content_type": content_type,
        "data_base64": data_base64,
        "created_at": datetime.now(timezone.utc),
    }


def extract_filename_from_url(url: str) -> str:
    path = urlparse(url).path
    filename = os.path.basename(path).strip()
    if filename:
        return filename[:140]
    return "image"


def resolve_content_type(url: str, response_content_type: Optional[str]) -> Optional[str]:
    header_type = (response_content_type or "").split(";")[0].strip().lower()
    if header_type in ALLOWED_IMAGE_TYPES:
        return header_type

    guessed_type, _ = mimetypes.guess_type(url)
    if guessed_type in ALLOWED_IMAGE_TYPES:
        return guessed_type

    return None


def download_image_from_url(url: str) -> Tuple[bytes, str, str]:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(status_code=400, detail="Nur http/https URLs sind erlaubt")

    try:
        response = requests.get(url, timeout=12, allow_redirects=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Bild-URL konnte nicht geladen werden")

    if response.status_code >= 400:
        raise HTTPException(status_code=400, detail="Bild-URL liefert keinen gültigen Inhalt")

    content = response.content or b""
    if not content:
        raise HTTPException(status_code=400, detail="Die Bild-URL ist leer")

    if len(content) > MAX_IMAGE_SIZE:
        raise HTTPException(status_code=413, detail="Bild ist zu groß (max. 12MB)")

    final_url = response.url or url
    content_type = resolve_content_type(final_url, response.headers.get("content-type"))
    if not content_type:
        raise HTTPException(status_code=400, detail="Ungültiger Dateityp. Erlaubt: JPEG, PNG, WEBP, GIF")

    return content, content_type, extract_filename_from_url(final_url)

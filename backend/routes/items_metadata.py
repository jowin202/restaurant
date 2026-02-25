import asyncio
import os
from typing import Any, Dict, List, Literal, Optional, Tuple

import requests


def infer_item_type(name: str, category: str) -> Literal["essen", "getränk"]:
    text = f"{name} {category}".lower()
    beverage_keywords = [
        "drink",
        "beverage",
        "juice",
        "water",
        "cola",
        "soda",
        "bier",
        "beer",
        "wein",
        "wine",
        "tee",
        "kaffee",
        "coffee",
        "getränk",
    ]
    return "getränk" if any(keyword in text for keyword in beverage_keywords) else "essen"


def safe_get_json(
    url: str,
    headers: Optional[Dict[str, str]] = None,
    params: Optional[Dict[str, str]] = None,
) -> Optional[Dict[str, Any]]:
    try:
        response = requests.get(url, headers=headers, params=params, timeout=5)
        if response.status_code >= 400:
            return None
        return response.json()
    except Exception:
        return None


async def provider_openfoodfacts(ean: str) -> Optional[Dict[str, Any]]:
    data = await asyncio.to_thread(
        safe_get_json,
        f"https://world.openfoodfacts.org/api/v2/product/{ean}.json",
    )
    if not data or data.get("status") != 1:
        return None

    product = data.get("product", {})
    name = product.get("product_name_de") or product.get("product_name") or ""
    brand = product.get("brands")
    quantity = product.get("quantity")
    categories = product.get("categories") or ""
    image_url = product.get("image_front_url") or product.get("image_url")

    if not name:
        return None

    attributes: Dict[str, Any] = {}
    if brand:
        attributes["marke"] = brand
    if categories:
        attributes["kategorie"] = categories
    if product.get("nutriscore_grade"):
        attributes["nutriscore"] = product.get("nutriscore_grade")

    return {
        "source": "openfoodfacts",
        "name": name,
        "brand": brand,
        "quantity": quantity,
        "category": categories,
        "image_url": image_url,
        "item_type": infer_item_type(name, categories),
        "attributes": attributes,
    }


async def provider_upcitemdb(ean: str) -> Optional[Dict[str, Any]]:
    api_key = os.getenv("UPCITEMDB_API_KEY", "").strip()
    if not api_key:
        return None

    data = await asyncio.to_thread(
        safe_get_json,
        "https://api.upcitemdb.com/prod/trial/lookup",
        {"user_key": api_key},
        {"upc": ean},
    )
    if not data:
        return None

    items = data.get("items") or []
    if not items:
        return None

    item = items[0]
    title = item.get("title") or ""
    brand = item.get("brand") or item.get("manufacturer")
    category = item.get("category") or ""

    if not title:
        return None

    attributes: Dict[str, Any] = {}
    if brand:
        attributes["marke"] = brand
    if category:
        attributes["kategorie"] = category

    return {
        "source": "upcitemdb",
        "name": title,
        "brand": brand,
        "quantity": None,
        "category": category,
        "image_url": (item.get("images") or [None])[0],
        "item_type": infer_item_type(title, category),
        "attributes": attributes,
    }


async def provider_barcodelookup(ean: str) -> Optional[Dict[str, Any]]:
    api_key = os.getenv("BARCODELOOKUP_API_KEY", "").strip()
    if not api_key:
        return None

    data = await asyncio.to_thread(
        safe_get_json,
        "https://api.barcodelookup.com/v3/products",
        None,
        {"barcode": ean, "formatted": "y", "key": api_key},
    )
    if not data:
        return None

    products = data.get("products") or []
    if not products:
        return None

    product = products[0]
    title = product.get("title") or ""
    brand = product.get("brand")
    category = product.get("category") or ""

    if not title:
        return None

    attributes: Dict[str, Any] = {}
    if brand:
        attributes["marke"] = brand
    if category:
        attributes["kategorie"] = category

    return {
        "source": "barcodelookup",
        "name": title,
        "brand": brand,
        "quantity": None,
        "category": category,
        "image_url": product.get("images", [None])[0] if product.get("images") else None,
        "item_type": infer_item_type(title, category),
        "attributes": attributes,
    }


async def fetch_ean_metadata(ean: str) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    providers = [
        ("openfoodfacts", provider_openfoodfacts),
        ("upcitemdb", provider_upcitemdb),
        ("barcodelookup", provider_barcodelookup),
    ]

    queried: List[str] = []
    for provider_name, provider_fn in providers:
        queried.append(provider_name)
        metadata = await provider_fn(ean)
        if metadata:
            return metadata, queried

    return None, queried

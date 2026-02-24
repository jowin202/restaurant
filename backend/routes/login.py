from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel

from db import get_db, normalize_username
from helper import calc_hmac, token_generate
from security import verify_token

router = APIRouter()


class MagicLoginRequest(BaseModel):
    token: str


@router.post("/")
async def login(form_data: Annotated[OAuth2PasswordRequestForm, Depends()]):
    username_normalized = normalize_username(form_data.username)
    raw_password = form_data.password
    hashed_password = calc_hmac(raw_password)
    token = token_generate()

    db = await get_db()
    user = await db.users.find_one(
        {"username_normalized": username_normalized},
        {"_id": 0, "id": 1, "username": 1, "password": 1, "admin": 1, "name": 1, "mail": 1},
    )

    if not user or not user.get("password") or user["password"] != hashed_password:
        raise HTTPException(status_code=400, detail="Incorrect username or password")

    await db.users.update_one({"id": user["id"]}, {"$set": {"token": token}})

    return {
        "access_token": token,
        "admin": user["admin"],
        "token_type": "bearer",
    }


@router.post("/magic/")
async def login_magic(data: MagicLoginRequest):
    magic_token = str(data.token or "").strip()
    if not magic_token:
        raise HTTPException(status_code=400, detail="Magic token fehlt")

    db = await get_db()
    user = await db.users.find_one(
        {"magic_login_token": magic_token},
        {"_id": 0, "id": 1, "username": 1, "admin": 1},
    )

    if not user:
        raise HTTPException(status_code=400, detail="Ungültiger Login-Link")

    session_token = token_generate()
    await db.users.update_one({"id": user["id"]}, {"$set": {"token": session_token}})

    return {
        "access_token": session_token,
        "username": user.get("username", ""),
        "admin": user["admin"],
        "token_type": "bearer",
    }


@router.get("/from_token/{token}/")
async def login_token(token: str):
    db = await get_db()
    row = await db.users.find_one(
        {"token": token},
        {"_id": 0, "id": 1, "username": 1, "admin": 1},
    )

    if not row:
        raise HTTPException(status_code=404, detail="User not found")

    return {"username": row.get("username", ""), "admin": row.get("admin", 0)}


@router.get("/logout/")
async def logout(token: str = Depends(verify_token)):
    db = await get_db()
    await db.users.update_one({"token": token}, {"$set": {"token": ""}})
    return True

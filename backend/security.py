from fastapi import Depends, Request, HTTPException
from fastapi.security import OAuth2PasswordBearer

from db import get_db

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/login/")


async def verify_token(request: Request, token: str = Depends(oauth2_scheme)):
    db = await get_db()
    user = await db.users.find_one(
        {"token": token, "deleted": False},
        {"_id": 0, "id": 1, "admin": 1, "name": 1},
    )

    if not user:
        raise HTTPException(status_code=401, detail="Ungültiger Token oder Account deaktiviert")

    request.state.user_id = user["id"]
    request.state.admin = user["admin"]
    request.state.name = user.get("name")
    return token


async def verify_token_admin(request: Request, token: str = Depends(oauth2_scheme)):
    db = await get_db()
    user = await db.users.find_one(
        {"token": token, "admin": {"$gt": 0}, "deleted": False},
        {"_id": 0, "id": 1, "admin": 1, "name": 1},
    )

    if not user:
        raise HTTPException(status_code=401, detail="Nicht autorisiert oder Account deaktiviert")

    request.state.user_id = user["id"]
    request.state.admin = user["admin"]
    request.state.name = user.get("name")
    return token


async def verify_token_super_admin(request: Request, token: str = Depends(oauth2_scheme)):
    db = await get_db()
    user = await db.users.find_one(
        {"token": token, "admin": {"$gt": 1}, "deleted": False},
        {"_id": 0, "id": 1, "admin": 1, "name": 1},
    )

    if not user:
        raise HTTPException(status_code=401, detail="Nur Super Admin erlaubt")

    request.state.user_id = user["id"]
    request.state.admin = user["admin"]
    request.state.name = user.get("name")
    return token

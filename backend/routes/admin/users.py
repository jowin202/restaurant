from typing import List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from db import get_db, get_next_sequence
from helper import calc_hmac


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


router = APIRouter()


@router.get("/", response_model=List[UserOut])
async def get_all_users():
    db = await get_db()
    rows = await db.users.find(
        {"deleted": False},
        {"_id": 0, "id": 1, "username": 1, "name": 1, "mail": 1, "admin": 1},
    ).sort("id", 1).to_list(length=None)
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
    existing_user = await db.users.find_one({"username": data.username}, {"_id": 0, "id": 1, "deleted": 1})

    if existing_user and not existing_user.get("deleted", False):
        raise HTTPException(400, "Username bereits vergeben")

    if existing_user and existing_user.get("deleted", False):
        await db.users.update_one(
            {"id": existing_user["id"]},
            {
                "$set": {
                    "name": data.name,
                    "mail": data.mail,
                    "password": calc_hmac(data.password),
                    "admin": data.admin,
                    "deleted": False,
                    "token": "",
                }
            },
        )
        row = await db.users.find_one(
            {"id": existing_user["id"]},
            {"_id": 0, "id": 1, "username": 1, "name": 1, "mail": 1, "admin": 1},
        )
        return row

    new_id = await get_next_sequence("users")
    await db.users.insert_one(
        {
            "id": new_id,
            "username": data.username,
            "name": data.name,
            "mail": data.mail,
            "password": calc_hmac(data.password),
            "token": "",
            "deleted": False,
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

    target = await db.users.find_one({"id": user_id, "deleted": False}, {"_id": 0, "admin": 1})
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
    target = await db.users.find_one({"id": user_id, "deleted": False}, {"_id": 0, "admin": 1})

    if not target:
        raise HTTPException(404, "Benutzer nicht gefunden")

    if current_admin_level <= target["admin"]:
        raise HTTPException(403, f"Level {current_admin_level} darf Level {target['admin']} nicht löschen!")

    await db.users.update_one({"id": user_id}, {"$set": {"deleted": True, "token": ""}})
    return {"status": "success", "deleted_id": user_id}

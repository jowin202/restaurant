import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from db import initialize_connection_pool, pg_db_init
from security import verify_token, verify_token_super_admin
from settingsmgr import SettingsManager


@asynccontextmanager
async def lifespan(app: FastAPI):
    db_is_ready = False

    while not db_is_ready:
        try:
            print("Waiting for DB...", flush=True)
            await initialize_connection_pool()
            await pg_db_init()
            db_is_ready = True
            print("DB ready!", flush=True)
        except Exception as e:
            print(f"DB not ready yet: {e}", flush=True)
            await asyncio.sleep(1)

    await SettingsManager().initialize()
    yield


app = FastAPI(title="Restaurant & Fridge API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from routes import dashboard
from routes import items
from routes import login
from routes import orders
from routes.admin import settings
from routes.admin import users

app.include_router(login.router, tags=["login"], prefix="/api/login")
app.include_router(dashboard.router, tags=["dashboard"], prefix="/api/dashboard", dependencies=[Depends(verify_token)])
app.include_router(items.router, tags=["items"], prefix="/api/items", dependencies=[Depends(verify_token)])
app.include_router(orders.router, tags=["orders"], prefix="/api/orders", dependencies=[Depends(verify_token)])
app.include_router(users.router, tags=["users"], prefix="/api/users", dependencies=[Depends(verify_token_super_admin)])
app.include_router(settings.router, tags=["settings"], prefix="/api/settings", dependencies=[Depends(verify_token_super_admin)])


app.mount("/", StaticFiles(directory="static", html=True), name="static-root")


@app.middleware("http")
async def spa_fallback(request: Request, call_next):
    passthrough_prefixes = ("/api", "/docs", "/redoc", "/openapi.json")
    if request.url.path.startswith(passthrough_prefixes) or os.path.isfile(f"static{request.url.path}"):
        return await call_next(request)

    with open("static/index.html", encoding="utf-8") as f:
        html_content = f.read()
    return HTMLResponse(content=html_content)

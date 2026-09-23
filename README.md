# Boxertafel

Inventory, shop and admin system for a club canteen ("Boxertafel"), built as an Angular SPA backed by a FastAPI service and MongoDB.

## Features

- **Shop** – browse items and place orders, redeemable via voucher codes
- **Inventory** – manage stock items, look up product data by barcode (UPCitemdb / barcodelookup.com)
- **Label printing** – generate ZPL labels (name, EAN, price) and send them directly to a network label printer
- **Dashboard** – sales and stock overview
- **Users & roles** – login with role-based access (user / admin / super admin)
- **Settings & backup** – configurable app settings, database backup & restore
- **HMAC-signed passwords** – user passwords are hashed with a server-side HMAC key

## Tech stack

| Layer      | Stack                                              |
|------------|-----------------------------------------------------|
| Frontend   | Angular 22, Angular Material, TypeScript, Node 24  |
| Backend    | FastAPI, Motor (async MongoDB driver), Python 3.14 |
| Database   | MongoDB 8                                          |
| Packaging  | Single multi-stage Docker image (frontend built, served as static files by FastAPI) |

## Project structure

```
frontend/   Angular application (Angular CLI, standalone components)
backend/    FastAPI application (routes/, db.py, security.py, settingsmgr.py)
Dockerfile  Multi-stage build: compiles the frontend, then bundles it with the backend
```

## Configuration

The backend is configured entirely via environment variables:

| Variable                 | Description                                              |
|---------------------------|-----------------------------------------------------------|
| `MONGODB_URI`              | MongoDB connection string (e.g. `mongodb://db:27017`)     |
| `MONGODB_DB`               | Database name                                              |
| `MONGODB_PORT`             | Host port to expose MongoDB on (compose only)              |
| `ADMIN_DEFAULT_PASSWORD`   | Password for the initial admin user, created on first run |
| `HMAC_KEY`                 | Hex-encoded key used to hash user passwords                |
| `UPCITEMDB_API_KEY`        | API key for UPCitemdb barcode lookups (optional)           |
| `BARCODELOOKUP_API_KEY`    | API key for barcodelookup.com barcode lookups (optional)   |

Copy the example file and fill in real values:

```bash
cp env .env
```

## Running with Docker Compose

### Build from source

Builds the image locally from the `Dockerfile` (frontend + backend + Mongo):

```bash
docker compose up -d --build
```

### Run a prebuilt image

Pulls the image published to GitHub Container Registry instead of building it locally — only needs `docker-compose.github.yml` and a `.env` file next to it:

```bash
docker compose -f docker-compose.github.yml up -d
```

The app is served on [http://localhost:8000](http://localhost:8000).

## Local development (without Docker)

**Backend**

```bash
cd backend
pip install -r ../requirements.txt
uvicorn main:app --reload --port 8000
```

**Frontend**

```bash
cd frontend
npm ci
npm start   # ng serve, proxies /api to localhost:8000 (see proxy.conf.json)
```

## CI/CD

[.github/workflows/build.yml](.github/workflows/build.yml) builds the image from the `Dockerfile` and pushes it to `ghcr.io/jowin202/restaurant` (`:latest` and `:<commit-sha>`). It's triggered manually via **Actions → Build → Run workflow**.

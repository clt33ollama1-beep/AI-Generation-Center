# ComfyCentre

A self-hosted **AI Generation Centre** for orchestrating remote [ComfyUI](https://github.com/comfyanonymous/ComfyUI) image and video workflows from a schema-driven web interface—without requiring local GPU hardware on the host running this application.

## Features

- **Remote ComfyUI Integration:** Connects to any external ComfyUI instance via HTTP/HTTPS and WebSocket (`COMFYUI_URL`) with live `/system_stats` GPU & VRAM inspection.
- **Image & Video Generation:** Supports standard image outputs (`PNG`, `JPG`, `WEBP`) and animated video workflows (`MP4`, `WEBM`, `GIF`), including `VHS_VideoCombine` outputs.
- **Schema-Driven Template Manager (`/templates`):** Upload or paste any ComfyUI **"Save (API Format)"** JSON file, inspect editable node inputs automatically (filtering out internal node link arrays), and map fields to UI widgets (`text`, `textarea`, `number`, `slider`, `seed_randomizer`, `checkbox`, `select`, `image_upload`).
- **Categorized Generation Workspace (`/`):** Organize templates into custom categories (*Text-to-Image*, *Image-to-Video*, *Upscaling*, etc.), upload reference images/videos via drag-and-drop, randomize or lock seeds, and track real-time step/node execution progress over Server-Sent Events (SSE) with 15-second keep-alive heartbeats.
- **Media Gallery (`/gallery`):** Filter generated images and videos by media type, workflow, or prompt/parameter text; inspect submitted parameters; download outputs; or reuse parameters in a single click.
- **Zero-Config Persistence & No Auth:** Uses SQLite (`./data/db.sqlite`) and local media storage (`./data/outputs/`) with no login screens or user accounts—designed for trusted local or VPN networks.

---

## Architecture

| Component | Docker Stack | Local / Preview Runtime |
| --- | --- | --- |
| **Frontend** | React + TypeScript + Tailwind CSS served via Nginx (`:3000`) | React + TypeScript + Tailwind CSS via Vite (`:3000`) |
| **Backend** | Python FastAPI + SQLModel + `httpx` + `websockets` (`:8000`) | Express + `node:sqlite` + `ws` (`:3000`) |
| **Storage** | `./data/db.sqlite` & `./data/outputs` mounted to `/app/data` | `./data/db.sqlite` & `./data/outputs` |

---

## Prerequisites

1. **Remote ComfyUI Instance:** ComfyUI must be reachable over your LAN, VPN, or private network. Start ComfyUI with `--listen 0.0.0.0` so remote hosts can connect:
   ```bash
   python main.py --listen 0.0.0.0 --port 8188
   ```
2. **Docker & Docker Compose** (for containerized self-hosting) **or** **Node.js 22+** (for local Node development).

---

## Self-Hosted Deployment (Docker Compose)

1. **Configure environment variables:**
   Copy `.env.example` to `.env` and set `COMFYUI_URL` to your ComfyUI host:
   ```bash
   cp .env.example .env
   ```
   Example `.env`:
   ```env
   COMFYUI_URL=http://192.168.1.100:8188
   DATA_DIR=/app/data
   FRONTEND_PORT=3000
   BACKEND_PORT=8000
   ```
   *(If port `8000` or `3000` is already allocated on your host, set `BACKEND_PORT=8001` or `FRONTEND_PORT=3001` in `.env`—Nginx proxies `/api` to `backend:8000` over the internal Docker network regardless of host port.)*

2. **Build and start the stack:**
   ```bash
   docker compose up --build -d
   ```

3. **Access the application:**
   - **Web UI:** `http://localhost:3000` (or `FRONTEND_PORT`)
   - **FastAPI Backend / OpenAPI Docs:** `http://localhost:8000/docs` (or `BACKEND_PORT`)

4. **Data Persistence:**
   The `./data` directory on your host is mounted into `/app/data` inside the `backend` container:
   - `./data/db.sqlite` — Categories, workflow templates, endpoint settings, and generation metadata.
   - `./data/outputs/` — Downloaded images and videos retrieved from ComfyUI.

   You can also update `COMFYUI_URL` at runtime from the **Connection** modal in the top navigation bar without rebuilding containers.

5. **Stopping or updating:**
   ```bash
   docker compose down
   docker compose up --build -d
   ```

---

## Local Development (Node.js + Vite)

To run the integrated Node.js + Express + Vite server locally on port `3000`:

```bash
npm install
cp .env.example .env
npm run dev
```

To build for production and run:

```bash
npm run build
NODE_ENV=production npm start
```

---

## Exporting Workflows from ComfyUI

To import your own workflows into ComfyCentre:

1. In ComfyUI, open Settings (gear icon) and enable **Enable Dev mode Options** (or use **Workflow -> Export (API)** in newer ComfyUI builds).
2. Click **Save (API Format)** to download the `.json` file.
3. Open **Templates** (`/templates`) in ComfyCentre, upload or paste the JSON, click **Inspect Nodes**, select the inputs to expose, choose their UI widgets, and save.

---

## API Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` / `PUT` | `/api/settings` | Read or update `COMFYUI_URL` |
| `GET` | `/api/health/comfyui` | Probe remote ComfyUI `/system_stats` |
| `GET` / `POST` / `PUT` / `DELETE` | `/api/categories` | Manage workflow categories |
| `POST` | `/api/workflows/inspect` | Parse ComfyUI API JSON into editable node inputs |
| `GET` / `POST` / `PUT` / `DELETE` | `/api/workflows` | Manage workflow templates and `ui_inputs` schemas |
| `POST` | `/api/generate` | Upload media, inject parameters, and queue ComfyUI prompt |
| `GET` | `/api/progress/{client_id}` | Server-Sent Events (SSE) progress and completion stream |
| `GET` / `DELETE` | `/api/generations` | List, filter, and delete generation history and media files |

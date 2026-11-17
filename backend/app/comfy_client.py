import asyncio
import json
import secrets
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode, urlparse

import httpx
import websockets
from sqlmodel import Session

from app.config import settings
from app.database import engine
from app.models import GenerationRecord
from app.schemas import OutputFileInfo


class SSEHub:
    def __init__(self) -> None:
        self._channels: dict[str, set[asyncio.Queue[dict[str, Any]]]] = {}

    def subscribe(self, client_id: str) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._channels.setdefault(client_id, set()).add(queue)
        return queue

    def unsubscribe(self, client_id: str, queue: asyncio.Queue[dict[str, Any]]) -> None:
        listeners = self._channels.get(client_id)
        if not listeners:
            return
        listeners.discard(queue)
        if not listeners:
            self._channels.pop(client_id, None)

    async def emit(self, client_id: str, payload: dict[str, Any]) -> None:
        for queue in list(self._channels.get(client_id, set())):
            await queue.put(payload)


sse_hub = SSEHub()


def to_ws_url(comfyui_url: str, client_id: str) -> str:
    parsed = urlparse(comfyui_url)
    ws_scheme = "wss" if parsed.scheme == "https" else "ws"
    return f"{ws_scheme}://{parsed.netloc}/ws?clientId={quote(client_id)}"


def detect_media_type(filename: str, fmt: str = "") -> str:
    lower = filename.lower()
    fmt_lower = fmt.lower()
    if fmt_lower.startswith("video/") or lower.endswith(
        (".mp4", ".webm", ".mov", ".mkv", ".gif")
    ):
        return "video"
    return "image"


async def check_comfy_health(comfyui_url: str) -> dict[str, Any]:
    url = comfyui_url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            resp = await client.get(f"{url}/system_stats")
            if resp.status_code != 200:
                return {
                    "connected": False,
                    "comfyui_url": url,
                    "error": f"HTTP {resp.status_code} from {url}/system_stats",
                }
            return {
                "connected": True,
                "comfyui_url": url,
                "system_stats": resp.json(),
            }
    except Exception as exc:
        return {
            "connected": False,
            "comfyui_url": url,
            "error": str(exc),
        }


async def upload_media_to_comfyui(
    comfyui_url: str,
    filename: str,
    content: bytes,
    content_type: str,
) -> str:
    url = comfyui_url.rstrip("/")
    async with httpx.AsyncClient(timeout=60.0) as client:
        files = {"image": (filename or "upload.png", content, content_type or "application/octet-stream")}
        data = {"overwrite": "true"}
        resp = await client.post(f"{url}/upload/image", files=files, data=data)
        if resp.status_code >= 400:
            raise RuntimeError(f"ComfyUI media upload failed ({resp.status_code}): {resp.text}")
        payload = resp.json()
        name = payload.get("name", "")
        subfolder = payload.get("subfolder", "")
        return f"{subfolder}/{name}" if subfolder else name


async def download_comfy_outputs(comfyui_url: str, prompt_id: str) -> list[OutputFileInfo]:
    url = comfyui_url.rstrip("/")
    async with httpx.AsyncClient(timeout=120.0) as client:
        hist_resp = await client.get(f"{url}/history/{quote(prompt_id)}")
        if hist_resp.status_code >= 400:
            raise RuntimeError(f"Failed to fetch ComfyUI history ({hist_resp.status_code})")
        history_data = hist_resp.json()

        entry = history_data.get(prompt_id, {})
        outputs_map = entry.get("outputs", {})
        saved_outputs: list[OutputFileInfo] = []

        for node_id, node_output in outputs_map.items():
            if not isinstance(node_output, dict):
                continue
            candidates: list[dict[str, Any]] = []
            for key in ("videos", "gifs", "images"):
                items = node_output.get(key)
                if isinstance(items, list):
                    candidates.extend(items)

            for item in candidates:
                orig_name = item.get("filename")
                if not orig_name:
                    continue
                qs = urlencode(
                    {
                        "filename": orig_name,
                        "subfolder": item.get("subfolder", ""),
                        "type": item.get("type", "output"),
                    }
                )
                view_resp = await client.get(f"{url}/view?{qs}")
                if view_resp.status_code != 200:
                    continue

                ext = Path(orig_name).suffix or ".png"
                local_name = f"{int(time.time() * 1000)}_{secrets.token_hex(4)}{ext}"
                local_path = settings.outputs_path / local_name
                local_path.write_bytes(view_resp.content)

                fmt = str(item.get("format") or ext.lstrip("."))
                media_type = detect_media_type(orig_name, fmt)
                saved_outputs.append(
                    OutputFileInfo(
                        filename=local_name,
                        original_filename=orig_name,
                        url=f"/outputs/{local_name}",
                        media_type="video" if media_type == "video" else "image",
                        format=fmt,
                        node_id=str(node_id),
                    )
                )

        return saved_outputs


async def queue_and_track_generation(
    comfyui_url: str,
    workflow_id: int,
    workflow_name: str,
    category_name: str,
    output_type: str,
    workflow_payload: dict[str, Any],
    submitted_inputs: dict[str, Any],
    client_id: str,
) -> str:
    ws_url = to_ws_url(comfyui_url, client_id)
    base_url = comfyui_url.rstrip("/")

    ws_conn = await websockets.connect(ws_url, open_timeout=6, ping_interval=20, ping_timeout=20)
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            prompt_resp = await client.post(
                f"{base_url}/prompt",
                json={"prompt": workflow_payload, "client_id": client_id},
            )
            if prompt_resp.status_code >= 400:
                raise RuntimeError(
                    f"ComfyUI rejected prompt ({prompt_resp.status_code}): {prompt_resp.text}"
                )
            prompt_id = str(prompt_resp.json()["prompt_id"])
    except Exception:
        await ws_conn.close()
        raise

    started_at = time.monotonic()
    asyncio.create_task(
        _watch_ws_until_done(
            ws_conn=ws_conn,
            comfyui_url=base_url,
            prompt_id=prompt_id,
            client_id=client_id,
            workflow_id=workflow_id,
            workflow_name=workflow_name,
            category_name=category_name,
            output_type=output_type,
            workflow_payload=workflow_payload,
            submitted_inputs=submitted_inputs,
            started_at=started_at,
        )
    )
    return prompt_id


async def _watch_ws_until_done(
    ws_conn: Any,
    comfyui_url: str,
    prompt_id: str,
    client_id: str,
    workflow_id: int,
    workflow_name: str,
    category_name: str,
    output_type: str,
    workflow_payload: dict[str, Any],
    submitted_inputs: dict[str, Any],
    started_at: float,
) -> None:
    await sse_hub.emit(
        client_id,
        {
            "type": "status",
            "client_id": client_id,
            "prompt_id": prompt_id,
            "message": "Prompt queued on ComfyUI",
        },
    )

    try:
        async for raw_msg in ws_conn:
            if not isinstance(raw_msg, str):
                continue
            try:
                parsed = json.loads(raw_msg)
            except json.JSONDecodeError:
                continue

            msg_type = parsed.get("type")
            data = parsed.get("data") or {}
            msg_prompt_id = data.get("prompt_id")
            if msg_prompt_id and str(msg_prompt_id) != prompt_id:
                continue

            if msg_type == "executing":
                node_id = data.get("node")
                if node_id is None:
                    break
                node_id_str = str(node_id)
                node_meta = workflow_payload.get(node_id_str, {})
                node_title = (
                    node_meta.get("_meta", {}).get("title")
                    or node_meta.get("class_type")
                    or f"Node {node_id_str}"
                )
                await sse_hub.emit(
                    client_id,
                    {
                        "type": "executing",
                        "client_id": client_id,
                        "prompt_id": prompt_id,
                        "node_id": node_id_str,
                        "node_title": node_title,
                        "message": f"Executing {node_title}",
                    },
                )
            elif msg_type == "progress":
                value = int(data.get("value", 0))
                max_val = int(data.get("max", 1))
                percent = round((value / max_val) * 100) if max_val > 0 else 0
                await sse_hub.emit(
                    client_id,
                    {
                        "type": "progress",
                        "client_id": client_id,
                        "prompt_id": prompt_id,
                        "value": value,
                        "max": max_val,
                        "percent": percent,
                    },
                )
            elif msg_type == "execution_error":
                err_msg = str(data.get("exception_message") or "ComfyUI execution error")
                await sse_hub.emit(
                    client_id,
                    {
                        "type": "error",
                        "client_id": client_id,
                        "prompt_id": prompt_id,
                        "message": err_msg,
                    },
                )
                return

        outputs = await download_comfy_outputs(comfyui_url, prompt_id)
        duration_ms = int((time.monotonic() - started_at) * 1000)
        has_video = any(o.media_type == "video" for o in outputs)
        primary_media_type = "video" if (output_type == "video" or has_video) else "image"
        primary_url = outputs[0].url if outputs else ""

        with Session(engine) as session:
            record = GenerationRecord(
                workflow_id=workflow_id,
                workflow_name=workflow_name,
                category_name=category_name,
                prompt_id=prompt_id,
                client_id=client_id,
                status="completed",
                media_type=primary_media_type,
                primary_output_url=primary_url,
                outputs_json=json.dumps([o.model_dump() for o in outputs]),
                submitted_inputs_json=json.dumps(submitted_inputs),
                duration_ms=duration_ms,
            )
            session.add(record)
            session.commit()
            session.refresh(record)

            gen_payload = {
                "id": record.id,
                "workflow_id": record.workflow_id,
                "workflow_name": record.workflow_name,
                "category_name": record.category_name,
                "prompt_id": record.prompt_id,
                "client_id": record.client_id,
                "status": record.status,
                "media_type": record.media_type,
                "primary_output_url": record.primary_output_url,
                "outputs": [o.model_dump() for o in outputs],
                "submitted_inputs": submitted_inputs,
                "duration_ms": record.duration_ms,
                "error_message": record.error_message,
                "created_at": record.created_at,
            }

        await sse_hub.emit(
            client_id,
            {
                "type": "completed",
                "client_id": client_id,
                "prompt_id": prompt_id,
                "percent": 100,
                "message": "Generation complete",
                "generation": gen_payload,
            },
        )
    except Exception as exc:
        await sse_hub.emit(
            client_id,
            {
                "type": "error",
                "client_id": client_id,
                "prompt_id": prompt_id,
                "message": str(exc),
            },
        )
    finally:
        await ws_conn.close()

import asyncio
import json
import re
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
from app.schemas import InputMediaInfo, OutputFileInfo


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


def safe_dir_segment(value: str, fallback: str = "uncategorized") -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f\s]+', "-", str(value or "").strip())
    cleaned = re.sub(r"-+", "-", cleaned).strip(".-")
    return cleaned or fallback


def resolve_safe_outputs_path(rel_path: str) -> Path | None:
    cleaned = str(rel_path or "").lstrip("/\\")
    if not cleaned:
        return None
    outputs_root = settings.outputs_path.resolve()
    resolved = (outputs_root / cleaned).resolve()
    try:
        resolved.relative_to(outputs_root)
    except ValueError:
        return None
    if resolved == outputs_root:
        return None
    return resolved


def guess_mime_type(filename: str) -> str:
    lower = filename.lower()
    if lower.endswith(".png"):
        return "image/png"
    if lower.endswith((".jpg", ".jpeg")):
        return "image/jpeg"
    if lower.endswith(".webp"):
        return "image/webp"
    if lower.endswith(".gif"):
        return "image/gif"
    if lower.endswith(".mp4"):
        return "video/mp4"
    if lower.endswith(".webm"):
        return "video/webm"
    if lower.endswith(".mov"):
        return "video/quicktime"
    if lower.endswith(".mkv"):
        return "video/x-matroska"
    return "application/octet-stream"


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


async def download_comfy_outputs(
    comfyui_url: str,
    prompt_id: str,
    preferred_output_node_ids: list[str] | None = None,
    category_name: str = "uncategorized",
) -> list[OutputFileInfo]:
    url = comfyui_url.rstrip("/")
    async with httpx.AsyncClient(timeout=120.0) as client:
        hist_resp = await client.get(f"{url}/history/{quote(prompt_id)}")
        if hist_resp.status_code >= 400:
            raise RuntimeError(f"Failed to fetch ComfyUI history ({hist_resp.status_code})")
        history_data = hist_resp.json()

        entry = history_data.get(prompt_id, {})
        outputs_map = entry.get("outputs", {})
        preferred_set = {str(nid) for nid in (preferred_output_node_ids or [])}
        all_items = list(outputs_map.items())
        matching_preferred = (
            [
                (nid, out)
                for nid, out in all_items
                if str(nid) in preferred_set
                and isinstance(out, dict)
                and any(isinstance(out.get(k), list) and out.get(k) for k in ("videos", "gifs", "images"))
            ]
            if preferred_set
            else []
        )
        entries_to_download = matching_preferred if matching_preferred else all_items

        cat_dir = safe_dir_segment(category_name, "uncategorized")
        prompt_dir_seg = safe_dir_segment(prompt_id, "unknown")
        target_dir = settings.outputs_path / cat_dir / prompt_dir_seg
        target_dir.mkdir(parents=True, exist_ok=True)

        saved_outputs: list[OutputFileInfo] = []

        for node_id, node_output in entries_to_download:
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
                local_path = target_dir / local_name
                local_path.write_bytes(view_resp.content)

                rel_filename = f"{cat_dir}/{prompt_dir_seg}/{local_name}"
                fmt = str(item.get("format") or ext.lstrip("."))
                media_type = detect_media_type(orig_name, fmt)
                saved_outputs.append(
                    OutputFileInfo(
                        filename=rel_filename,
                        original_filename=orig_name,
                        url=f"/outputs/{quote(cat_dir, safe='')}/{quote(prompt_dir_seg, safe='')}/{quote(local_name, safe='')}",
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
    output_node_ids: list[str] | None = None,
    pending_input_media: list[dict[str, Any]] | None = None,
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

    cat_dir = safe_dir_segment(category_name, "uncategorized")
    prompt_dir_seg = safe_dir_segment(prompt_id, "unknown")
    saved_input_media: list[InputMediaInfo] = []
    if pending_input_media:
        inputs_dir = settings.outputs_path / cat_dir / prompt_dir_seg / "inputs"
        inputs_dir.mkdir(parents=True, exist_ok=True)
        for item in pending_input_media:
            orig_name = str(item.get("original_filename") or "input.png")
            media_type = "video" if item.get("media_type") == "video" else "image"
            ext = Path(orig_name).suffix or (".mp4" if media_type == "video" else ".png")
            field_slug = safe_dir_segment(str(item.get("field_name") or "input"), "input")
            local_name = f"{field_slug}_{int(time.time() * 1000)}_{secrets.token_hex(3)}{ext}"
            local_path = inputs_dir / local_name
            local_path.write_bytes(item["content"])
            saved_input_media.append(
                InputMediaInfo(
                    key=str(item["key"]),
                    node_id=str(item["node_id"]),
                    field_name=str(item["field_name"]),
                    label=item.get("label"),
                    filename=f"{cat_dir}/{prompt_dir_seg}/inputs/{local_name}",
                    original_filename=orig_name,
                    comfy_name=str(item["comfy_name"]),
                    url=f"/outputs/{quote(cat_dir, safe='')}/{quote(prompt_dir_seg, safe='')}/inputs/{quote(local_name, safe='')}",
                    media_type=media_type,
                )
            )

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
            output_node_ids=output_node_ids,
            input_media=saved_input_media,
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
    output_node_ids: list[str] | None = None,
    input_media: list[InputMediaInfo] | None = None,
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

        outputs = await download_comfy_outputs(
            comfyui_url, prompt_id, output_node_ids, category_name
        )
        duration_ms = int((time.monotonic() - started_at) * 1000)
        has_video = any(o.media_type == "video" for o in outputs)
        primary_media_type = "video" if (output_type == "video" or has_video) else "image"
        primary_url = outputs[0].url if outputs else ""
        input_media_list = [m.model_dump() for m in (input_media or [])]

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
                input_media_json=json.dumps(input_media_list),
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
                "input_media": input_media_list,
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

import asyncio
import json
import re
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode, urlparse

import httpx
import websockets
from sqlmodel import Session

from app.config import settings
from app.database import engine
from app.media_metadata import extract_media_metadata_from_file
from app.models import GenerationRecord
from app.schemas import InputMediaInfo, OutputFileInfo, QueueStatusResponse, QueueTaskItem


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


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class QueueRegistry:
    def __init__(self) -> None:
        self._tasks: dict[str, dict[str, Any]] = {}

    def register(self, task: QueueTaskItem, started_monotonic: float) -> None:
        data = task.model_dump()
        data["_started_monotonic"] = started_monotonic
        self._tasks[task.prompt_id] = data
        if len(self._tasks) > 60:
            finished_keys = [
                pid
                for pid, item in self._tasks.items()
                if item.get("state") in {"completed", "failed", "cancelled"}
            ]
            for pid in finished_keys[: max(0, len(self._tasks) - 40)]:
                self._tasks.pop(pid, None)

    def update(self, prompt_id: str, **patch: Any) -> None:
        item = self._tasks.get(prompt_id)
        if not item:
            return
        item.update(patch)

    def get(self, prompt_id: str) -> dict[str, Any] | None:
        return self._tasks.get(prompt_id)

    def to_item(self, raw: dict[str, Any], **overrides: Any) -> QueueTaskItem:
        merged = {k: v for k, v in raw.items() if k != "_started_monotonic"}
        merged.update(overrides)
        return QueueTaskItem(**merged)

    def all_items(self) -> list[dict[str, Any]]:
        return list(self._tasks.values())


queue_registry = QueueRegistry()


def _build_queue_item_from_entry(
    entry: Any, state: str, position: int
) -> QueueTaskItem | None:
    if not isinstance(entry, list) or len(entry) < 2:
        return None
    try:
        queue_number = int(entry[0]) if entry[0] is not None else None
    except (TypeError, ValueError):
        queue_number = None
    prompt_id = str(entry[1] or "").strip()
    if not prompt_id:
        return None

    prompt_graph = entry[2] if len(entry) > 2 and isinstance(entry[2], dict) else {}
    node_count = len(prompt_graph)
    tracked = queue_registry.get(prompt_id)
    if tracked:
        return queue_registry.to_item(
            tracked,
            queue_number=queue_number,
            queue_position=position,
            state=state,
            node_count=tracked.get("node_count") or node_count,
        )

    return QueueTaskItem(
        prompt_id=prompt_id,
        client_id=None,
        queue_number=queue_number,
        queue_position=position,
        state="running" if state == "running" else "queued",
        workflow_id=None,
        workflow_name="External ComfyUI Job",
        category_name="External",
        source="external",
        node_count=node_count,
        submitted_inputs={},
    )


async def fetch_queue_status(comfyui_url: str) -> QueueStatusResponse:
    url = comfyui_url.rstrip("/")
    comfy_connected = False
    comfy_error: str | None = None
    running: list[QueueTaskItem] = []
    pending: list[QueueTaskItem] = []
    active_ids: set[str] = set()

    try:
        async with httpx.AsyncClient(timeout=3.5) as client:
            resp = await client.get(f"{url}/queue")
            if resp.status_code != 200:
                comfy_error = f"HTTP {resp.status_code} from {url}/queue"
            else:
                comfy_connected = True
                payload = resp.json()
                raw_running = payload.get("queue_running") or []
                raw_pending = payload.get("queue_pending") or []
                if isinstance(raw_running, list):
                    for entry in raw_running:
                        item = _build_queue_item_from_entry(entry, "running", 0)
                        if item:
                            active_ids.add(item.prompt_id)
                            running.append(item)
                if isinstance(raw_pending, list):
                    for idx, entry in enumerate(raw_pending):
                        item = _build_queue_item_from_entry(entry, "queued", idx + 1)
                        if item:
                            active_ids.add(item.prompt_id)
                            pending.append(item)
    except Exception as exc:
        comfy_error = str(exc)

    if not comfy_connected:
        for raw in queue_registry.all_items():
            pid = str(raw.get("prompt_id") or "")
            if not pid or pid in active_ids:
                continue
            if raw.get("state") == "running":
                active_ids.add(pid)
                running.append(queue_registry.to_item(raw))
            elif raw.get("state") == "queued":
                active_ids.add(pid)
                pending.append(
                    queue_registry.to_item(raw, queue_position=len(pending) + 1)
                )

    recent_raw = [
        raw
        for raw in queue_registry.all_items()
        if str(raw.get("prompt_id") or "") not in active_ids
        and raw.get("state") in {"completed", "failed", "cancelled"}
    ]
    recent_raw.sort(
        key=lambda x: str(x.get("finished_at") or x.get("started_at") or ""),
        reverse=True,
    )
    recent = [queue_registry.to_item(raw) for raw in recent_raw[:20]]

    return QueueStatusResponse(
        comfyui_url=url,
        comfy_connected=comfy_connected,
        comfy_error=comfy_error,
        running=running,
        pending=pending,
        recent=recent,
        fetched_at=_utc_iso(),
    )


async def interrupt_comfy_queue(comfyui_url: str) -> None:
    url = comfyui_url.rstrip("/")
    async with httpx.AsyncClient(timeout=6.0) as client:
        resp = await client.post(f"{url}/interrupt")
        if resp.status_code >= 400:
            raise RuntimeError(
                f"ComfyUI interrupt failed ({resp.status_code}): {resp.text}"
            )


async def cancel_comfy_queued_task(comfyui_url: str, prompt_id: str) -> None:
    url = comfyui_url.rstrip("/")
    async with httpx.AsyncClient(timeout=6.0) as client:
        resp = await client.post(f"{url}/queue", json={"delete": [prompt_id]})
        if resp.status_code >= 400:
            raise RuntimeError(
                f"ComfyUI cancel failed ({resp.status_code}): {resp.text}"
            )
    existing = queue_registry.get(prompt_id)
    if existing:
        started_mono = existing.get("_started_monotonic")
        duration_ms = (
            int((time.monotonic() - started_mono) * 1000)
            if isinstance(started_mono, (int, float))
            else None
        )
        queue_registry.update(
            prompt_id,
            state="cancelled",
            error_message="Removed from queue",
            finished_at=_utc_iso(),
            duration_ms=duration_ms,
        )


async def clear_comfy_pending_queue(comfyui_url: str) -> None:
    url = comfyui_url.rstrip("/")
    async with httpx.AsyncClient(timeout=6.0) as client:
        resp = await client.post(f"{url}/queue", json={"clear": True})
        if resp.status_code >= 400:
            raise RuntimeError(
                f"ComfyUI queue clear failed ({resp.status_code}): {resp.text}"
            )
    now_iso = _utc_iso()
    for raw in queue_registry.all_items():
        if raw.get("state") == "queued":
            pid = str(raw["prompt_id"])
            started_mono = raw.get("_started_monotonic")
            duration_ms = (
                int((time.monotonic() - started_mono) * 1000)
                if isinstance(started_mono, (int, float))
                else None
            )
            queue_registry.update(
                pid,
                state="cancelled",
                error_message="Cleared from queue",
                finished_at=now_iso,
                duration_ms=duration_ms,
            )


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
                media_meta = extract_media_metadata_from_file(
                    local_path, media_type, cache_key=rel_filename
                )
                saved_outputs.append(
                    OutputFileInfo(
                        filename=rel_filename,
                        original_filename=orig_name,
                        url=f"/outputs/{quote(cat_dir, safe='')}/{quote(prompt_dir_seg, safe='')}/{quote(local_name, safe='')}",
                        media_type="video" if media_type == "video" else "image",
                        format=fmt,
                        node_id=str(node_id),
                        width=media_meta.get("width"),
                        height=media_meta.get("height"),
                        duration_seconds=media_meta.get("duration_seconds"),
                        file_size=media_meta.get("file_size"),
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
            rel_input_filename = f"{cat_dir}/{prompt_dir_seg}/inputs/{local_name}"
            input_meta = extract_media_metadata_from_file(
                local_path, media_type, cache_key=rel_input_filename
            )
            saved_input_media.append(
                InputMediaInfo(
                    key=str(item["key"]),
                    node_id=str(item["node_id"]),
                    field_name=str(item["field_name"]),
                    label=item.get("label"),
                    filename=rel_input_filename,
                    original_filename=orig_name,
                    comfy_name=str(item["comfy_name"]),
                    url=f"/outputs/{quote(cat_dir, safe='')}/{quote(prompt_dir_seg, safe='')}/inputs/{quote(local_name, safe='')}",
                    media_type=media_type,
                    width=input_meta.get("width"),
                    height=input_meta.get("height"),
                    duration_seconds=input_meta.get("duration_seconds"),
                    file_size=input_meta.get("file_size"),
                )
            )

    started_at = time.monotonic()
    queue_registry.register(
        QueueTaskItem(
            prompt_id=prompt_id,
            client_id=client_id,
            state="queued",
            workflow_id=workflow_id,
            workflow_name=workflow_name,
            category_name=category_name,
            source="comfycentre",
            node_count=len(workflow_payload),
            progress_percent=0,
            submitted_inputs=submitted_inputs,
            started_at=_utc_iso(),
        ),
        started_monotonic=started_at,
    )

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
                queue_registry.update(
                    prompt_id,
                    state="running",
                    current_node_id=node_id_str,
                    current_node_title=node_title,
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
                queue_registry.update(
                    prompt_id,
                    state="running",
                    step_value=value,
                    step_max=max_val,
                    progress_percent=percent,
                )
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
            elif msg_type == "execution_interrupted":
                err_msg = "Generation interrupted by user"
                queue_registry.update(
                    prompt_id,
                    state="cancelled",
                    error_message=err_msg,
                    finished_at=_utc_iso(),
                    duration_ms=int((time.monotonic() - started_at) * 1000),
                )
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
            elif msg_type == "execution_error":
                err_msg = str(data.get("exception_message") or "ComfyUI execution error")
                queue_registry.update(
                    prompt_id,
                    state="failed",
                    error_message=err_msg,
                    finished_at=_utc_iso(),
                    duration_ms=int((time.monotonic() - started_at) * 1000),
                )
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

        queue_registry.update(
            prompt_id,
            state="completed",
            progress_percent=100,
            current_node_id=None,
            current_node_title=None,
            outputs=[o.model_dump() for o in outputs],
            finished_at=_utc_iso(),
            duration_ms=duration_ms,
        )

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
        queue_registry.update(
            prompt_id,
            state="failed",
            error_message=str(exc),
            finished_at=_utc_iso(),
            duration_ms=int((time.monotonic() - started_at) * 1000),
        )
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

import asyncio
import copy
import json
import re
import uuid
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlmodel import Session, select
from starlette.datastructures import UploadFile

from app.comfy_client import (
    check_comfy_health,
    queue_and_track_generation,
    sse_hub,
    upload_media_to_comfyui,
)
from app.config import settings
from app.database import engine, get_session, init_db
from app.inspector import inspect_comfy_workflow
from app.models import (
    AppSetting,
    Category,
    GenerationRecord,
    WorkflowTemplate,
    utcnow_iso,
)
from app.schemas import (
    CategoryCreate,
    CategoryRead,
    CategoryUpdate,
    GenerationRead,
    OutputFileInfo,
    SettingsPayload,
    UIInputField,
    WorkflowCreate,
    WorkflowInspectRequest,
    WorkflowInspectResponse,
    WorkflowRead,
    WorkflowUpdate,
)
from app.seed import seed_database


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    with Session(engine) as session:
        seed_database(session)
    yield


app = FastAPI(title="ComfyCentre API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/outputs", StaticFiles(directory=str(settings.outputs_path)), name="outputs")


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower().strip()).strip("-")
    return slug or "category"


def get_comfyui_url(session: Session) -> str:
    row = session.get(AppSetting, "comfyui_url")
    return (row.value if row else settings.comfyui_url).rstrip("/")


def to_workflow_read(wf: WorkflowTemplate, category_name: str) -> WorkflowRead:
    ui_inputs_raw = json.loads(wf.ui_inputs_json)
    return WorkflowRead(
        id=wf.id or 0,
        name=wf.name,
        description=wf.description,
        category_id=wf.category_id,
        category_name=category_name,
        output_type=wf.output_type,  # type: ignore[arg-type]
        comfy_api_json=json.loads(wf.comfy_api_json),
        ui_inputs=[UIInputField(**item) for item in ui_inputs_raw],
        created_at=wf.created_at,
        updated_at=wf.updated_at,
    )


def to_generation_read(rec: GenerationRecord) -> GenerationRead:
    outputs_raw = json.loads(rec.outputs_json or "[]")
    return GenerationRead(
        id=rec.id or 0,
        workflow_id=rec.workflow_id,
        workflow_name=rec.workflow_name,
        category_name=rec.category_name,
        prompt_id=rec.prompt_id,
        client_id=rec.client_id,
        status=rec.status,  # type: ignore[arg-type]
        media_type=rec.media_type,  # type: ignore[arg-type]
        primary_output_url=rec.primary_output_url,
        outputs=[OutputFileInfo(**o) for o in outputs_raw],
        submitted_inputs=json.loads(rec.submitted_inputs_json or "{}"),
        duration_ms=rec.duration_ms,
        error_message=rec.error_message,
        created_at=rec.created_at,
    )


@app.get("/api/settings", response_model=SettingsPayload)
def read_settings(session: Session = Depends(get_session)):
    return SettingsPayload(comfyui_url=get_comfyui_url(session))


@app.put("/api/settings", response_model=SettingsPayload)
def update_settings(payload: SettingsPayload, session: Session = Depends(get_session)):
    cleaned = payload.comfyui_url.strip().rstrip("/")
    if not cleaned.startswith(("http://", "https://")):
        raise HTTPException(
            status_code=400, detail="COMFYUI_URL must start with http:// or https://"
        )
    row = session.get(AppSetting, "comfyui_url")
    if row:
        row.value = cleaned
    else:
        row = AppSetting(key="comfyui_url", value=cleaned)
        session.add(row)
    session.commit()
    return SettingsPayload(comfyui_url=cleaned)


@app.get("/api/health/comfyui")
async def health_comfyui(session: Session = Depends(get_session)):
    comfy_url = get_comfyui_url(session)
    return await check_comfy_health(comfy_url)


@app.get("/api/categories", response_model=list[CategoryRead])
def list_categories(session: Session = Depends(get_session)):
    rows = session.exec(
        select(Category).order_by(Category.sort_order, Category.name)
    ).all()
    return [CategoryRead(**r.model_dump()) for r in rows]


@app.post("/api/categories", response_model=CategoryRead, status_code=201)
def create_category(payload: CategoryCreate, session: Session = Depends(get_session)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Category name is required")
    cat = Category(
        name=name,
        slug=slugify(name),
        description=payload.description.strip(),
        sort_order=payload.sort_order,
    )
    session.add(cat)
    try:
        session.commit()
        session.refresh(cat)
    except Exception as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return CategoryRead(**cat.model_dump())


@app.put("/api/categories/{category_id}", response_model=CategoryRead)
def update_category(
    category_id: int,
    payload: CategoryUpdate,
    session: Session = Depends(get_session),
):
    cat = session.get(Category, category_id)
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    if payload.name is not None:
        cat.name = payload.name.strip()
        cat.slug = slugify(cat.name)
    if payload.description is not None:
        cat.description = payload.description.strip()
    if payload.sort_order is not None:
        cat.sort_order = payload.sort_order
    session.add(cat)
    session.commit()
    session.refresh(cat)
    return CategoryRead(**cat.model_dump())


@app.delete("/api/categories/{category_id}")
def delete_category(category_id: int, session: Session = Depends(get_session)):
    cat = session.get(Category, category_id)
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    session.delete(cat)
    session.commit()
    return {"deleted": True}


@app.post("/api/workflows/inspect", response_model=WorkflowInspectResponse)
def inspect_workflow(payload: WorkflowInspectRequest):
    nodes = inspect_comfy_workflow(payload.comfy_api_json)
    return WorkflowInspectResponse(nodes=nodes)


@app.get("/api/workflows", response_model=list[WorkflowRead])
def list_workflows(session: Session = Depends(get_session)):
    cats = {c.id: c.name for c in session.exec(select(Category)).all() if c.id is not None}
    rows = session.exec(select(WorkflowTemplate).order_by(WorkflowTemplate.name)).all()
    return [to_workflow_read(w, cats.get(w.category_id, "Uncategorized")) for w in rows]


@app.get("/api/workflows/{workflow_id}", response_model=WorkflowRead)
def get_workflow(workflow_id: int, session: Session = Depends(get_session)):
    wf = session.get(WorkflowTemplate, workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow template not found")
    cat = session.get(Category, wf.category_id)
    return to_workflow_read(wf, cat.name if cat else "Uncategorized")


@app.post("/api/workflows", response_model=WorkflowRead, status_code=201)
def create_workflow(payload: WorkflowCreate, session: Session = Depends(get_session)):
    cat = session.get(Category, payload.category_id)
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    wf = WorkflowTemplate(
        name=payload.name.strip(),
        description=payload.description.strip(),
        category_id=payload.category_id,
        output_type=payload.output_type,
        comfy_api_json=json.dumps(payload.comfy_api_json),
        ui_inputs_json=json.dumps([item.model_dump() for item in payload.ui_inputs]),
    )
    session.add(wf)
    session.commit()
    session.refresh(wf)
    return to_workflow_read(wf, cat.name)


@app.put("/api/workflows/{workflow_id}", response_model=WorkflowRead)
def update_workflow(
    workflow_id: int,
    payload: WorkflowUpdate,
    session: Session = Depends(get_session),
):
    wf = session.get(WorkflowTemplate, workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow template not found")
    if payload.name is not None:
        wf.name = payload.name.strip()
    if payload.description is not None:
        wf.description = payload.description.strip()
    if payload.category_id is not None:
        wf.category_id = payload.category_id
    if payload.output_type is not None:
        wf.output_type = payload.output_type
    if payload.comfy_api_json is not None:
        wf.comfy_api_json = json.dumps(payload.comfy_api_json)
    if payload.ui_inputs is not None:
        wf.ui_inputs_json = json.dumps([item.model_dump() for item in payload.ui_inputs])
    wf.updated_at = utcnow_iso()
    session.add(wf)
    session.commit()
    session.refresh(wf)
    cat = session.get(Category, wf.category_id)
    return to_workflow_read(wf, cat.name if cat else "Uncategorized")


@app.delete("/api/workflows/{workflow_id}")
def delete_workflow(workflow_id: int, session: Session = Depends(get_session)):
    wf = session.get(WorkflowTemplate, workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow template not found")
    session.delete(wf)
    session.commit()
    return {"deleted": True}


@app.get("/api/generations", response_model=list[GenerationRead])
def list_generations(
    media_type: Optional[str] = Query(default=None),
    workflow_id: Optional[int] = Query(default=None),
    search: Optional[str] = Query(default=None),
    session: Session = Depends(get_session),
):
    rows = session.exec(
        select(GenerationRecord).order_by(GenerationRecord.id.desc())  # type: ignore[union-attr]
    ).all()
    results = [to_generation_read(r) for r in rows]
    if media_type in {"image", "video"}:
        results = [r for r in results if r.media_type == media_type]
    if workflow_id is not None:
        results = [r for r in results if r.workflow_id == workflow_id]
    if search:
        q = search.strip().lower()
        results = [
            r
            for r in results
            if q
            in f"{r.workflow_name} {r.category_name} {json.dumps(r.submitted_inputs)}".lower()
        ]
    return results


@app.get("/api/generations/{generation_id}", response_model=GenerationRead)
def get_generation(generation_id: int, session: Session = Depends(get_session)):
    rec = session.get(GenerationRecord, generation_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Generation not found")
    return to_generation_read(rec)


@app.delete("/api/generations/{generation_id}")
def delete_generation(generation_id: int, session: Session = Depends(get_session)):
    rec = session.get(GenerationRecord, generation_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Generation not found")
    for out in json.loads(rec.outputs_json or "[]"):
        filename = out.get("filename")
        if filename:
            target = settings.outputs_path / filename
            if target.exists():
                target.unlink()
    session.delete(rec)
    session.commit()
    return {"deleted": True}


@app.get("/api/progress/{client_id}")
async def stream_progress(client_id: str, request: Request):
    queue = sse_hub.subscribe(client_id)

    async def event_generator():
        try:
            initial = {
                "type": "connected",
                "client_id": client_id,
                "message": "SSE stream ready",
            }
            yield f"data: {json.dumps(initial)}\n\n"

            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"data: {json.dumps(payload)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            sse_hub.unsubscribe(client_id, queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/generate", status_code=202)
async def generate_output(
    request: Request,
    session: Session = Depends(get_session),
):
    form = await request.form()
    workflow_id_raw = form.get("workflow_id")
    if not workflow_id_raw:
        raise HTTPException(status_code=400, detail="workflow_id is required")

    workflow_id = int(str(workflow_id_raw))
    client_id = str(form.get("client_id") or uuid.uuid4())
    inputs_json_raw = str(form.get("inputs_json") or "{}")

    wf = session.get(WorkflowTemplate, workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow template not found")
    cat = session.get(Category, wf.category_id)
    category_name = cat.name if cat else "Uncategorized"

    try:
        submitted_inputs: dict[str, Any] = json.loads(inputs_json_raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid inputs_json payload") from exc

    comfy_url = get_comfyui_url(session)
    workflow_copy: dict[str, Any] = copy.deepcopy(json.loads(wf.comfy_api_json))
    ui_inputs = [UIInputField(**item) for item in json.loads(wf.ui_inputs_json)]

    # 1. Forward uploaded media files to ComfyUI /upload/image
    for field_key, form_val in form.multi_items():
        if isinstance(form_val, UploadFile) and field_key.startswith("file:"):
            parts = field_key.split(":", 2)
            if len(parts) == 3:
                _, node_id, field_name = parts
                file_bytes = await form_val.read()
                try:
                    uploaded_name = await upload_media_to_comfyui(
                        comfy_url,
                        form_val.filename or "upload.png",
                        file_bytes,
                        form_val.content_type or "application/octet-stream",
                    )
                except Exception as exc:
                    await sse_hub.emit(
                        client_id,
                        {"type": "error", "client_id": client_id, "message": str(exc)},
                    )
                    raise HTTPException(status_code=502, detail=str(exc)) from exc

                if node_id in workflow_copy and isinstance(workflow_copy[node_id].get("inputs"), dict):
                    workflow_copy[node_id]["inputs"][field_name] = uploaded_name
                    submitted_inputs[f"{node_id}:{field_name}"] = uploaded_name

    # 2. Inject primitive form values into deep-copied workflow
    for field in ui_inputs:
        key = f"{field.node_id}:{field.field_name}"
        if key not in submitted_inputs and field.id not in submitted_inputs:
            continue
        raw_val = submitted_inputs.get(key, submitted_inputs.get(field.id))
        target_node = workflow_copy.get(field.node_id)
        if not isinstance(target_node, dict) or not isinstance(target_node.get("inputs"), dict):
            continue

        if field.value_type == "media":
            if isinstance(raw_val, str) and raw_val.strip():
                target_node["inputs"][field.field_name] = raw_val
        elif field.value_type == "int":
            target_node["inputs"][field.field_name] = int(round(float(raw_val)))
        elif field.value_type == "float":
            target_node["inputs"][field.field_name] = float(raw_val)
        elif field.value_type == "boolean":
            target_node["inputs"][field.field_name] = bool(raw_val)
        else:
            target_node["inputs"][field.field_name] = "" if raw_val is None else str(raw_val)

    # 3. Connect WebSocket & queue prompt on ComfyUI
    try:
        prompt_id = await queue_and_track_generation(
            comfyui_url=comfy_url,
            workflow_id=wf.id or workflow_id,
            workflow_name=wf.name,
            category_name=category_name,
            output_type=wf.output_type,
            workflow_payload=workflow_copy,
            submitted_inputs=submitted_inputs,
            client_id=client_id,
        )
    except Exception as exc:
        await sse_hub.emit(
            client_id,
            {"type": "error", "client_id": client_id, "message": str(exc)},
        )
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {"prompt_id": prompt_id, "client_id": client_id, "status": "queued"}

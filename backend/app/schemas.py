from typing import Any, Literal, Optional
from pydantic import BaseModel, Field

WidgetType = Literal[
    "text",
    "textarea",
    "number",
    "slider",
    "seed_randomizer",
    "checkbox",
    "select",
    "image_upload",
]

OutputMediaType = Literal["auto", "image", "video"]


class UIInputField(BaseModel):
    id: str
    node_id: str
    class_type: str
    field_name: str
    label: str
    widget: WidgetType
    value_type: Literal["string", "int", "float", "boolean", "media"]
    default_value: str | int | float | bool = ""
    min: Optional[float] = None
    max: Optional[float] = None
    step: Optional[float] = None
    options: Optional[list[str]] = None
    description: Optional[str] = None
    order: int = 1


class SettingsPayload(BaseModel):
    comfyui_url: str


class CategoryCreate(BaseModel):
    name: str
    description: str = ""
    sort_order: int = 0


class CategoryUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    sort_order: Optional[int] = None


class CategoryRead(BaseModel):
    id: int
    name: str
    slug: str
    description: str
    sort_order: int
    created_at: str


class WorkflowInspectRequest(BaseModel):
    comfy_api_json: dict[str, Any]


class InspectedInput(BaseModel):
    field_name: str
    value_type: Literal["string", "int", "float", "boolean", "media"]
    default_value: str | int | float | bool
    suggested_widget: WidgetType
    is_media_input: bool


class InspectedNode(BaseModel):
    node_id: str
    class_type: str
    title: str
    inputs: list[InspectedInput]


class ConversionStats(BaseModel):
    total_graph_nodes: int
    converted_api_nodes: int
    skipped_nodes: int


class AppInputHint(BaseModel):
    node_id: str
    field_name: str
    key: str
    title: str
    class_type: str
    mapped: bool
    reason: Optional[str] = None


class InspectedOutput(BaseModel):
    node_id: str
    class_type: str
    title: str
    media_type: Literal["image", "video"]
    format: str
    is_primary_app_output: bool = False


class WorkflowInspectResponse(BaseModel):
    nodes: list[InspectedNode]
    outputs: list[InspectedOutput] = Field(default_factory=list)
    app_inputs: list[AppInputHint] = Field(default_factory=list)
    source_format: Literal["api", "workflow"] = "api"
    converted_api_json: dict[str, Any] = Field(default_factory=dict)
    suggested_field_keys: list[str] = Field(default_factory=list)
    suggested_output_type: OutputMediaType = "auto"
    suggested_output_node_ids: list[str] = Field(default_factory=list)
    conversion_stats: Optional[ConversionStats] = None


class WorkflowCreate(BaseModel):
    name: str
    description: str = ""
    category_id: int
    output_type: OutputMediaType = "auto"
    output_node_ids: Optional[list[str]] = None
    comfy_api_json: dict[str, Any]
    ui_inputs: list[UIInputField] = Field(default_factory=list)


class WorkflowUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    category_id: Optional[int] = None
    output_type: Optional[OutputMediaType] = None
    output_node_ids: Optional[list[str]] = None
    comfy_api_json: Optional[dict[str, Any]] = None
    ui_inputs: Optional[list[UIInputField]] = None


class WorkflowRead(BaseModel):
    id: int
    name: str
    description: str
    category_id: int
    category_name: str
    output_type: OutputMediaType
    output_node_ids: list[str] = Field(default_factory=list)
    comfy_api_json: dict[str, Any]
    ui_inputs: list[UIInputField]
    created_at: str
    updated_at: str


class OutputFileInfo(BaseModel):
    filename: str
    original_filename: str
    url: str
    media_type: Literal["image", "video"]
    format: str
    node_id: str


class InputMediaInfo(BaseModel):
    key: str
    node_id: str
    field_name: str
    label: Optional[str] = None
    filename: str
    original_filename: str
    comfy_name: str
    url: str
    media_type: Literal["image", "video"]


class GenerationRead(BaseModel):
    id: int
    workflow_id: int
    workflow_name: str
    category_name: str
    prompt_id: str
    client_id: str
    status: Literal["completed", "failed", "running"]
    media_type: Literal["image", "video"]
    primary_output_url: str
    outputs: list[OutputFileInfo]
    input_media: list[InputMediaInfo] = Field(default_factory=list)
    submitted_inputs: dict[str, Any]
    duration_ms: int
    error_message: Optional[str] = None
    created_at: str


QueueTaskState = Literal["running", "queued", "completed", "failed", "cancelled"]


class QueueTaskItem(BaseModel):
    prompt_id: str
    client_id: Optional[str] = None
    queue_number: Optional[int] = None
    queue_position: Optional[int] = None
    state: QueueTaskState
    workflow_id: Optional[int] = None
    workflow_name: str
    category_name: str
    source: Literal["comfycentre", "external"] = "comfycentre"
    node_count: int = 0
    current_node_id: Optional[str] = None
    current_node_title: Optional[str] = None
    step_value: Optional[int] = None
    step_max: Optional[int] = None
    progress_percent: int = 0
    submitted_inputs: dict[str, Any] = Field(default_factory=dict)
    error_message: Optional[str] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    duration_ms: Optional[int] = None


class QueueStatusResponse(BaseModel):
    comfyui_url: str
    comfy_connected: bool
    comfy_error: Optional[str] = None
    running: list[QueueTaskItem] = Field(default_factory=list)
    pending: list[QueueTaskItem] = Field(default_factory=list)
    recent: list[QueueTaskItem] = Field(default_factory=list)
    fetched_at: str


class QueueCancelRequest(BaseModel):
    prompt_id: str

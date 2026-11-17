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


class WorkflowInspectResponse(BaseModel):
    nodes: list[InspectedNode]


class WorkflowCreate(BaseModel):
    name: str
    description: str = ""
    category_id: int
    output_type: OutputMediaType = "auto"
    comfy_api_json: dict[str, Any]
    ui_inputs: list[UIInputField] = Field(default_factory=list)


class WorkflowUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    category_id: Optional[int] = None
    output_type: Optional[OutputMediaType] = None
    comfy_api_json: Optional[dict[str, Any]] = None
    ui_inputs: Optional[list[UIInputField]] = None


class WorkflowRead(BaseModel):
    id: int
    name: str
    description: str
    category_id: int
    category_name: str
    output_type: OutputMediaType
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
    submitted_inputs: dict[str, Any]
    duration_ms: int
    error_message: Optional[str] = None
    created_at: str

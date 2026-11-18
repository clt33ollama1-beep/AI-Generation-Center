from datetime import datetime, timezone
from typing import Optional
from sqlmodel import Field, SQLModel


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


class AppSetting(SQLModel, table=True):
    __tablename__ = "settings"

    key: str = Field(primary_key=True)
    value: str


class Category(SQLModel, table=True):
    __tablename__ = "categories"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(unique=True, index=True)
    slug: str = Field(unique=True, index=True)
    description: str = Field(default="")
    sort_order: int = Field(default=0)
    created_at: str = Field(default_factory=utcnow_iso)


class WorkflowTemplate(SQLModel, table=True):
    __tablename__ = "workflows"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    description: str = Field(default="")
    category_id: int = Field(foreign_key="categories.id", ondelete="CASCADE")
    output_type: str = Field(default="auto")
    output_node_ids_json: str = Field(default="[]")
    comfy_api_json: str
    ui_inputs_json: str
    created_at: str = Field(default_factory=utcnow_iso)
    updated_at: str = Field(default_factory=utcnow_iso)


class GenerationRecord(SQLModel, table=True):
    __tablename__ = "generations"

    id: Optional[int] = Field(default=None, primary_key=True)
    workflow_id: int = Field(index=True)
    workflow_name: str
    category_name: str
    prompt_id: str = Field(index=True)
    client_id: str
    status: str = Field(default="completed")
    media_type: str = Field(default="image")
    primary_output_url: str = Field(default="")
    outputs_json: str = Field(default="[]")
    input_media_json: str = Field(default="[]")
    submitted_inputs_json: str = Field(default="{}")
    duration_ms: int = Field(default=0)
    error_message: Optional[str] = Field(default=None)
    created_at: str = Field(default_factory=utcnow_iso)

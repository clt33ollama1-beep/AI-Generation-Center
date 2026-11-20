from typing import Any
from app.schemas import InspectedInput, InspectedNode, WidgetType

MEDIA_NODE_TYPES = {
    "LoadImage",
    "LoadImageMask",
    "LoadImageGoohai",
    "VHS_LoadVideo",
    "VHS_LoadVideoPath",
    "VHS_LoadImages",
    "LoadVideo",
}


def is_node_link_array(value: Any) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[0], (str, int))
        and isinstance(value[1], int)
        and not isinstance(value[1], bool)
    )


def inspect_comfy_workflow(workflow: dict[str, Any]) -> list[InspectedNode]:
    inspected_nodes: list[InspectedNode] = []

    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type")
        node_inputs = node.get("inputs")
        if not isinstance(class_type, str) or not isinstance(node_inputs, dict):
            continue

        meta = node.get("_meta")
        title = (
            meta.get("title")
            if isinstance(meta, dict) and isinstance(meta.get("title"), str)
            else class_type
        )
        is_media_node = class_type in MEDIA_NODE_TYPES
        parsed_inputs: list[InspectedInput] = []

        for field_name, raw_val in node_inputs.items():
            if is_node_link_array(raw_val):
                continue
            if isinstance(raw_val, (dict, list)):
                continue

            lower_field = field_name.lower()
            is_media_field = (
                is_media_node and lower_field in {"image", "video", "file"}
            ) or lower_field in {"image_path", "video_path"}

            default_val: str | int | float | bool = "" if raw_val is None else raw_val
            suggested_widget: WidgetType = "text"

            if is_media_field:
                value_type = "media"
                suggested_widget = "image_upload"
            elif isinstance(raw_val, bool):
                value_type = "boolean"
                suggested_widget = "checkbox"
            elif isinstance(raw_val, int):
                value_type = "int"
                suggested_widget = "seed_randomizer" if "seed" in lower_field else "number"
            elif isinstance(raw_val, float):
                value_type = "float"
                suggested_widget = "number"
            else:
                value_type = "string"
                str_val = str(default_val)
                if (
                    lower_field == "text"
                    or "prompt" in lower_field
                    or "multiline" in class_type.lower()
                    or len(str_val) > 48
                ):
                    suggested_widget = "textarea"
                else:
                    suggested_widget = "text"

            parsed_inputs.append(
                InspectedInput(
                    field_name=field_name,
                    value_type=value_type,
                    default_value=default_val,
                    suggested_widget=suggested_widget,
                    is_media_input=is_media_field,
                )
            )

        if parsed_inputs:
            inspected_nodes.append(
                InspectedNode(
                    node_id=str(node_id),
                    class_type=class_type,
                    title=title,
                    inputs=parsed_inputs,
                )
            )

    def sort_key(n: InspectedNode) -> tuple[int, str]:
        try:
            return (0, f"{int(n.node_id):010d}")
        except ValueError:
            return (1, n.node_id)

    return sorted(inspected_nodes, key=sort_key)

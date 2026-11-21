import asyncio
from typing import Any, Optional
from urllib.parse import quote

import httpx

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

FALLBACK_COMBO_OPTIONS: dict[str, list[str]] = {
    "sampler_name": [
        "euler",
        "euler_ancestral",
        "heun",
        "heunpp2",
        "dpm_2",
        "dpm_2_ancestral",
        "lms",
        "dpm_fast",
        "dpm_adaptive",
        "dpmpp_2s_ancestral",
        "dpmpp_sde",
        "dpmpp_sde_gpu",
        "dpmpp_2m",
        "dpmpp_2m_sde",
        "dpmpp_2m_sde_gpu",
        "dpmpp_3m_sde",
        "dpmpp_3m_sde_gpu",
        "ddpm",
        "lcm",
        "ipndm",
        "ipndm_v",
        "deis",
        "res_multistep",
        "ddim",
        "uni_pc",
        "uni_pc_bh2",
    ],
    "scheduler": [
        "normal",
        "karras",
        "exponential",
        "sgm_uniform",
        "simple",
        "ddim_uniform",
        "beta",
        "linear_quadratic",
        "kl_optimal",
    ],
    "upscale_method": [
        "nearest-exact",
        "bilinear",
        "area",
        "bicubic",
        "lanczos",
    ],
    "crop": ["disabled", "center"],
    "pix_fmt": ["yuv420p", "yuv420p10le", "yuva420p"],
    "weight_dtype": ["default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"],
    "device": ["default", "cpu", "cuda"],
}

FALLBACK_SELECTOR_FIELDS = {
    "ckpt_name",
    "vae_name",
    "lora_name",
    "lora_01",
    "lora_02",
    "lora_03",
    "model_name",
    "control_net_name",
    "clip_name",
    "clip_name1",
    "clip_name2",
    "clip_name3",
    "unet_name",
    "upscale_model",
    "style_model_name",
    "ipadapter_file",
    "clip_vision",
}


def is_node_link_array(value: Any) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[0], (str, int))
        and isinstance(value[1], int)
        and not isinstance(value[1], bool)
    )


async def fetch_comfy_object_info(
    comfyui_url: str, class_types: list[str]
) -> dict[str, dict[str, Any]]:
    base_url = (comfyui_url or "").strip().rstrip("/")
    unique_types = [ct for ct in dict.fromkeys(class_types) if ct]
    if not base_url or not unique_types:
        return {}

    result: dict[str, dict[str, Any]] = {}
    try:
        async with httpx.AsyncClient(timeout=2.2) as client:
            async def _fetch_one(ct: str) -> tuple[str, Optional[dict[str, Any]]]:
                try:
                    resp = await client.get(f"{base_url}/object_info/{quote(ct, safe='')}")
                    if resp.status_code != 200:
                        return ct, None
                    payload = resp.json()
                    if not isinstance(payload, dict):
                        return ct, None
                    if ct in payload and isinstance(payload[ct], dict):
                        return ct, payload[ct]
                    if isinstance(payload.get("input"), dict):
                        return ct, payload
                except Exception:
                    return ct, None
                return ct, None

            responses = await asyncio.gather(*(_fetch_one(ct) for ct in unique_types))
            for ct, node_def in responses:
                if node_def is not None:
                    result[ct] = node_def
    except Exception:
        return {}
    return result


def _dedupe_options(raw_items: list[Any], default_val: Any) -> list[str]:
    seen: set[str] = set()
    opts: list[str] = []
    for item in raw_items:
        if item is None or isinstance(item, (dict, list)):
            continue
        s = str(item)
        if s not in seen:
            seen.add(s)
            opts.append(s)

    if default_val is not None and not isinstance(default_val, bool):
        default_str = str(default_val)
        if default_str and default_str not in seen:
            opts.insert(0, default_str)
    return opts


def _resolve_combo_options(
    class_type: str,
    field_name: str,
    default_val: Any,
    object_info: dict[str, dict[str, Any]],
) -> Optional[list[str]]:
    node_def = object_info.get(class_type)
    if isinstance(node_def, dict):
        inp_groups = node_def.get("input")
        if isinstance(inp_groups, dict):
            for group_name in ("required", "optional"):
                group = inp_groups.get(group_name)
                if not isinstance(group, dict) or field_name not in group:
                    continue
                spec = group.get(field_name)
                if isinstance(spec, list) and len(spec) >= 1:
                    if isinstance(spec[0], list):
                        return _dedupe_options(spec[0], default_val)
                    if (
                        spec[0] == "COMBO"
                        and len(spec) >= 2
                        and isinstance(spec[1], dict)
                        and isinstance(spec[1].get("options"), list)
                    ):
                        return _dedupe_options(spec[1]["options"], default_val)
                return None

    lower_field = field_name.lower()
    if lower_field in FALLBACK_COMBO_OPTIONS:
        return _dedupe_options(FALLBACK_COMBO_OPTIONS[lower_field], default_val)

    if lower_field == "format" and (
        class_type == "VHS_VideoCombine"
        or (isinstance(default_val, str) and ("/" in default_val or default_val.lower() in {"gif", "webp", "mp4", "webm"}))
    ):
        return _dedupe_options(
            [
                "video/h264-mp4",
                "video/h265-mp4",
                "video/webm",
                "video/prores",
                "image/gif",
                "image/webp",
            ],
            default_val,
        )

    if lower_field in FALLBACK_SELECTOR_FIELDS and isinstance(default_val, str) and default_val.strip():
        return [default_val]

    return None


def inspect_comfy_workflow(
    workflow: dict[str, Any],
    object_info: Optional[dict[str, dict[str, Any]]] = None,
) -> list[InspectedNode]:
    inspected_nodes: list[InspectedNode] = []
    node_schemas = object_info or {}

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
            combo_options: Optional[list[str]] = None

            if is_media_field:
                value_type = "media"
                suggested_widget = "image_upload"
            elif isinstance(raw_val, bool):
                value_type = "boolean"
                suggested_widget = "checkbox"
            else:
                combo_options = _resolve_combo_options(
                    class_type, field_name, default_val, node_schemas
                )
                if isinstance(raw_val, int):
                    value_type = "int"
                    if combo_options is not None:
                        suggested_widget = "select"
                    else:
                        suggested_widget = "seed_randomizer" if "seed" in lower_field else "number"
                elif isinstance(raw_val, float):
                    value_type = "float"
                    suggested_widget = "select" if combo_options is not None else "number"
                else:
                    value_type = "string"
                    if combo_options is not None:
                        suggested_widget = "select"
                    else:
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
                    options=combo_options,
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

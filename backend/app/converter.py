import json
from typing import Any
from urllib.parse import unquote


VIRTUAL_NODE_TYPES = {
    "Note",
    "MarkdownNote",
    "Label (rgthree)",
    "Fast Groups Bypasser (rgthree)",
    "Fast Groups Muter (rgthree)",
    "Fast Actions Button (rgthree)",
    "Bookmark (rgthree)",
    "SetNode",
    "GetNode",
    "Reroute",
    "PrimitiveNode",
}

FRONTEND_WIDGET_KEYS = {
    "control_after_generate",
    "upload",
    "rgthree_comparer",
    "PowerLoraLoaderHeaderWidget",
    "➕ Add Lora",
}

SEED_CONTROL_VALUES = {"fixed", "increment", "decrement", "randomize"}

VIDEO_OUTPUT_NODE_TYPES = {
    "VHS_VideoCombine",
    "SaveVideo",
    "SaveWEBM",
    "SaveAnimatedWEBP",
    "SaveAnimatedPNG",
}

IMAGE_OUTPUT_NODE_TYPES = {
    "SaveImage",
    "SaveImageAdvanced",
    "PreviewImage",
    "Image Comparer (rgthree)",
}

TEXT_OUTPUT_NODE_TYPES = {
    "ShowText|pysssss",
    "ShowText",
    "Show Text",
    "Display Text (rgthree)",
    "DisplayText",
    "PreviewText",
    "PreviewTextNode",
    "SaveText",
    "SaveText|pysssss",
    "SaveTextFile",
    "PreviewAny",
    "easy showAnything",
    "DisplayAny",
    "StringOutput",
    "OutputString",
    "Text Output",
}

PRIMARY_SINK_NODE_TYPES = {
    "SaveImage",
    "SaveImageAdvanced",
    "VHS_VideoCombine",
    "SaveVideo",
    "SaveWEBM",
    "SaveAnimatedWEBP",
    "SaveAnimatedPNG",
    "ShowText|pysssss",
    "ShowText",
    "Show Text",
    "Display Text (rgthree)",
    "DisplayText",
    "PreviewText",
    "PreviewTextNode",
    "SaveText",
    "SaveText|pysssss",
    "SaveTextFile",
    "StringOutput",
    "OutputString",
    "Text Output",
}


def is_comfy_graph_workflow(payload: Any) -> bool:
    return (
        isinstance(payload, dict)
        and isinstance(payload.get("nodes"), list)
        and isinstance(payload.get("links"), list)
    )


def _get_set_get_constant_name(node: dict[str, Any]) -> str:
    named = node.get("widgets_values_named")
    if isinstance(named, dict) and isinstance(named.get("Constant"), str):
        return named["Constant"]
    wv = node.get("widgets_values")
    if isinstance(wv, list) and wv and isinstance(wv[0], str):
        return wv[0]
    title = node.get("title") or ""
    if title.startswith("Set_"):
        return title[4:]
    if title.startswith("Get_"):
        return title[4:]
    return title


def _classify_output_node(
    node_id: str, node: dict[str, Any], is_primary_app_output: bool
) -> dict[str, Any]:
    class_type = str(node.get("class_type", ""))
    raw_inputs = node.get("inputs")
    inputs = raw_inputs if isinstance(raw_inputs, dict) else {}
    raw_format = inputs.get("format") if isinstance(inputs.get("format"), str) else ""
    fmt_lower = raw_format.lower()

    media_type = "image"
    fmt = raw_format or "png"
    if (
        class_type in VIDEO_OUTPUT_NODE_TYPES
        or fmt_lower.startswith("video/")
        or fmt_lower in {"mp4", "webm", "gif", "webp"}
    ):
        media_type = "video"
        if not raw_format:
            if class_type == "SaveWEBM":
                fmt = "webm"
            elif class_type == "SaveAnimatedWEBP":
                fmt = "webp"
            elif class_type == "SaveAnimatedPNG":
                fmt = "apng"
            else:
                fmt = "mp4"
    elif (
        class_type in TEXT_OUTPUT_NODE_TYPES
        or fmt_lower.startswith("text/")
        or fmt_lower in {"txt", "md", "markdown", "json", "csv", "srt", "vtt"}
    ):
        media_type = "text"
        fmt = raw_format or "txt"

    meta = node.get("_meta")
    title = (
        meta.get("title")
        if isinstance(meta, dict) and isinstance(meta.get("title"), str)
        else class_type
    )

    return {
        "node_id": node_id,
        "class_type": class_type,
        "title": title,
        "media_type": media_type,
        "format": fmt,
        "is_primary_app_output": is_primary_app_output,
    }


def extract_workflow_outputs(
    api_workflow: dict[str, Any], linear_output_node_ids: list[str] | None = None
) -> dict[str, Any]:
    linear_ids = [str(i) for i in (linear_output_node_ids or [])]
    primary_set = set(linear_ids)
    outputs: list[dict[str, Any]] = []
    seen: set[str] = set()

    for node_id in linear_ids:
        node = api_workflow.get(node_id)
        if isinstance(node, dict) and node.get("class_type"):
            outputs.append(_classify_output_node(node_id, node, True))
            seen.add(node_id)

    def sort_key(nid: str) -> tuple[int, str]:
        try:
            return (0, f"{int(nid):010d}")
        except ValueError:
            return (1, nid)

    for node_id in sorted(api_workflow.keys(), key=sort_key):
        if node_id in seen:
            continue
        node = api_workflow.get(node_id)
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type")
        if (
            class_type in VIDEO_OUTPUT_NODE_TYPES
            or class_type in IMAGE_OUTPUT_NODE_TYPES
            or class_type in TEXT_OUTPUT_NODE_TYPES
        ):
            outputs.append(_classify_output_node(node_id, node, node_id in primary_set))
            seen.add(node_id)

    primary_outputs = [o for o in outputs if o["is_primary_app_output"]]
    effective_outputs = (
        primary_outputs
        if primary_outputs
        else [o for o in outputs if o["class_type"] in PRIMARY_SINK_NODE_TYPES]
    )

    suggested_output_type = "auto"
    if any(o["media_type"] == "video" for o in effective_outputs):
        suggested_output_type = "video"
    elif any(o["media_type"] == "image" for o in effective_outputs):
        suggested_output_type = "image"
    elif any(o["media_type"] == "text" for o in effective_outputs):
        suggested_output_type = "text"

    suggested_output_node_ids = (
        [o["node_id"] for o in primary_outputs]
        if primary_outputs
        else [o["node_id"] for o in outputs if o["class_type"] in PRIMARY_SINK_NODE_TYPES]
    )

    return {
        "outputs": outputs,
        "suggested_output_type": suggested_output_type,
        "suggested_output_node_ids": suggested_output_node_ids,
    }


def convert_comfy_graph_to_api(graph: dict[str, Any]) -> dict[str, Any]:
    raw_nodes: list[dict[str, Any]] = graph.get("nodes", [])
    raw_links: list[list[Any]] = graph.get("links", [])

    nodes_by_id: dict[str, dict[str, Any]] = {}
    for node in raw_nodes:
        if isinstance(node, dict) and node.get("id") is not None:
            nodes_by_id[str(node["id"])] = node

    def _safe_int(val: Any) -> int | None:
        if isinstance(val, bool) or val is None:
            return None
        try:
            return int(val)
        except (TypeError, ValueError):
            return None

    links_by_id: dict[int, list[Any]] = {}
    for link in raw_links:
        if isinstance(link, list) and len(link) >= 5:
            lid = _safe_int(link[0])
            if lid is not None:
                links_by_id[lid] = link

    set_node_links: dict[str, int] = {}
    for node in raw_nodes:
        if isinstance(node, dict) and node.get("type") == "SetNode" and node.get("mode", 0) != 2:
            const_name = _get_set_get_constant_name(node)
            for inp in node.get("inputs") or []:
                if isinstance(inp, dict):
                    lid = _safe_int(inp.get("link"))
                    if lid is not None:
                        if const_name:
                            set_node_links[const_name] = lid
                        break

    def resolve_link_origin(
        link_id: int, visited: set[str] | None = None
    ) -> tuple[str, Any] | None:
        if visited is None:
            visited = set()
        link = links_by_id.get(link_id)
        if not link:
            return None

        origin_node_id = str(link[1])
        origin_slot = _safe_int(link[2])
        if origin_slot is None:
            return None
        link_type = link[5] if len(link) > 5 and isinstance(link[5], str) else "*"
        visit_key = f"{origin_node_id}:{origin_slot}"
        if visit_key in visited:
            return None
        next_visited = visited | {visit_key}

        origin_node = nodes_by_id.get(origin_node_id)
        if not origin_node:
            return None

        mode = origin_node.get("mode", 0)
        if mode == 2:
            return None

        node_type = origin_node.get("type")
        if node_type in {"Reroute", "SetNode"}:
            for inp in origin_node.get("inputs") or []:
                if isinstance(inp, dict):
                    lid = _safe_int(inp.get("link"))
                    if lid is not None:
                        return resolve_link_origin(lid, next_visited)
            return None

        if node_type == "GetNode":
            const_name = _get_set_get_constant_name(origin_node)
            upstream_link_id = set_node_links.get(const_name)
            if upstream_link_id is None:
                return None
            return resolve_link_origin(upstream_link_id, next_visited)

        if node_type == "PrimitiveNode":
            named = origin_node.get("widgets_values_named")
            if isinstance(named, dict) and named:
                return ("value", next(iter(named.values())))
            wv = origin_node.get("widgets_values")
            if isinstance(wv, list) and wv:
                return ("value", wv[0])
            return ("value", "")

        if mode == 4:
            outputs = origin_node.get("outputs") or []
            expected_type = (
                outputs[origin_slot].get("type")
                if origin_slot < len(outputs) and isinstance(outputs[origin_slot], dict)
                else None
            ) or link_type
            connected = [
                inp
                for inp in (origin_node.get("inputs") or [])
                if isinstance(inp, dict) and inp.get("link") is not None
            ]
            if not connected:
                return None
            exact = next(
                (
                    inp
                    for inp in connected
                    if inp.get("type") in {expected_type, "*"} or expected_type == "*"
                ),
                None,
            )
            chosen = exact or (connected[0] if len(connected) == 1 else None)
            chosen_lid = _safe_int(chosen.get("link")) if chosen else None
            if chosen_lid is None:
                return None
            return resolve_link_origin(chosen_lid, next_visited)

        return ("link", [origin_node_id, origin_slot])

    api_workflow: dict[str, Any] = {}
    skipped_nodes = 0

    for node in raw_nodes:
        if not isinstance(node, dict) or node.get("id") is None or not node.get("type"):
            skipped_nodes += 1
            continue

        mode = node.get("mode", 0)
        node_type = str(node["type"])
        if mode != 0 or node_type in VIRTUAL_NODE_TYPES:
            skipped_nodes += 1
            continue

        node_id = str(node["id"])
        api_inputs: dict[str, Any] = {}
        linked_input_count = 0
        resolved_link_count = 0

        for inp in node.get("inputs") or []:
            if not isinstance(inp, dict):
                continue
            inp_name = inp.get("name")
            if not isinstance(inp_name, str) or not inp_name:
                continue
            lid = _safe_int(inp.get("link"))
            if lid is not None:
                linked_input_count += 1
                resolved = resolve_link_origin(lid)
                if resolved is not None:
                    resolved_link_count += 1
                    api_inputs[inp_name] = resolved[1]

        named = node.get("widgets_values_named")
        wv = node.get("widgets_values")
        if isinstance(named, dict):
            for key, val in named.items():
                if key in FRONTEND_WIDGET_KEYS or str(key).startswith("divider"):
                    continue
                if key not in api_inputs:
                    api_inputs[key] = val
        elif isinstance(wv, list):
            widget_inputs = [
                inp
                for inp in (node.get("inputs") or [])
                if isinstance(inp, dict)
                and isinstance(inp.get("name"), str)
                and inp.get("name")
                and isinstance(inp.get("widget"), dict)
                and inp["widget"].get("name")
            ]
            w_idx = 0
            for inp in widget_inputs:
                if w_idx >= len(wv):
                    break
                val = wv[w_idx]
                w_idx += 1
                inp_name = inp["name"]
                if inp_name not in api_inputs:
                    api_inputs[inp_name] = val
                if (
                    inp_name in {"seed", "noise_seed"}
                    and w_idx < len(wv)
                    and isinstance(wv[w_idx], str)
                    and wv[w_idx] in SEED_CONTROL_VALUES
                ):
                    w_idx += 1

        if linked_input_count > 0 and resolved_link_count == 0:
            skipped_nodes += 1
            continue

        if node_type == "dehypnotic_AspectRatio":
            props = node.get("properties") or {}
            prop_state = props.get("resolutionState") if isinstance(props, dict) else None
            ui_state = api_inputs.get("aspect_ratio_ui")
            if isinstance(prop_state, str) and prop_state.strip():
                api_inputs["ResolutionState"] = prop_state
            elif ui_state is not None:
                api_inputs["ResolutionState"] = (
                    ui_state if isinstance(ui_state, str) else json.dumps(ui_state, ensure_ascii=False)
                )
            api_inputs.pop("aspect_ratio_ui", None)

        api_workflow[node_id] = {
            "class_type": node_type,
            "inputs": api_inputs,
            "_meta": {"title": node.get("title") or node_type},
        }

    app_inputs: list[dict[str, Any]] = []
    suggested_field_keys: list[str] = []
    linear_data = (graph.get("extra") or {}).get("linearData") or {}
    linear_inputs = linear_data.get("inputs")
    if isinstance(linear_inputs, list):
        for item in linear_inputs:
            if not isinstance(item, list) or len(item) < 2:
                continue
            spec = str(item[0] or "")
            field_name = unquote(str(item[1] or ""))
            parts = spec.split(":")
            node_id = parts[-2] if len(parts) >= 3 else parts[0]
            key = f"{node_id}:{field_name}"
            api_node = api_workflow.get(node_id)
            raw_node = nodes_by_id.get(node_id)

            if isinstance(api_node, dict) and field_name in api_node.get("inputs", {}):
                val = api_node["inputs"][field_name]
                if not isinstance(val, (dict, list)):
                    if key not in suggested_field_keys:
                        suggested_field_keys.append(key)
                    meta = api_node.get("_meta") or {}
                    app_inputs.append(
                        {
                            "node_id": node_id,
                            "field_name": field_name,
                            "key": key,
                            "title": meta.get("title") or api_node["class_type"],
                            "class_type": api_node["class_type"],
                            "mapped": True,
                            "reason": None,
                        }
                    )
                    continue

            if isinstance(raw_node, dict):
                raw_type = str(raw_node.get("type", ""))
                if raw_type in VIRTUAL_NODE_TYPES:
                    reason = f"Canvas-only control ({raw_type})"
                elif raw_node.get("mode", 0) != 0:
                    reason = "Node is bypassed or muted in workflow"
                else:
                    reason = "Input is linked or non-primitive"
                app_inputs.append(
                    {
                        "node_id": node_id,
                        "field_name": field_name,
                        "key": key,
                        "title": raw_node.get("title") or raw_type,
                        "class_type": raw_type,
                        "mapped": False,
                        "reason": reason,
                    }
                )

    raw_linear_outputs = (
        [str(x) for x in linear_data.get("outputs", [])]
        if isinstance(linear_data.get("outputs"), list)
        else []
    )
    output_meta = extract_workflow_outputs(api_workflow, raw_linear_outputs)

    return {
        "workflow": api_workflow,
        "app_inputs": app_inputs,
        "outputs": output_meta["outputs"],
        "suggested_field_keys": suggested_field_keys,
        "suggested_output_type": output_meta["suggested_output_type"],
        "suggested_output_node_ids": output_meta["suggested_output_node_ids"],
        "stats": {
            "total_graph_nodes": len(raw_nodes),
            "converted_api_nodes": len(api_workflow),
            "skipped_nodes": skipped_nodes,
        },
    }


def normalize_comfy_workflow_payload(payload: Any) -> dict[str, Any]:
    if is_comfy_graph_workflow(payload):
        converted = convert_comfy_graph_to_api(payload)
        return {
            "workflow": converted["workflow"],
            "source_format": "workflow",
            "app_inputs": converted["app_inputs"],
            "outputs": converted["outputs"],
            "suggested_field_keys": converted["suggested_field_keys"],
            "suggested_output_type": converted["suggested_output_type"],
            "suggested_output_node_ids": converted["suggested_output_node_ids"],
            "conversion_stats": converted["stats"],
        }

    api_workflow = payload if isinstance(payload, dict) else {}
    for node in api_workflow.values():
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            continue
        if node.get("class_type") == "dehypnotic_AspectRatio" and "ResolutionState" not in node["inputs"]:
            inputs_dict = node["inputs"]
            raw = inputs_dict.get("aspect_ratio_ui", inputs_dict.get("resolutionState"))
            if raw is not None:
                inputs_dict["ResolutionState"] = (
                    raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False)
                )
                inputs_dict.pop("aspect_ratio_ui", None)
                inputs_dict.pop("resolutionState", None)
    output_meta = extract_workflow_outputs(api_workflow, [])
    return {
        "workflow": api_workflow,
        "source_format": "api",
        "app_inputs": [],
        "outputs": output_meta["outputs"],
        "suggested_field_keys": [],
        "suggested_output_type": output_meta["suggested_output_type"],
        "suggested_output_node_ids": output_meta["suggested_output_node_ids"],
        "conversion_stats": None,
    }

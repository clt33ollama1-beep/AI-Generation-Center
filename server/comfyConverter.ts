import type {
  AppInputHint,
  ComfyApiWorkflow,
  ComfyNode,
  InspectedOutput,
  OutputMediaType,
} from '../src/types/comfy.ts';

interface GraphInputSlot {
  name: string;
  type?: string;
  link?: number | null;
  widget?: { name?: string };
}

interface GraphOutputSlot {
  name?: string;
  type?: string;
  links?: number[] | null;
}

interface GraphNode {
  id: number | string;
  type: string;
  title?: string;
  mode?: number;
  properties?: Record<string, unknown>;
  inputs?: GraphInputSlot[];
  outputs?: GraphOutputSlot[];
  widgets_values?: unknown;
  widgets_values_named?: Record<string, unknown>;
}

type GraphLink = [
  number, // linkId
  number | string, // originNodeId
  number, // originSlot
  number | string, // targetNodeId
  number, // targetSlot
  string, // type
];

interface ComfyGraphWorkflow {
  nodes: GraphNode[];
  links: GraphLink[];
  extra?: {
    linearData?: {
      inputs?: Array<[string, string]>;
      outputs?: Array<string | number>;
    };
  };
}

export interface NormalizedWorkflowResult {
  workflow: ComfyApiWorkflow;
  source_format: 'api' | 'workflow';
  app_inputs: AppInputHint[];
  outputs: InspectedOutput[];
  suggested_field_keys: string[];
  suggested_output_type: OutputMediaType;
  suggested_output_node_ids: string[];
  conversion_stats?: {
    total_graph_nodes: number;
    converted_api_nodes: number;
    skipped_nodes: number;
  };
}

const VIRTUAL_NODE_TYPES = new Set([
  'Note',
  'MarkdownNote',
  'Label (rgthree)',
  'Fast Groups Bypasser (rgthree)',
  'Fast Groups Muter (rgthree)',
  'Fast Actions Button (rgthree)',
  'Bookmark (rgthree)',
  'SetNode',
  'GetNode',
  'Reroute',
  'PrimitiveNode',
]);

const FRONTEND_WIDGET_KEYS = new Set([
  'control_after_generate',
  'upload',
  'rgthree_comparer',
  'PowerLoraLoaderHeaderWidget',
  '➕ Add Lora',
]);

const SEED_CONTROL_VALUES = new Set(['fixed', 'increment', 'decrement', 'randomize']);

const VIDEO_OUTPUT_NODE_TYPES = new Set([
  'VHS_VideoCombine',
  'SaveVideo',
  'SaveWEBM',
  'SaveAnimatedWEBP',
  'SaveAnimatedPNG',
]);

const IMAGE_OUTPUT_NODE_TYPES = new Set([
  'SaveImage',
  'SaveImageAdvanced',
  'PreviewImage',
  'Image Comparer (rgthree)',
]);

const TEXT_OUTPUT_NODE_TYPES = new Set([
  'ShowText|pysssss',
  'ShowText',
  'Show Text',
  'Display Text (rgthree)',
  'DisplayText',
  'PreviewText',
  'PreviewTextNode',
  'SaveText',
  'SaveText|pysssss',
  'SaveTextFile',
  'PreviewAny',
  'easy showAnything',
  'DisplayAny',
  'StringOutput',
  'OutputString',
  'Text Output',
]);

const PRIMARY_SINK_NODE_TYPES = new Set([
  'SaveImage',
  'SaveImageAdvanced',
  'VHS_VideoCombine',
  'SaveVideo',
  'SaveWEBM',
  'SaveAnimatedWEBP',
  'SaveAnimatedPNG',
  'ShowText|pysssss',
  'ShowText',
  'Show Text',
  'Display Text (rgthree)',
  'DisplayText',
  'PreviewText',
  'PreviewTextNode',
  'SaveText',
  'SaveText|pysssss',
  'SaveTextFile',
  'StringOutput',
  'OutputString',
  'Text Output',
]);

export function isComfyGraphWorkflow(payload: unknown): payload is ComfyGraphWorkflow {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const obj = payload as Record<string, unknown>;
  return Array.isArray(obj.nodes) && Array.isArray(obj.links);
}

function getSetGetConstantName(node: GraphNode): string {
  if (node.widgets_values_named && typeof node.widgets_values_named.Constant === 'string') {
    return node.widgets_values_named.Constant;
  }
  if (Array.isArray(node.widgets_values) && typeof node.widgets_values[0] === 'string') {
    return node.widgets_values[0];
  }
  return (node.title || '').replace(/^(Set_|Get_)/, '');
}

type ResolvedOrigin =
  | { kind: 'link'; nodeId: string; slot: number }
  | { kind: 'value'; value: unknown };

function classifyOutputNode(
  nodeId: string,
  node: ComfyNode,
  isPrimaryAppOutput: boolean,
): InspectedOutput {
  const inputs =
    node.inputs && typeof node.inputs === 'object' && !Array.isArray(node.inputs) ? node.inputs : {};
  const rawFormat = typeof inputs.format === 'string' ? inputs.format : '';
  const fmtLower = rawFormat.toLowerCase();

  let mediaType: 'image' | 'video' | 'text' = 'image';
  let format = rawFormat || 'png';

  if (
    VIDEO_OUTPUT_NODE_TYPES.has(node.class_type) ||
    fmtLower.startsWith('video/') ||
    fmtLower === 'mp4' ||
    fmtLower === 'webm' ||
    fmtLower === 'gif' ||
    fmtLower === 'webp'
  ) {
    mediaType = 'video';
    if (!rawFormat) {
      if (node.class_type === 'SaveWEBM') format = 'webm';
      else if (node.class_type === 'SaveAnimatedWEBP') format = 'webp';
      else if (node.class_type === 'SaveAnimatedPNG') format = 'apng';
      else format = 'mp4';
    }
  } else if (
    TEXT_OUTPUT_NODE_TYPES.has(node.class_type) ||
    fmtLower.startsWith('text/') ||
    ['txt', 'md', 'markdown', 'json', 'csv', 'srt', 'vtt'].includes(fmtLower)
  ) {
    mediaType = 'text';
    format = rawFormat || 'txt';
  }

  return {
    node_id: nodeId,
    class_type: node.class_type,
    title: node._meta?.title || node.class_type,
    media_type: mediaType,
    format,
    is_primary_app_output: isPrimaryAppOutput,
  };
}

export function extractWorkflowOutputs(
  apiWorkflow: ComfyApiWorkflow,
  linearOutputNodeIds: string[] = [],
): {
  outputs: InspectedOutput[];
  suggested_output_type: OutputMediaType;
  suggested_output_node_ids: string[];
} {
  const primarySet = new Set(linearOutputNodeIds.map((id) => String(id)));
  const outputs: InspectedOutput[] = [];
  const seen = new Set<string>();

  for (const id of linearOutputNodeIds) {
    const nodeId = String(id);
    const node = apiWorkflow[nodeId];
    if (node && typeof node === 'object' && node.class_type) {
      outputs.push(classifyOutputNode(nodeId, node, true));
      seen.add(nodeId);
    }
  }

  const sortedIds = Object.keys(apiWorkflow).sort((a, b) => {
    const aNum = Number(a);
    const bNum = Number(b);
    if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum - bNum;
    return a.localeCompare(b);
  });

  for (const nodeId of sortedIds) {
    if (seen.has(nodeId)) continue;
    const node = apiWorkflow[nodeId];
    if (!node || typeof node !== 'object' || !node.class_type) continue;
    if (
      VIDEO_OUTPUT_NODE_TYPES.has(node.class_type) ||
      IMAGE_OUTPUT_NODE_TYPES.has(node.class_type) ||
      TEXT_OUTPUT_NODE_TYPES.has(node.class_type)
    ) {
      outputs.push(classifyOutputNode(nodeId, node, primarySet.has(nodeId)));
      seen.add(nodeId);
    }
  }

  const primaryOutputs = outputs.filter((o) => o.is_primary_app_output);
  const effectiveOutputs =
    primaryOutputs.length > 0
      ? primaryOutputs
      : outputs.filter((o) => PRIMARY_SINK_NODE_TYPES.has(o.class_type));

  let suggestedOutputType: OutputMediaType = 'auto';
  if (effectiveOutputs.some((o) => o.media_type === 'video')) {
    suggestedOutputType = 'video';
  } else if (effectiveOutputs.some((o) => o.media_type === 'image')) {
    suggestedOutputType = 'image';
  } else if (effectiveOutputs.some((o) => o.media_type === 'text')) {
    suggestedOutputType = 'text';
  }

  const suggestedOutputNodeIds =
    primaryOutputs.length > 0
      ? primaryOutputs.map((o) => o.node_id)
      : outputs.filter((o) => PRIMARY_SINK_NODE_TYPES.has(o.class_type)).map((o) => o.node_id);

  return {
    outputs,
    suggested_output_type: suggestedOutputType,
    suggested_output_node_ids: suggestedOutputNodeIds,
  };
}

export function convertComfyGraphToApi(graph: ComfyGraphWorkflow): {
  workflow: ComfyApiWorkflow;
  app_inputs: AppInputHint[];
  outputs: InspectedOutput[];
  suggested_field_keys: string[];
  suggested_output_type: OutputMediaType;
  suggested_output_node_ids: string[];
  stats: { total_graph_nodes: number; converted_api_nodes: number; skipped_nodes: number };
} {
  const nodesById = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (node && node.id !== undefined && node.id !== null) {
      nodesById.set(String(node.id), node);
    }
  }

  const linksById = new Map<number, GraphLink>();
  for (const link of graph.links) {
    if (Array.isArray(link) && link.length >= 5) {
      linksById.set(Number(link[0]), link);
    }
  }

  const setNodeLinks = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node?.type === 'SetNode' && (node.mode ?? 0) !== 2) {
      const constName = getSetGetConstantName(node);
      const connectedInput = (node.inputs || []).find(
        (inp) => inp.link !== null && inp.link !== undefined,
      );
      if (constName && connectedInput?.link !== null && connectedInput?.link !== undefined) {
        setNodeLinks.set(constName, Number(connectedInput.link));
      }
    }
  }

  const resolveLinkOrigin = (
    linkId: number,
    visited: Set<string> = new Set(),
  ): ResolvedOrigin | null => {
    const link = linksById.get(linkId);
    if (!link) return null;

    const originNodeId = String(link[1]);
    const originSlot = Number(link[2]);
    const linkType = typeof link[5] === 'string' ? link[5] : '*';
    const visitKey = `${originNodeId}:${originSlot}`;
    if (visited.has(visitKey)) return null;

    const nextVisited = new Set(visited);
    nextVisited.add(visitKey);

    const originNode = nodesById.get(originNodeId);
    if (!originNode) return null;

    const mode = originNode.mode ?? 0;
    if (mode === 2) {
      return null;
    }

    if (originNode.type === 'Reroute' || originNode.type === 'SetNode') {
      const firstInput = (originNode.inputs || []).find(
        (inp) => inp.link !== null && inp.link !== undefined,
      );
      if (!firstInput || firstInput.link === null || firstInput.link === undefined) return null;
      return resolveLinkOrigin(Number(firstInput.link), nextVisited);
    }

    if (originNode.type === 'GetNode') {
      const constName = getSetGetConstantName(originNode);
      const upstreamLinkId = setNodeLinks.get(constName);
      if (upstreamLinkId === undefined) return null;
      return resolveLinkOrigin(upstreamLinkId, nextVisited);
    }

    if (originNode.type === 'PrimitiveNode') {
      if (originNode.widgets_values_named) {
        const vals = Object.values(originNode.widgets_values_named);
        return { kind: 'value', value: vals[0] ?? '' };
      }
      if (Array.isArray(originNode.widgets_values)) {
        return { kind: 'value', value: originNode.widgets_values[0] ?? '' };
      }
      return { kind: 'value', value: '' };
    }

    if (mode === 4) {
      const expectedType = originNode.outputs?.[originSlot]?.type || linkType;
      const connectedInputs = (originNode.inputs || []).filter(
        (inp) => inp.link !== null && inp.link !== undefined,
      );
      if (connectedInputs.length === 0) {
        return null;
      }
      const exactMatch = connectedInputs.find(
        (inp) => inp.type === expectedType || inp.type === '*' || expectedType === '*',
      );
      const chosen = exactMatch || (connectedInputs.length === 1 ? connectedInputs[0] : undefined);
      if (!chosen || chosen.link === null || chosen.link === undefined) {
        return null;
      }
      return resolveLinkOrigin(Number(chosen.link), nextVisited);
    }

    return { kind: 'link', nodeId: originNodeId, slot: originSlot };
  };

  const apiWorkflow: ComfyApiWorkflow = {};
  let skippedNodes = 0;

  for (const node of graph.nodes) {
    if (!node || node.id === undefined || node.id === null || !node.type) {
      skippedNodes++;
      continue;
    }

    const mode = node.mode ?? 0;
    if (mode !== 0 || VIRTUAL_NODE_TYPES.has(node.type)) {
      skippedNodes++;
      continue;
    }

    const nodeId = String(node.id);
    const apiInputs: Record<string, unknown> = {};
    let linkedInputCount = 0;
    let resolvedLinkCount = 0;

    for (const inp of node.inputs || []) {
      if (!inp || typeof inp !== 'object' || typeof inp.name !== 'string' || !inp.name) continue;
      if (inp.link !== null && inp.link !== undefined && Number.isFinite(Number(inp.link))) {
        linkedInputCount++;
        const resolved = resolveLinkOrigin(Number(inp.link));
        if (resolved) {
          resolvedLinkCount++;
          apiInputs[inp.name] =
            resolved.kind === 'link' ? [resolved.nodeId, resolved.slot] : resolved.value;
        }
      }
    }

    if (
      node.widgets_values_named &&
      typeof node.widgets_values_named === 'object' &&
      !Array.isArray(node.widgets_values_named)
    ) {
      for (const [key, val] of Object.entries(node.widgets_values_named)) {
        if (FRONTEND_WIDGET_KEYS.has(key) || key.startsWith('divider')) {
          continue;
        }
        if (!(key in apiInputs)) {
          apiInputs[key] = val;
        }
      }
    } else if (Array.isArray(node.widgets_values)) {
      const widgetInputs = (node.inputs || []).filter(
        (inp) => inp && typeof inp === 'object' && typeof inp.name === 'string' && inp.name && inp.widget && inp.widget.name,
      );
      let wIdx = 0;
      for (const inp of widgetInputs) {
        if (wIdx >= node.widgets_values.length) break;
        const val = node.widgets_values[wIdx++];
        if (!(inp.name in apiInputs)) {
          apiInputs[inp.name] = val;
        }
        if (
          (inp.name === 'seed' || inp.name === 'noise_seed') &&
          typeof node.widgets_values[wIdx] === 'string' &&
          SEED_CONTROL_VALUES.has(String(node.widgets_values[wIdx]))
        ) {
          wIdx++;
        }
      }
    }

    if (linkedInputCount > 0 && resolvedLinkCount === 0) {
      skippedNodes++;
      continue;
    }

    if (node.type === 'dehypnotic_AspectRatio') {
      const propState = node.properties?.resolutionState;
      const uiState = apiInputs.aspect_ratio_ui;
      if (typeof propState === 'string' && propState.trim()) {
        apiInputs.ResolutionState = propState;
      } else if (uiState !== undefined) {
        apiInputs.ResolutionState =
          typeof uiState === 'string' ? uiState : JSON.stringify(uiState);
      }
      delete apiInputs.aspect_ratio_ui;
    }

    const apiNode: ComfyNode = {
      class_type: node.type,
      inputs: apiInputs,
      _meta: {
        title: node.title || node.type,
      },
    };
    apiWorkflow[nodeId] = apiNode;
  }

  // Extract ComfyUI .app.json linearData.inputs metadata
  const appInputs: AppInputHint[] = [];
  const suggestedFieldKeys: string[] = [];
  const linearInputs = graph.extra?.linearData?.inputs;
  if (Array.isArray(linearInputs)) {
    for (const item of linearInputs) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const spec = String(item[0] || '');
      let fieldName = String(item[1] || '');
      try {
        fieldName = decodeURIComponent(fieldName);
      } catch {
        // keep original if not valid URI encoding
      }
      const parts = spec.split(':');
      const nodeId = parts.length >= 3 ? parts[parts.length - 2] : parts[0];
      const key = `${nodeId}:${fieldName}`;
      const apiNode = apiWorkflow[nodeId];
      const rawNode = nodesById.get(nodeId);

      if (apiNode && fieldName && fieldName in apiNode.inputs) {
        const val = apiNode.inputs[fieldName];
        if (!Array.isArray(val) && (val === null || typeof val !== 'object')) {
          if (!suggestedFieldKeys.includes(key)) {
            suggestedFieldKeys.push(key);
          }
          appInputs.push({
            node_id: nodeId,
            field_name: fieldName,
            key,
            title: apiNode._meta?.title || apiNode.class_type,
            class_type: apiNode.class_type,
            mapped: true,
          });
          continue;
        }
      }

      if (rawNode) {
        const reason = VIRTUAL_NODE_TYPES.has(rawNode.type)
          ? `Canvas-only control (${rawNode.type})`
          : (rawNode.mode ?? 0) !== 0
            ? 'Node is bypassed or muted in workflow'
            : 'Input is linked or non-primitive';
        appInputs.push({
          node_id: nodeId,
          field_name: fieldName,
          key,
          title: rawNode.title || rawNode.type,
          class_type: rawNode.type,
          mapped: false,
          reason,
        });
      }
    }
  }

  // Extract ComfyUI .app.json linearData.outputs & detected output nodes
  const rawLinearOutputs = Array.isArray(graph.extra?.linearData?.outputs)
    ? graph.extra!.linearData!.outputs.map((id) => String(id))
    : [];
  const outputMeta = extractWorkflowOutputs(apiWorkflow, rawLinearOutputs);

  return {
    workflow: apiWorkflow,
    app_inputs: appInputs,
    outputs: outputMeta.outputs,
    suggested_field_keys: suggestedFieldKeys,
    suggested_output_type: outputMeta.suggested_output_type,
    suggested_output_node_ids: outputMeta.suggested_output_node_ids,
    stats: {
      total_graph_nodes: graph.nodes.length,
      converted_api_nodes: Object.keys(apiWorkflow).length,
      skipped_nodes: skippedNodes,
    },
  };
}

export function normalizeComfyWorkflowPayload(payload: unknown): NormalizedWorkflowResult {
  if (isComfyGraphWorkflow(payload)) {
    const converted = convertComfyGraphToApi(payload);
    return {
      workflow: converted.workflow,
      source_format: 'workflow',
      app_inputs: converted.app_inputs,
      outputs: converted.outputs,
      suggested_field_keys: converted.suggested_field_keys,
      suggested_output_type: converted.suggested_output_type,
      suggested_output_node_ids: converted.suggested_output_node_ids,
      conversion_stats: converted.stats,
    };
  }

  const apiWorkflow = (
    payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  ) as ComfyApiWorkflow;

  for (const node of Object.values(apiWorkflow)) {
    if (!node || typeof node !== 'object' || !node.inputs) continue;
    if (node.class_type === 'dehypnotic_AspectRatio' && !('ResolutionState' in node.inputs)) {
      const raw = node.inputs.aspect_ratio_ui ?? node.inputs.resolutionState;
      if (raw !== undefined) {
        node.inputs.ResolutionState = typeof raw === 'string' ? raw : JSON.stringify(raw);
        delete node.inputs.aspect_ratio_ui;
        delete node.inputs.resolutionState;
      }
    }
  }

  const outputMeta = extractWorkflowOutputs(apiWorkflow, []);

  return {
    workflow: apiWorkflow,
    source_format: 'api',
    app_inputs: [],
    outputs: outputMeta.outputs,
    suggested_field_keys: [],
    suggested_output_type: outputMeta.suggested_output_type,
    suggested_output_node_ids: outputMeta.suggested_output_node_ids,
  };
}

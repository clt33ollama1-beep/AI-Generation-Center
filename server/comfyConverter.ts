import type { ComfyApiWorkflow, ComfyNode } from '../src/types/comfy.ts';

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
  suggested_field_keys: string[];
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

export function convertComfyGraphToApi(graph: ComfyGraphWorkflow): {
  workflow: ComfyApiWorkflow;
  suggested_field_keys: string[];
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
      const connectedInput = (node.inputs || []).find((inp) => inp.link !== null && inp.link !== undefined);
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
      // Muted / Never
      return null;
    }

    if (originNode.type === 'Reroute') {
      const firstInput = (originNode.inputs || []).find(
        (inp) => inp.link !== null && inp.link !== undefined,
      );
      if (!firstInput || firstInput.link === null || firstInput.link === undefined) return null;
      return resolveLinkOrigin(Number(firstInput.link), nextVisited);
    }

    if (originNode.type === 'SetNode') {
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
      // Bypassed: trace through matching-type connected input if available
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
      if (inp.link !== null && inp.link !== undefined) {
        linkedInputCount++;
        const resolved = resolveLinkOrigin(Number(inp.link));
        if (resolved) {
          resolvedLinkCount++;
          apiInputs[inp.name] =
            resolved.kind === 'link' ? [resolved.nodeId, resolved.slot] : resolved.value;
        }
      }
    }

    if (node.widgets_values_named && typeof node.widgets_values_named === 'object' && !Array.isArray(node.widgets_values_named)) {
      for (const [key, val] of Object.entries(node.widgets_values_named)) {
        if (FRONTEND_WIDGET_KEYS.has(key) || key.startsWith('divider')) {
          continue;
        }
        if (!(key in apiInputs)) {
          apiInputs[key] = val;
        }
      }
    } else if (Array.isArray(node.widgets_values)) {
      const widgetInputs = (node.inputs || []).filter((inp) => inp.widget && inp.widget.name);
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

    // Prune active nodes whose upstream inputs were all muted/bypassed away
    if (linkedInputCount > 0 && resolvedLinkCount === 0) {
      skippedNodes++;
      continue;
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

  // Extract optional ComfyUI linearData suggested inputs
  const suggestedFieldKeys: string[] = [];
  const linearInputs = graph.extra?.linearData?.inputs;
  if (Array.isArray(linearInputs)) {
    for (const item of linearInputs) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const spec = String(item[0] || '');
      const fieldName = String(item[1] || '');
      const parts = spec.split(':');
      const nodeId = parts.length >= 3 ? parts[parts.length - 2] : parts[0];
      const apiNode = apiWorkflow[nodeId];
      if (apiNode && fieldName && fieldName in apiNode.inputs) {
        const val = apiNode.inputs[fieldName];
        if (!Array.isArray(val) && (val === null || typeof val !== 'object')) {
          const key = `${nodeId}:${fieldName}`;
          if (!suggestedFieldKeys.includes(key)) {
            suggestedFieldKeys.push(key);
          }
        }
      }
    }
  }

  return {
    workflow: apiWorkflow,
    suggested_field_keys: suggestedFieldKeys,
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
      suggested_field_keys: converted.suggested_field_keys,
      conversion_stats: converted.stats,
    };
  }

  return {
    workflow: (payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload
      : {}) as ComfyApiWorkflow,
    source_format: 'api',
    suggested_field_keys: [],
  };
}

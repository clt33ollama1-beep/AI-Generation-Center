import type {
  Category,
  ComfyApiWorkflow,
  ComfyHealthResponse,
  GenerationRecord,
  OutputMediaType,
  ProgressEventPayload,
  UIInputField,
  WorkflowInspectResponse,
  WorkflowTemplate,
} from '../types/comfy.ts';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let detail = `Request failed (${response.status})`;
    try {
      const err = (await response.json()) as { detail?: string; message?: string };
      detail = err.detail || err.message || detail;
    } catch {
      // ignore non-json error body
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}

export const api = {
  getSettings: () => requestJson<{ comfyui_url: string }>('/api/settings'),

  updateSettings: (comfyui_url: string) =>
    requestJson<{ comfyui_url: string }>('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comfyui_url }),
    }),

  checkComfyHealth: () => requestJson<ComfyHealthResponse>('/api/health/comfyui'),

  listCategories: () => requestJson<Category[]>('/api/categories'),

  createCategory: (payload: { name: string; description?: string; sort_order?: number }) =>
    requestJson<Category>('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  deleteCategory: (id: number) =>
    requestJson<{ deleted: boolean }>(`/api/categories/${id}`, { method: 'DELETE' }),

  listWorkflows: () => requestJson<WorkflowTemplate[]>('/api/workflows'),

  inspectWorkflow: (comfy_api_json: Record<string, unknown>) =>
    requestJson<WorkflowInspectResponse>('/api/workflows/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comfy_api_json }),
    }),

  createWorkflow: (payload: {
    name: string;
    description: string;
    category_id: number;
    output_type: OutputMediaType;
    output_node_ids?: string[];
    comfy_api_json: ComfyApiWorkflow;
    ui_inputs: UIInputField[];
  }) =>
    requestJson<WorkflowTemplate>('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  updateWorkflow: (
    id: number,
    payload: {
      name: string;
      description: string;
      category_id: number;
      output_type: OutputMediaType;
      output_node_ids?: string[];
      comfy_api_json: ComfyApiWorkflow;
      ui_inputs: UIInputField[];
    },
  ) =>
    requestJson<WorkflowTemplate>(`/api/workflows/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  deleteWorkflow: (id: number) =>
    requestJson<{ deleted: boolean }>(`/api/workflows/${id}`, { method: 'DELETE' }),

  listGenerations: (params?: { media_type?: string; workflow_id?: number; search?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.media_type) searchParams.set('media_type', params.media_type);
    if (params?.workflow_id) searchParams.set('workflow_id', String(params.workflow_id));
    if (params?.search) searchParams.set('search', params.search);
    const qs = searchParams.toString();
    return requestJson<GenerationRecord[]>(`/api/generations${qs ? `?${qs}` : ''}`);
  },

  deleteGeneration: (id: number) =>
    requestJson<{ deleted: boolean }>(`/api/generations/${id}`, { method: 'DELETE' }),

  submitGeneration: (formData: FormData) =>
    requestJson<{ prompt_id: string; client_id: string; status: string }>('/api/generate', {
      method: 'POST',
      body: formData,
    }),

  subscribeProgress: (
    clientId: string,
    onMessage: (payload: ProgressEventPayload) => void,
    onError?: () => void,
  ): (() => void) => {
    const es = new EventSource(`/api/progress/${encodeURIComponent(clientId)}`);
    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as ProgressEventPayload;
        onMessage(parsed);
      } catch {
        // ignore malformed heartbeat/event
      }
    };
    es.onerror = () => {
      onError?.();
    };
    return () => {
      es.close();
    };
  },
};

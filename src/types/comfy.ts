export type WidgetType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'slider'
  | 'seed_randomizer'
  | 'checkbox'
  | 'select'
  | 'image_upload';

export type OutputMediaType = 'auto' | 'image' | 'video';

export interface UIInputField {
  id: string;
  node_id: string;
  class_type: string;
  field_name: string;
  label: string;
  widget: WidgetType;
  value_type: 'string' | 'int' | 'float' | 'boolean' | 'media';
  default_value: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  description?: string;
  order: number;
}

export interface Category {
  id: number;
  name: string;
  slug: string;
  description: string;
  sort_order: number;
  created_at: string;
}

export interface ComfyNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: {
    title?: string;
  };
}

export type ComfyApiWorkflow = Record<string, ComfyNode>;

export interface WorkflowTemplate {
  id: number;
  name: string;
  description: string;
  category_id: number;
  category_name: string;
  output_type: OutputMediaType;
  output_node_ids: string[];
  comfy_api_json: ComfyApiWorkflow;
  ui_inputs: UIInputField[];
  created_at: string;
  updated_at: string;
}

export interface InspectedInput {
  field_name: string;
  value_type: 'string' | 'int' | 'float' | 'boolean' | 'media';
  default_value: string | number | boolean;
  suggested_widget: WidgetType;
  is_media_input: boolean;
}

export interface InspectedNode {
  node_id: string;
  class_type: string;
  title: string;
  inputs: InspectedInput[];
}

export interface AppInputHint {
  node_id: string;
  field_name: string;
  key: string;
  title: string;
  class_type: string;
  mapped: boolean;
  reason?: string | null;
}

export interface InspectedOutput {
  node_id: string;
  class_type: string;
  title: string;
  media_type: 'image' | 'video';
  format: string;
  is_primary_app_output: boolean;
}

export interface WorkflowInspectResponse {
  nodes: InspectedNode[];
  outputs?: InspectedOutput[];
  app_inputs?: AppInputHint[];
  source_format?: 'api' | 'workflow';
  converted_api_json?: ComfyApiWorkflow;
  suggested_field_keys?: string[];
  suggested_output_type?: OutputMediaType;
  suggested_output_node_ids?: string[];
  conversion_stats?: {
    total_graph_nodes: number;
    converted_api_nodes: number;
    skipped_nodes: number;
  } | null;
}

export interface OutputFileInfo {
  filename: string;
  original_filename: string;
  url: string;
  media_type: 'image' | 'video';
  format: string;
  node_id: string;
  width?: number | null;
  height?: number | null;
  duration_seconds?: number | null;
  file_size?: number | null;
}

export interface InputMediaInfo {
  key: string;
  node_id: string;
  field_name: string;
  label?: string;
  filename: string;
  original_filename: string;
  comfy_name: string;
  url: string;
  media_type: 'image' | 'video';
  width?: number | null;
  height?: number | null;
  duration_seconds?: number | null;
  file_size?: number | null;
}

export interface GenerationRecord {
  id: number;
  workflow_id: number;
  workflow_name: string;
  category_name: string;
  prompt_id: string;
  client_id: string;
  status: 'completed' | 'failed' | 'running';
  media_type: 'image' | 'video';
  primary_output_url: string;
  outputs: OutputFileInfo[];
  input_media?: InputMediaInfo[];
  submitted_inputs: Record<string, unknown>;
  duration_ms: number;
  error_message?: string | null;
  created_at: string;
}

export interface ProgressEventPayload {
  type: 'connected' | 'status' | 'executing' | 'progress' | 'completed' | 'error';
  client_id: string;
  prompt_id?: string;
  node_id?: string | null;
  node_title?: string | null;
  value?: number;
  max?: number;
  percent?: number;
  message?: string;
  generation?: GenerationRecord;
}

export interface ComfyHealthResponse {
  connected: boolean;
  comfyui_url: string;
  error?: string;
  system_stats?: {
    system?: {
      os?: string;
      comfyui_version?: string;
      pytorch_version?: string;
    };
    devices?: Array<{
      name?: string;
      type?: string;
      vram_total?: number;
      vram_free?: number;
    }>;
  };
}

export type QueueTaskState = 'running' | 'queued' | 'completed' | 'failed' | 'cancelled';

export interface QueueTaskItem {
  prompt_id: string;
  client_id?: string | null;
  queue_number?: number | null;
  queue_position?: number | null;
  state: QueueTaskState;
  workflow_id?: number | null;
  workflow_name: string;
  category_name: string;
  source: 'comfycentre' | 'external';
  node_count: number;
  current_node_id?: string | null;
  current_node_title?: string | null;
  step_value?: number | null;
  step_max?: number | null;
  progress_percent: number;
  submitted_inputs: Record<string, unknown>;
  outputs?: OutputFileInfo[];
  error_message?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
}

export interface QueueStatusResponse {
  comfyui_url: string;
  comfy_connected: boolean;
  comfy_error?: string | null;
  running: QueueTaskItem[];
  pending: QueueTaskItem[];
  recent: QueueTaskItem[];
  fetched_at: string;
}

export interface QueueTask {
  id: string;
  workflowId: number;
  workflowName: string;
  categoryName: string;
  outputType: OutputMediaType;
  uiInputs: UIInputField[];
  submittedInputs: Record<string, string | number | boolean>;
  fileValues: Record<string, File>;
  reusedMedia: Record<string, InputMediaInfo>;
  summaryText: string;
  status: QueueTaskState;
  progressPercent: number;
  stepProgress: { value: number; max: number } | null;
  activeNodeLabel: string | null;
  statusMessage: string;
  elapsedSeconds: number;
  error: string | null;
  generation: GenerationRecord | null;
  createdAt: number;
}

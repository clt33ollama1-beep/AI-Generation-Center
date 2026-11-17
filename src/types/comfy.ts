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

export interface OutputFileInfo {
  filename: string;
  original_filename: string;
  url: string;
  media_type: 'image' | 'video';
  format: string;
  node_id: string;
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

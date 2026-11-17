import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import multer from 'multer';
import WebSocket from 'ws';
import { createServer as createViteServer } from 'vite';
import { SEED_CATEGORIES, SEED_WORKFLOWS } from './server/seedData.ts';
import type {
  ComfyApiWorkflow,
  GenerationRecord,
  InspectedInput,
  InspectedNode,
  OutputFileInfo,
  ProgressEventPayload,
  UIInputField,
  WidgetType,
} from './src/types/comfy.ts';

const PORT = 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const OUTPUTS_DIR = path.join(DATA_DIR, 'outputs');
const DB_PATH = path.join(DATA_DIR, 'db.sqlite');
const DEFAULT_COMFYUI_URL = (process.env.COMFYUI_URL || 'http://192.168.1.100:8188').replace(/\/+$/, '');

fs.mkdirSync(OUTPUTS_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS workflows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    output_type TEXT NOT NULL DEFAULT 'auto',
    comfy_api_json TEXT NOT NULL,
    ui_inputs_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id INTEGER NOT NULL,
    workflow_name TEXT NOT NULL,
    category_name TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    media_type TEXT NOT NULL DEFAULT 'image',
    primary_output_url TEXT NOT NULL,
    outputs_json TEXT NOT NULL,
    submitted_inputs_json TEXT NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'category';
}

function seedDatabaseIfEmpty(): void {
  const existingSetting = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('comfyui_url');
  if (!existingSetting) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'comfyui_url',
      DEFAULT_COMFYUI_URL,
    );
  }

  const catCountRow = db.prepare('SELECT COUNT(*) AS count FROM categories').get() as {
    count: number;
  };
  if (catCountRow.count === 0) {
    const insertCat = db.prepare(
      'INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)',
    );
    for (const cat of SEED_CATEGORIES) {
      insertCat.run(cat.name, cat.slug, cat.description, cat.sort_order);
    }
  }

  const wfCountRow = db.prepare('SELECT COUNT(*) AS count FROM workflows').get() as {
    count: number;
  };
  if (wfCountRow.count === 0) {
    const findCat = db.prepare('SELECT id FROM categories WHERE slug = ?');
    const insertWf = db.prepare(`
      INSERT INTO workflows (name, description, category_id, output_type, comfy_api_json, ui_inputs_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const wf of SEED_WORKFLOWS) {
      const catRow = findCat.get(wf.category_slug) as { id: number } | undefined;
      if (catRow) {
        insertWf.run(
          wf.name,
          wf.description,
          catRow.id,
          wf.output_type,
          JSON.stringify(wf.comfy_api_json),
          JSON.stringify(wf.ui_inputs),
        );
      }
    }
  }
}

seedDatabaseIfEmpty();

function getComfyUiUrl(): string {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('comfyui_url') as { value: string } | undefined;
  return (row?.value || DEFAULT_COMFYUI_URL).replace(/\/+$/, '');
}

function isNodeLinkArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    (typeof value[0] === 'string' || typeof value[0] === 'number') &&
    typeof value[1] === 'number'
  );
}

const MEDIA_NODE_TYPES = new Set([
  'LoadImage',
  'LoadImageMask',
  'VHS_LoadVideo',
  'VHS_LoadVideoPath',
  'VHS_LoadImages',
  'LoadVideo',
]);

function inspectComfyWorkflow(workflow: ComfyApiWorkflow): InspectedNode[] {
  const inspectedNodes: InspectedNode[] = [];

  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object' || !node.class_type || !node.inputs) {
      continue;
    }

    const inputs: InspectedInput[] = [];
    const isMediaNode = MEDIA_NODE_TYPES.has(node.class_type);

    for (const [fieldName, rawVal] of Object.entries(node.inputs)) {
      if (isNodeLinkArray(rawVal)) {
        continue;
      }
      if (rawVal !== null && typeof rawVal === 'object') {
        continue;
      }

      const lowerField = fieldName.toLowerCase();
      const isMediaField =
        (isMediaNode && (lowerField === 'image' || lowerField === 'video' || lowerField === 'file')) ||
        lowerField === 'image_path' ||
        lowerField === 'video_path';

      let valueType: InspectedInput['value_type'] = 'string';
      let suggestedWidget: WidgetType = 'text';
      const defaultValue: string | number | boolean =
        rawVal === null || rawVal === undefined ? '' : (rawVal as string | number | boolean);

      if (isMediaField) {
        valueType = 'media';
        suggestedWidget = 'image_upload';
      } else if (typeof rawVal === 'boolean') {
        valueType = 'boolean';
        suggestedWidget = 'checkbox';
      } else if (typeof rawVal === 'number') {
        valueType = Number.isInteger(rawVal) ? 'int' : 'float';
        if (lowerField.includes('seed')) {
          suggestedWidget = 'seed_randomizer';
        } else {
          suggestedWidget = 'number';
        }
      } else {
        valueType = 'string';
        const strVal = String(defaultValue);
        if (lowerField === 'text' || lowerField.includes('prompt') || strVal.length > 48) {
          suggestedWidget = 'textarea';
        } else {
          suggestedWidget = 'text';
        }
      }

      inputs.push({
        field_name: fieldName,
        value_type: valueType,
        default_value: defaultValue,
        suggested_widget: suggestedWidget,
        is_media_input: isMediaField,
      });
    }

    if (inputs.length > 0) {
      inspectedNodes.push({
        node_id: nodeId,
        class_type: node.class_type,
        title: node._meta?.title || node.class_type,
        inputs,
      });
    }
  }

  return inspectedNodes.sort((a, b) => Number(a.node_id) - Number(b.node_id));
}

function mapWorkflowRow(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    name: String(row.name),
    description: String(row.description || ''),
    category_id: Number(row.category_id),
    category_name: String(row.category_name || ''),
    output_type: String(row.output_type || 'auto'),
    comfy_api_json: JSON.parse(String(row.comfy_api_json)) as ComfyApiWorkflow,
    ui_inputs: JSON.parse(String(row.ui_inputs_json)) as UIInputField[],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapGenerationRow(row: Record<string, unknown>): GenerationRecord {
  return {
    id: Number(row.id),
    workflow_id: Number(row.workflow_id),
    workflow_name: String(row.workflow_name),
    category_name: String(row.category_name),
    prompt_id: String(row.prompt_id),
    client_id: String(row.client_id),
    status: String(row.status) as GenerationRecord['status'],
    media_type: String(row.media_type) as GenerationRecord['media_type'],
    primary_output_url: String(row.primary_output_url),
    outputs: JSON.parse(String(row.outputs_json)) as OutputFileInfo[],
    submitted_inputs: JSON.parse(String(row.submitted_inputs_json)) as Record<string, unknown>,
    duration_ms: Number(row.duration_ms || 0),
    error_message: row.error_message ? String(row.error_message) : null,
    created_at: String(row.created_at),
  };
}

// SSE client registry
const sseClients = new Map<string, Set<Response>>();

function emitSseEvent(clientId: string, payload: ProgressEventPayload): void {
  const listeners = sseClients.get(clientId);
  if (!listeners || listeners.size === 0) return;
  const serialized = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of listeners) {
    try {
      res.write(serialized);
    } catch {
      listeners.delete(res);
    }
  }
}

function toComfyWebSocketUrl(httpUrl: string, clientId: string): string {
  const parsed = new URL(httpUrl);
  const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${parsed.host}/ws?clientId=${encodeURIComponent(clientId)}`;
}

function detectMediaTypeFromFilename(filename: string, format?: string): 'image' | 'video' {
  const lower = filename.toLowerCase();
  const fmt = (format || '').toLowerCase();
  if (
    fmt.startsWith('video/') ||
    lower.endsWith('.mp4') ||
    lower.endsWith('.webm') ||
    lower.endsWith('.mov') ||
    lower.endsWith('.mkv') ||
    lower.endsWith('.gif')
  ) {
    return 'video';
  }
  return 'image';
}

async function uploadMediaToComfyUI(
  comfyUrl: string,
  file: Express.Multer.File,
): Promise<string> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(file.buffer)], {
    type: file.mimetype || 'application/octet-stream',
  });
  form.append('image', blob, file.originalname || 'upload.png');
  form.append('overwrite', 'true');

  const response = await fetch(`${comfyUrl}/upload/image`, {
    method: 'POST',
    body: form,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ComfyUI media upload failed (${response.status}): ${errText}`);
  }

  const data = (await response.json()) as { name: string; subfolder?: string };
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

async function downloadComfyOutputs(
  comfyUrl: string,
  promptId: string,
): Promise<OutputFileInfo[]> {
  const historyRes = await fetch(`${comfyUrl}/history/${encodeURIComponent(promptId)}`);
  if (!historyRes.ok) {
    throw new Error(`Failed to fetch ComfyUI history (${historyRes.status})`);
  }

  const historyPayload = (await historyRes.json()) as Record<
    string,
    {
      outputs?: Record<
        string,
        {
          images?: Array<{ filename: string; subfolder?: string; type?: string; format?: string }>;
          gifs?: Array<{ filename: string; subfolder?: string; type?: string; format?: string }>;
          videos?: Array<{ filename: string; subfolder?: string; type?: string; format?: string }>;
        }
      >;
    }
  >;

  const entry = historyPayload[promptId];
  if (!entry?.outputs) {
    return [];
  }

  const savedOutputs: OutputFileInfo[] = [];

  for (const [nodeId, nodeOutput] of Object.entries(entry.outputs)) {
    const candidates = [
      ...(nodeOutput.videos || []),
      ...(nodeOutput.gifs || []),
      ...(nodeOutput.images || []),
    ];

    for (const item of candidates) {
      if (!item.filename) continue;
      // Skip temporary preview items if real output exists, unless type is output/temp
      const params = new URLSearchParams({
        filename: item.filename,
        subfolder: item.subfolder || '',
        type: item.type || 'output',
      });

      const viewRes = await fetch(`${comfyUrl}/view?${params.toString()}`);
      if (!viewRes.ok) {
        continue;
      }

      const arrayBuf = await viewRes.arrayBuffer();
      const ext = path.extname(item.filename) || '.png';
      const localName = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
      const localPath = path.join(OUTPUTS_DIR, localName);
      fs.writeFileSync(localPath, Buffer.from(arrayBuf));

      const mediaType = detectMediaTypeFromFilename(item.filename, item.format);
      savedOutputs.push({
        filename: localName,
        original_filename: item.filename,
        url: `/outputs/${localName}`,
        media_type: mediaType,
        format: item.format || ext.replace('.', ''),
        node_id: nodeId,
      });
    }
  }

  return savedOutputs;
}

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

app.use(express.json({ limit: '25mb' }));
app.use('/outputs', express.static(OUTPUTS_DIR));

// Settings & ComfyUI Health
app.get('/api/settings', (_req: Request, res: Response) => {
  res.json({ comfyui_url: getComfyUiUrl() });
});

app.put('/api/settings', (req: Request, res: Response) => {
  const rawUrl = String(req.body?.comfyui_url || '').trim().replace(/\/+$/, '');
  if (!rawUrl || (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://'))) {
    res.status(400).json({ detail: 'COMFYUI_URL must start with http:// or https://' });
    return;
  }
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('comfyui_url', rawUrl);
  res.json({ comfyui_url: rawUrl });
});

app.get('/api/health/comfyui', async (_req: Request, res: Response) => {
  const comfyUrl = getComfyUiUrl();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const response = await fetch(`${comfyUrl}/system_stats`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      res.json({
        connected: false,
        comfyui_url: comfyUrl,
        error: `HTTP ${response.status} from ${comfyUrl}/system_stats`,
      });
      return;
    }
    const systemStats = await response.json();
    res.json({
      connected: true,
      comfyui_url: comfyUrl,
      system_stats: systemStats,
    });
  } catch (err) {
    res.json({
      connected: false,
      comfyui_url: comfyUrl,
      error: err instanceof Error ? err.message : 'Unable to reach ComfyUI instance',
    });
  }
});

// Categories CRUD
app.get('/api/categories', (_req: Request, res: Response) => {
  const rows = db
    .prepare('SELECT * FROM categories ORDER BY sort_order ASC, name ASC')
    .all();
  res.json(rows);
});

app.post('/api/categories', (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim();
  const description = String(req.body?.description || '').trim();
  const sortOrder = Number(req.body?.sort_order ?? 0);
  if (!name) {
    res.status(400).json({ detail: 'Category name is required' });
    return;
  }
  const slug = slugify(name);
  try {
    const result = db
      .prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)')
      .run(name, slug, description, sortOrder);
    const created = db
      .prepare('SELECT * FROM categories WHERE id = ?')
      .get(Number(result.lastInsertRowid));
    res.status(201).json(created);
  } catch (err) {
    res.status(409).json({
      detail: err instanceof Error ? err.message : 'Category already exists',
    });
  }
});

app.put('/api/categories/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!existing) {
    res.status(404).json({ detail: 'Category not found' });
    return;
  }
  const name = String(req.body?.name ?? existing.name).trim();
  const description = String(req.body?.description ?? existing.description).trim();
  const sortOrder = Number(req.body?.sort_order ?? existing.sort_order);
  const slug = slugify(name);
  db.prepare(
    'UPDATE categories SET name = ?, slug = ?, description = ?, sort_order = ? WHERE id = ?',
  ).run(name, slug, description, sortOrder, id);
  const updated = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  res.json(updated);
});

app.delete('/api/categories/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const result = db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  if (result.changes === 0) {
    res.status(404).json({ detail: 'Category not found' });
    return;
  }
  res.json({ deleted: true });
});

// Workflow Inspector
app.post('/api/workflows/inspect', (req: Request, res: Response) => {
  const workflowJson = req.body?.comfy_api_json;
  if (!workflowJson || typeof workflowJson !== 'object' || Array.isArray(workflowJson)) {
    res.status(400).json({ detail: 'comfy_api_json must be a ComfyUI API-format JSON object' });
    return;
  }
  const nodes = inspectComfyWorkflow(workflowJson as ComfyApiWorkflow);
  res.json({ nodes });
});

// Workflows CRUD
app.get('/api/workflows', (_req: Request, res: Response) => {
  const rows = db
    .prepare(`
      SELECT w.*, c.name AS category_name
      FROM workflows w
      JOIN categories c ON c.id = w.category_id
      ORDER BY c.sort_order ASC, w.name ASC
    `)
    .all();
  res.json(rows.map(mapWorkflowRow));
});

app.get('/api/workflows/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const row = db
    .prepare(`
      SELECT w.*, c.name AS category_name
      FROM workflows w
      JOIN categories c ON c.id = w.category_id
      WHERE w.id = ?
    `)
    .get(id);
  if (!row) {
    res.status(404).json({ detail: 'Workflow template not found' });
    return;
  }
  res.json(mapWorkflowRow(row));
});

app.post('/api/workflows', (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim();
  const description = String(req.body?.description || '').trim();
  const categoryId = Number(req.body?.category_id);
  const outputType = String(req.body?.output_type || 'auto');
  const comfyApiJson = req.body?.comfy_api_json;
  const uiInputs = Array.isArray(req.body?.ui_inputs) ? req.body.ui_inputs : [];

  if (!name || !categoryId || !comfyApiJson) {
    res.status(400).json({ detail: 'name, category_id, and comfy_api_json are required' });
    return;
  }

  const result = db
    .prepare(`
      INSERT INTO workflows (name, description, category_id, output_type, comfy_api_json, ui_inputs_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      name,
      description,
      categoryId,
      outputType,
      JSON.stringify(comfyApiJson),
      JSON.stringify(uiInputs),
    );

  const created = db
    .prepare(`
      SELECT w.*, c.name AS category_name
      FROM workflows w
      JOIN categories c ON c.id = w.category_id
      WHERE w.id = ?
    `)
    .get(Number(result.lastInsertRowid));
  res.status(201).json(mapWorkflowRow(created!));
});

app.put('/api/workflows/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id);
  if (!existing) {
    res.status(404).json({ detail: 'Workflow template not found' });
    return;
  }

  const name = String(req.body?.name ?? existing.name).trim();
  const description = String(req.body?.description ?? existing.description).trim();
  const categoryId = Number(req.body?.category_id ?? existing.category_id);
  const outputType = String(req.body?.output_type ?? existing.output_type);
  const comfyApiJson = req.body?.comfy_api_json
    ? JSON.stringify(req.body.comfy_api_json)
    : String(existing.comfy_api_json);
  const uiInputsJson = req.body?.ui_inputs
    ? JSON.stringify(req.body.ui_inputs)
    : String(existing.ui_inputs_json);

  db.prepare(`
    UPDATE workflows
    SET name = ?, description = ?, category_id = ?, output_type = ?, comfy_api_json = ?, ui_inputs_json = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(name, description, categoryId, outputType, comfyApiJson, uiInputsJson, id);

  const updated = db
    .prepare(`
      SELECT w.*, c.name AS category_name
      FROM workflows w
      JOIN categories c ON c.id = w.category_id
      WHERE w.id = ?
    `)
    .get(id);
  res.json(mapWorkflowRow(updated!));
});

app.delete('/api/workflows/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const result = db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
  if (result.changes === 0) {
    res.status(404).json({ detail: 'Workflow template not found' });
    return;
  }
  res.json({ deleted: true });
});

// Generations Gallery CRUD
app.get('/api/generations', (req: Request, res: Response) => {
  const mediaType = String(req.query.media_type || '').trim();
  const workflowId = req.query.workflow_id ? Number(req.query.workflow_id) : null;
  const search = String(req.query.search || '').trim().toLowerCase();

  let rows = db
    .prepare('SELECT * FROM generations ORDER BY id DESC')
    .all()
    .map(mapGenerationRow);

  if (mediaType === 'image' || mediaType === 'video') {
    rows = rows.filter((g) => g.media_type === mediaType);
  }
  if (workflowId) {
    rows = rows.filter((g) => g.workflow_id === workflowId);
  }
  if (search) {
    rows = rows.filter((g) => {
      const hay = `${g.workflow_name} ${g.category_name} ${JSON.stringify(g.submitted_inputs)}`.toLowerCase();
      return hay.includes(search);
    });
  }

  res.json(rows);
});

app.get('/api/generations/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM generations WHERE id = ?').get(id);
  if (!row) {
    res.status(404).json({ detail: 'Generation not found' });
    return;
  }
  res.json(mapGenerationRow(row));
});

app.delete('/api/generations/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM generations WHERE id = ?').get(id);
  if (!row) {
    res.status(404).json({ detail: 'Generation not found' });
    return;
  }
  const gen = mapGenerationRow(row);
  for (const out of gen.outputs) {
    const filePath = path.join(OUTPUTS_DIR, out.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
  db.prepare('DELETE FROM generations WHERE id = ?').run(id);
  res.json({ deleted: true });
});

// SSE Progress Stream
app.get('/api/progress/:clientId', (req: Request, res: Response) => {
  const clientId = String(req.params.clientId);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  if (!sseClients.has(clientId)) {
    sseClients.set(clientId, new Set());
  }
  sseClients.get(clientId)!.add(res);

  emitSseEvent(clientId, {
    type: 'connected',
    client_id: clientId,
    message: 'SSE stream ready',
  });

  const heartbeat = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const set = sseClients.get(clientId);
    if (set) {
      set.delete(res);
      if (set.size === 0) {
        sseClients.delete(clientId);
      }
    }
  });
});

// Execute Workflow Generation
app.post('/api/generate', upload.any(), async (req: Request, res: Response) => {
  const workflowId = Number(req.body?.workflow_id);
  const clientId = String(req.body?.client_id || crypto.randomUUID());
  const rawInputsJson = String(req.body?.inputs_json || '{}');

  const wfRow = db
    .prepare(`
      SELECT w.*, c.name AS category_name
      FROM workflows w
      JOIN categories c ON c.id = w.category_id
      WHERE w.id = ?
    `)
    .get(workflowId);

  if (!wfRow) {
    res.status(404).json({ detail: 'Workflow template not found' });
    return;
  }

  const workflowTemplate = mapWorkflowRow(wfRow);
  const comfyUrl = getComfyUiUrl();
  let submittedInputs: Record<string, unknown> = {};
  try {
    submittedInputs = JSON.parse(rawInputsJson);
  } catch {
    res.status(400).json({ detail: 'Invalid inputs_json payload' });
    return;
  }

  const workflowCopy: ComfyApiWorkflow = JSON.parse(
    JSON.stringify(workflowTemplate.comfy_api_json),
  );

  // 1. Forward uploaded media files to ComfyUI /upload/image
  const files = (req.files as Express.Multer.File[]) || [];
  try {
    for (const file of files) {
      // Field name format: "file:<node_id>:<field_name>"
      const parts = file.fieldname.split(':');
      if (parts.length >= 3 && parts[0] === 'file') {
        const nodeId = parts[1];
        const fieldName = parts.slice(2).join(':');
        const uploadedName = await uploadMediaToComfyUI(comfyUrl, file);
        if (workflowCopy[nodeId]?.inputs) {
          workflowCopy[nodeId].inputs[fieldName] = uploadedName;
          submittedInputs[`${nodeId}:${fieldName}`] = uploadedName;
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Media upload to ComfyUI failed';
    emitSseEvent(clientId, { type: 'error', client_id: clientId, message: msg });
    res.status(502).json({ detail: msg });
    return;
  }

  // 2. Inject primitive form values into deep-copied workflow
  for (const field of workflowTemplate.ui_inputs) {
    const key = `${field.node_id}:${field.field_name}`;
    if (!(key in submittedInputs) && !(field.id in submittedInputs)) continue;
    const rawVal = key in submittedInputs ? submittedInputs[key] : submittedInputs[field.id];
    const targetNode = workflowCopy[field.node_id];
    if (!targetNode?.inputs) continue;

    if (field.value_type === 'media') {
      if (typeof rawVal === 'string' && rawVal.trim()) {
        targetNode.inputs[field.field_name] = rawVal;
      }
    } else if (field.value_type === 'int') {
      targetNode.inputs[field.field_name] = Math.round(Number(rawVal));
    } else if (field.value_type === 'float') {
      targetNode.inputs[field.field_name] = Number(rawVal);
    } else if (field.value_type === 'boolean') {
      targetNode.inputs[field.field_name] = Boolean(rawVal);
    } else {
      targetNode.inputs[field.field_name] = String(rawVal ?? '');
    }
  }

  // 3. Connect WebSocket to ComfyUI BEFORE queuing prompt
  const wsUrl = toComfyWebSocketUrl(comfyUrl, clientId);
  let ws: WebSocket;
  try {
    ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new Error(`Timed out connecting to ComfyUI WebSocket at ${wsUrl}`));
      }, 6000);
      socket.once('open', () => {
        clearTimeout(timeout);
        resolve(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : `Unable to connect to ComfyUI at ${comfyUrl}`;
    emitSseEvent(clientId, { type: 'error', client_id: clientId, message: msg });
    res.status(502).json({ detail: msg });
    return;
  }

  // 4. Queue prompt on ComfyUI
  const startedAt = Date.now();
  let promptId = '';
  try {
    const promptRes = await fetch(`${comfyUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflowCopy, client_id: clientId }),
    });
    if (!promptRes.ok) {
      const errBody = await promptRes.text();
      ws.close();
      throw new Error(`ComfyUI rejected prompt (${promptRes.status}): ${errBody}`);
    }
    const promptData = (await promptRes.json()) as { prompt_id: string };
    promptId = promptData.prompt_id;
  } catch (err) {
    ws.close();
    const msg = err instanceof Error ? err.message : 'Failed to queue prompt on ComfyUI';
    emitSseEvent(clientId, { type: 'error', client_id: clientId, message: msg });
    res.status(502).json({ detail: msg });
    return;
  }

  // Return immediately with prompt_id; WebSocket watcher continues in background and streams SSE
  res.status(202).json({
    prompt_id: promptId,
    client_id: clientId,
    status: 'queued',
  });

  emitSseEvent(clientId, {
    type: 'status',
    client_id: clientId,
    prompt_id: promptId,
    message: 'Prompt queued on ComfyUI',
  });

  let finished = false;
  const finalizeExecution = async () => {
    if (finished) return;
    finished = true;
    try {
      ws.close();
    } catch {
      // ignore
    }

    try {
      const outputs = await downloadComfyOutputs(comfyUrl, promptId);
      const durationMs = Date.now() - startedAt;
      const hasVideo = outputs.some((o) => o.media_type === 'video');
      const primaryMediaType: 'image' | 'video' =
        workflowTemplate.output_type === 'video' || hasVideo ? 'video' : 'image';
      const primaryUrl = outputs[0]?.url || '';

      const insertResult = db
        .prepare(`
          INSERT INTO generations (
            workflow_id, workflow_name, category_name, prompt_id, client_id,
            status, media_type, primary_output_url, outputs_json, submitted_inputs_json, duration_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          workflowTemplate.id,
          workflowTemplate.name,
          workflowTemplate.category_name,
          promptId,
          clientId,
          'completed',
          primaryMediaType,
          primaryUrl,
          JSON.stringify(outputs),
          JSON.stringify(submittedInputs),
          durationMs,
        );

      const savedRow = db
        .prepare('SELECT * FROM generations WHERE id = ?')
        .get(Number(insertResult.lastInsertRowid));
      const generation = mapGenerationRow(savedRow!);

      emitSseEvent(clientId, {
        type: 'completed',
        client_id: clientId,
        prompt_id: promptId,
        percent: 100,
        message: 'Generation complete',
        generation,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to retrieve ComfyUI outputs';
      emitSseEvent(clientId, {
        type: 'error',
        client_id: clientId,
        prompt_id: promptId,
        message: msg,
      });
    }
  };

  ws.on('message', (rawData) => {
    if (typeof rawData !== 'string' && !Buffer.isBuffer(rawData)) return;
    let parsed: { type?: string; data?: Record<string, unknown> };
    try {
      parsed = JSON.parse(rawData.toString());
    } catch {
      return;
    }

    const msgType = parsed.type;
    const data = parsed.data || {};
    const msgPromptId = data.prompt_id ? String(data.prompt_id) : undefined;
    if (msgPromptId && msgPromptId !== promptId) {
      return;
    }

    if (msgType === 'executing') {
      const nodeId = data.node ? String(data.node) : null;
      if (nodeId === null) {
        void finalizeExecution();
      } else {
        const nodeMeta = workflowCopy[nodeId];
        const nodeTitle = nodeMeta?._meta?.title || nodeMeta?.class_type || `Node ${nodeId}`;
        emitSseEvent(clientId, {
          type: 'executing',
          client_id: clientId,
          prompt_id: promptId,
          node_id: nodeId,
          node_title: nodeTitle,
          message: `Executing ${nodeTitle}`,
        });
      }
    } else if (msgType === 'progress') {
      const value = Number(data.value || 0);
      const max = Number(data.max || 1);
      const percent = max > 0 ? Math.round((value / max) * 100) : 0;
      emitSseEvent(clientId, {
        type: 'progress',
        client_id: clientId,
        prompt_id: promptId,
        value,
        max,
        percent,
      });
    } else if (msgType === 'execution_error') {
      finished = true;
      ws.close();
      const errMsg = String(data.exception_message || 'ComfyUI execution error');
      emitSseEvent(clientId, {
        type: 'error',
        client_id: clientId,
        prompt_id: promptId,
        message: errMsg,
      });
    }
  });

  ws.on('error', (err) => {
    if (!finished) {
      finished = true;
      emitSseEvent(clientId, {
        type: 'error',
        client_id: clientId,
        prompt_id: promptId,
        message: err.message || 'ComfyUI WebSocket disconnected',
      });
    }
  });
});

async function startServer() {
  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve('dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`ComfyCentre listening on http://0.0.0.0:${PORT} (ComfyUI: ${getComfyUiUrl()})`);
  });
}

void startServer();

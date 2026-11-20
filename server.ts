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
import { normalizeComfyWorkflowPayload } from './server/comfyConverter.ts';
import { extractMediaMetadataFromFile } from './server/mediaMetadata.ts';
import { SEED_CATEGORIES, SEED_WORKFLOWS } from './server/seedData.ts';
import type {
  ComfyApiWorkflow,
  GenerationRecord,
  InputMediaInfo,
  InspectedInput,
  InspectedNode,
  OutputFileInfo,
  ProgressEventPayload,
  QueueTaskItem,
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
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
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

const workflowCols = db.prepare('PRAGMA table_info(workflows)').all() as Array<{ name: string }>;
if (!workflowCols.some((c) => c.name === 'output_node_ids_json')) {
  db.exec("ALTER TABLE workflows ADD COLUMN output_node_ids_json TEXT NOT NULL DEFAULT '[]';");
}

const generationCols = db.prepare('PRAGMA table_info(generations)').all() as Array<{ name: string }>;
if (!generationCols.some((c) => c.name === 'input_media_json')) {
  db.exec("ALTER TABLE generations ADD COLUMN input_media_json TEXT NOT NULL DEFAULT '[]';");
}

function slugify(value: string): string {
  const trimmed = value.trim();
  const ascii = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const hasNonAscii = /[^\x00-\x7f]/.test(trimmed);
  if (ascii && !hasNonAscii) return ascii;
  const hash = crypto.createHash('sha1').update(trimmed).digest('hex').slice(0, 8);
  return ascii ? `${ascii}-${hash}` : `category-${hash}`;
}

function ensureUniqueCategorySlug(value: string, excludeId?: number): string {
  const base = slugify(value);
  let candidate = base;
  let counter = 2;
  while (true) {
    const existing =
      excludeId !== undefined
        ? (db.prepare('SELECT id FROM categories WHERE slug = ? AND id != ? LIMIT 1').get(candidate, excludeId) as
            | { id: number }
            | undefined)
        : (db.prepare('SELECT id FROM categories WHERE slug = ? LIMIT 1').get(candidate) as
            | { id: number }
            | undefined);
    if (!existing) {
      return candidate;
    }
    candidate = `${base}-${counter}`;
    counter += 1;
  }
}

function getOrCreateUncategorizedCategoryId(): number {
  const existing = db
    .prepare("SELECT id FROM categories WHERE slug = 'uncategorized' OR lower(name) = 'uncategorized' LIMIT 1")
    .get() as { id: number } | undefined;
  if (existing) {
    return Number(existing.id);
  }
  const result = db
    .prepare(
      'INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)',
    )
    .run('Uncategorized', 'uncategorized', 'Workflows from deleted or unassigned categories', 999);
  return Number(result.lastInsertRowid);
}

function safeDirSegment(value: string, fallback = 'uncategorized'): string {
  const cleaned = String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return cleaned || fallback;
}

function resolveSafeOutputsPath(relPath: string): string | null {
  const cleaned = String(relPath || '').replace(/^[/\\]+/, '');
  if (!cleaned) return null;
  const outputsRoot = path.resolve(OUTPUTS_DIR);
  const resolved = path.resolve(outputsRoot, cleaned);
  if (!resolved.startsWith(`${outputsRoot}${path.sep}`)) {
    return null;
  }
  return resolved;
}

function buildOutputUrl(...segments: string[]): string {
  return `/outputs/${segments.map((seg) => encodeURIComponent(seg)).join('/')}`;
}

function guessMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.mkv')) return 'video/x-matroska';
  return 'application/octet-stream';
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
  'LoadImageGoohai',
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
        if (
          lowerField === 'text' ||
          lowerField.includes('prompt') ||
          node.class_type.toLowerCase().includes('multiline') ||
          strVal.length > 48
        ) {
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

  return inspectedNodes.sort((a, b) => {
    const aNum = Number(a.node_id);
    const bNum = Number(b.node_id);
    if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum - bNum;
    return a.node_id.localeCompare(b.node_id);
  });
}

function safeJsonParse<T>(raw: unknown, fallback: T): T {
  try {
    return JSON.parse(String(raw ?? '')) as T;
  } catch {
    return fallback;
  }
}

function mapWorkflowRow(row: Record<string, unknown>) {
  let outputNodeIds: string[] = [];
  const parsedOutputIds = safeJsonParse<unknown>(row.output_node_ids_json, []);
  if (Array.isArray(parsedOutputIds)) {
    outputNodeIds = parsedOutputIds.map((id) => String(id));
  }
  const comfyApiJson = safeJsonParse<ComfyApiWorkflow>(row.comfy_api_json, {});
  const uiInputs = safeJsonParse<UIInputField[]>(row.ui_inputs_json, []);
  return {
    id: Number(row.id),
    name: String(row.name),
    description: String(row.description || ''),
    category_id: Number(row.category_id),
    category_name: String(row.category_name || 'Uncategorized'),
    output_type: String(row.output_type || 'auto'),
    output_node_ids: outputNodeIds,
    comfy_api_json: comfyApiJson && typeof comfyApiJson === 'object' ? comfyApiJson : {},
    ui_inputs: Array.isArray(uiInputs) ? uiInputs : [],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function enrichMediaEntry<T extends { filename?: string; media_type?: 'image' | 'video'; width?: number | null; height?: number | null; duration_seconds?: number | null; file_size?: number | null }>(
  item: T,
): T {
  if (!item || !item.filename) return item;
  const needsDims = item.width == null || item.height == null;
  const needsDuration = item.media_type === 'video' && item.duration_seconds == null;
  const needsSize = item.file_size == null;
  if (!needsDims && !needsDuration && !needsSize) {
    return item;
  }
  const safePath = resolveSafeOutputsPath(item.filename);
  if (!safePath || !fs.existsSync(safePath)) {
    return item;
  }
  const meta = extractMediaMetadataFromFile(safePath, item.media_type, item.filename);
  return {
    ...item,
    width: item.width ?? meta.width,
    height: item.height ?? meta.height,
    duration_seconds: item.duration_seconds ?? meta.duration_seconds,
    file_size: item.file_size ?? meta.file_size,
  };
}

function mapGenerationRow(row: Record<string, unknown>): GenerationRecord {
  const parsedInputMedia = safeJsonParse<unknown>(row.input_media_json, []);
  const inputMedia = Array.isArray(parsedInputMedia)
    ? (parsedInputMedia as InputMediaInfo[]).map((m) => enrichMediaEntry(m))
    : [];
  const parsedOutputs = safeJsonParse<unknown>(row.outputs_json, []);
  const outputs = Array.isArray(parsedOutputs)
    ? (parsedOutputs as OutputFileInfo[]).map((o) => enrichMediaEntry(o))
    : [];
  const parsedSubmitted = safeJsonParse<unknown>(row.submitted_inputs_json, {});
  const submittedInputs =
    parsedSubmitted && typeof parsedSubmitted === 'object' && !Array.isArray(parsedSubmitted)
      ? (parsedSubmitted as Record<string, unknown>)
      : {};
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
    outputs,
    input_media: inputMedia,
    submitted_inputs: submittedInputs,
    duration_ms: Number(row.duration_ms || 0),
    error_message: row.error_message ? String(row.error_message) : null,
    created_at: String(row.created_at),
  };
}

// SSE client registry & active/recent task queue tracker
const sseClients = new Map<string, Set<Response>>();
const trackedTasks = new Map<string, QueueTaskItem & { _startedAtMs?: number }>();

function registerQueuedTask(task: QueueTaskItem, startedAtMs: number): void {
  trackedTasks.set(task.prompt_id, { ...task, _startedAtMs: startedAtMs });
  if (trackedTasks.size > 60) {
    const finishedKeys = Array.from(trackedTasks.entries())
      .filter(([, t]) => t.state === 'completed' || t.state === 'failed' || t.state === 'cancelled')
      .map(([k]) => k);
    for (const k of finishedKeys.slice(0, Math.max(0, trackedTasks.size - 40))) {
      trackedTasks.delete(k);
    }
  }
}

function updateTrackedTask(
  promptId: string,
  patch: Partial<QueueTaskItem>,
): void {
  const existing = trackedTasks.get(promptId);
  if (!existing) return;
  trackedTasks.set(promptId, { ...existing, ...patch });
}

function stripInternalTaskFields(task: QueueTaskItem & { _startedAtMs?: number }): QueueTaskItem {
  const { _startedAtMs: _ignored, ...rest } = task;
  return rest;
}

function buildQueueItemFromComfyEntry(
  entry: unknown,
  state: 'running' | 'queued',
  position: number,
): QueueTaskItem | null {
  if (!Array.isArray(entry) || entry.length < 2) return null;
  const queueNumber = typeof entry[0] === 'number' ? entry[0] : Number(entry[0]) || null;
  const promptId = String(entry[1] || '');
  if (!promptId) return null;

  const promptGraph =
    entry[2] && typeof entry[2] === 'object' && !Array.isArray(entry[2])
      ? (entry[2] as Record<string, unknown>)
      : {};
  const nodeCount = Object.keys(promptGraph).length;
  const tracked = trackedTasks.get(promptId);
  if (tracked) {
    return {
      ...stripInternalTaskFields(tracked),
      queue_number: queueNumber,
      queue_position: position,
      state,
      node_count: tracked.node_count || nodeCount,
    };
  }

  return {
    prompt_id: promptId,
    client_id: null,
    queue_number: queueNumber,
    queue_position: position,
    state,
    workflow_id: null,
    workflow_name: 'External ComfyUI Job',
    category_name: 'External',
    source: 'external',
    node_count: nodeCount,
    current_node_id: null,
    current_node_title: null,
    step_value: null,
    step_max: null,
    progress_percent: 0,
    submitted_inputs: {},
    error_message: null,
    started_at: null,
    finished_at: null,
    duration_ms: null,
  };
}

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
  buffer: Buffer,
  originalname: string,
  mimetype: string,
): Promise<string> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], {
    type: mimetype || 'application/octet-stream',
  });
  form.append('image', blob, originalname || 'upload.png');
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
  preferredOutputNodeIds: string[] = [],
  categoryName = 'uncategorized',
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

  const preferredSet = new Set(preferredOutputNodeIds.map((id) => String(id)));
  const allEntries = Object.entries(entry.outputs);
  const matchingPreferred =
    preferredSet.size > 0
      ? allEntries.filter(([nodeId, out]) => {
          if (!preferredSet.has(String(nodeId))) return false;
          return (
            (out.videos?.length || 0) + (out.gifs?.length || 0) + (out.images?.length || 0) > 0
          );
        })
      : [];
  const entriesToDownload = matchingPreferred.length > 0 ? matchingPreferred : allEntries;

  const catDir = safeDirSegment(categoryName, 'uncategorized');
  const promptDirSeg = safeDirSegment(promptId, 'unknown');
  const targetDir = path.join(OUTPUTS_DIR, catDir, promptDirSeg);
  fs.mkdirSync(targetDir, { recursive: true });

  const savedOutputs: OutputFileInfo[] = [];

  for (const [nodeId, nodeOutput] of entriesToDownload) {
    const candidates = [
      ...(nodeOutput.videos || []),
      ...(nodeOutput.gifs || []),
      ...(nodeOutput.images || []),
    ];

    for (const item of candidates) {
      if (!item.filename) continue;
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
      const localPath = path.join(targetDir, localName);
      fs.writeFileSync(localPath, Buffer.from(arrayBuf));

      const relFilename = `${catDir}/${promptDirSeg}/${localName}`;
      const mediaType = detectMediaTypeFromFilename(item.filename, item.format);
      const mediaMeta = extractMediaMetadataFromFile(localPath, mediaType, relFilename);
      savedOutputs.push({
        filename: relFilename,
        original_filename: item.filename,
        url: buildOutputUrl(catDir, promptDirSeg, localName),
        media_type: mediaType,
        format: item.format || ext.replace('.', ''),
        node_id: nodeId,
        width: mediaMeta.width,
        height: mediaMeta.height,
        duration_seconds: mediaMeta.duration_seconds,
        file_size: mediaMeta.file_size,
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
  const duplicate = db.prepare('SELECT id FROM categories WHERE name = ? LIMIT 1').get(name);
  if (duplicate) {
    res.status(409).json({ detail: `Category "${name}" already exists` });
    return;
  }
  const slug = ensureUniqueCategorySlug(name);
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
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ detail: 'Invalid category id' });
    return;
  }
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as
    | { id: number; name: string; slug: string; description: string; sort_order: number }
    | undefined;
  if (!existing) {
    res.status(404).json({ detail: 'Category not found' });
    return;
  }
  const name = String(req.body?.name ?? existing.name).trim();
  if (!name) {
    res.status(400).json({ detail: 'Category name is required' });
    return;
  }
  const duplicate = db
    .prepare('SELECT id FROM categories WHERE name = ? AND id != ? LIMIT 1')
    .get(name, id);
  if (duplicate) {
    res.status(409).json({ detail: `Category "${name}" already exists` });
    return;
  }
  const description = String(req.body?.description ?? existing.description ?? '').trim();
  const rawSort = req.body?.sort_order ?? existing.sort_order ?? 0;
  const sortOrder = Number.isFinite(Number(rawSort)) ? Number(rawSort) : 0;
  const slug = ensureUniqueCategorySlug(name, id);
  try {
    db.prepare(
      'UPDATE categories SET name = ?, slug = ?, description = ?, sort_order = ? WHERE id = ?',
    ).run(name, slug, description, sortOrder, id);
    const updated = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    res.json(updated);
  } catch (err) {
    res.status(409).json({
      detail: err instanceof Error ? err.message : 'Category name already exists',
    });
  }
});

app.delete('/api/categories/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ detail: 'Invalid category id' });
    return;
  }
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as
    | { id: number; name: string; slug: string }
    | undefined;
  if (!existing) {
    res.status(404).json({ detail: 'Category not found' });
    return;
  }

  const wfCountRow = db
    .prepare('SELECT COUNT(*) AS count FROM workflows WHERE category_id = ?')
    .get(id) as { count: number };
  const wfCount = Number(wfCountRow?.count || 0);

  const isUncategorized =
    String(existing.slug).toLowerCase() === 'uncategorized' ||
    String(existing.name).trim().toLowerCase() === 'uncategorized';

  const totalCatRow = db.prepare('SELECT COUNT(*) AS count FROM categories').get() as {
    count: number;
  };
  if (isUncategorized && (wfCount > 0 || Number(totalCatRow?.count || 0) <= 1)) {
    res.status(400).json({
      detail: 'Cannot delete the Uncategorized category while templates use it or no other categories exist',
    });
    return;
  }

  try {
    let uncategorizedId: number | null = null;
    if (wfCount > 0 || Number(totalCatRow?.count || 0) <= 1) {
      uncategorizedId = getOrCreateUncategorizedCategoryId();
      if (wfCount > 0) {
        db.prepare("UPDATE workflows SET category_id = ?, updated_at = datetime('now') WHERE category_id = ?").run(
          uncategorizedId,
          id,
        );
      }
    }

    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    res.json({
      deleted: true,
      reassigned_count: wfCount,
      uncategorized_category_id: uncategorizedId,
    });
  } catch (err) {
    res.status(409).json({
      detail: err instanceof Error ? err.message : 'Failed to delete category',
    });
  }
});

// Workflow Inspector
app.post('/api/workflows/inspect', (req: Request, res: Response) => {
  const workflowJson = req.body?.comfy_api_json;
  if (!workflowJson || typeof workflowJson !== 'object' || Array.isArray(workflowJson)) {
    res.status(400).json({ detail: 'comfy_api_json must be a ComfyUI API or workflow JSON object' });
    return;
  }
  try {
    const normalized = normalizeComfyWorkflowPayload(workflowJson);
    const nodes = inspectComfyWorkflow(normalized.workflow);
    res.json({
      nodes,
      outputs: normalized.outputs,
      app_inputs: normalized.app_inputs,
      source_format: normalized.source_format,
      converted_api_json: normalized.workflow,
      suggested_field_keys: normalized.suggested_field_keys,
      suggested_output_type: normalized.suggested_output_type,
      suggested_output_node_ids: normalized.suggested_output_node_ids,
      conversion_stats: normalized.conversion_stats ?? null,
    });
  } catch (err) {
    res.status(400).json({
      detail: err instanceof Error ? `Invalid ComfyUI workflow JSON: ${err.message}` : 'Invalid ComfyUI workflow JSON',
    });
  }
});

// Workflows CRUD
app.get('/api/workflows', (_req: Request, res: Response) => {
  const rows = db
    .prepare(`
      SELECT w.*, COALESCE(c.name, 'Uncategorized') AS category_name
      FROM workflows w
      LEFT JOIN categories c ON c.id = w.category_id
      ORDER BY COALESCE(c.sort_order, 999) ASC, w.name ASC
    `)
    .all();
  res.json(rows.map(mapWorkflowRow));
});

app.get('/api/workflows/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const row = db
    .prepare(`
      SELECT w.*, COALESCE(c.name, 'Uncategorized') AS category_name
      FROM workflows w
      LEFT JOIN categories c ON c.id = w.category_id
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
  const comfyApiJson = req.body?.comfy_api_json;
  const uiInputs = Array.isArray(req.body?.ui_inputs) ? req.body.ui_inputs : [];

  if (!name || !Number.isInteger(categoryId) || categoryId <= 0 || !comfyApiJson || typeof comfyApiJson !== 'object' || Array.isArray(comfyApiJson)) {
    res.status(400).json({ detail: 'name, a valid category_id, and comfy_api_json are required' });
    return;
  }

  const categoryExists = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
  if (!categoryExists) {
    res.status(404).json({ detail: 'Selected category was not found. Please select an existing category.' });
    return;
  }

  try {
    const normalized = normalizeComfyWorkflowPayload(comfyApiJson);
    const rawOutputType = String(req.body?.output_type || normalized.suggested_output_type || 'auto').trim().toLowerCase();
    const outputType = ['auto', 'image', 'video'].includes(rawOutputType) ? rawOutputType : 'auto';
    const outputNodeIds = Array.isArray(req.body?.output_node_ids)
      ? req.body.output_node_ids.map((id: unknown) => String(id))
      : normalized.suggested_output_node_ids;

    const result = db
      .prepare(`
        INSERT INTO workflows (name, description, category_id, output_type, output_node_ids_json, comfy_api_json, ui_inputs_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        name,
        description,
        categoryId,
        outputType,
        JSON.stringify(outputNodeIds),
        JSON.stringify(normalized.workflow),
        JSON.stringify(uiInputs),
      );

    const created = db
      .prepare(`
        SELECT w.*, COALESCE(c.name, 'Uncategorized') AS category_name
        FROM workflows w
        LEFT JOIN categories c ON c.id = w.category_id
        WHERE w.id = ?
      `)
      .get(Number(result.lastInsertRowid));
    if (!created) {
      res.status(500).json({ detail: 'Failed to retrieve created workflow template' });
      return;
    }
    res.status(201).json(mapWorkflowRow(created));
  } catch (err) {
    res.status(400).json({
      detail: err instanceof Error ? err.message : 'Failed to create workflow template',
    });
  }
});

app.put('/api/workflows/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ detail: 'Invalid workflow template id' });
    return;
  }
  const existing = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!existing) {
    res.status(404).json({ detail: 'Workflow template not found' });
    return;
  }

  const name = String(req.body?.name ?? existing.name).trim();
  if (!name) {
    res.status(400).json({ detail: 'Template name is required' });
    return;
  }
  const description = String(req.body?.description ?? existing.description ?? '').trim();
  const rawCategoryId =
    req.body?.category_id !== undefined && req.body?.category_id !== null && req.body?.category_id !== ''
      ? req.body.category_id
      : existing.category_id;
  const categoryId = Number(rawCategoryId);
  if (!Number.isInteger(categoryId) || categoryId <= 0) {
    res.status(400).json({ detail: 'Invalid category_id' });
    return;
  }
  const categoryExists = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
  if (!categoryExists) {
    res.status(404).json({
      detail: 'Selected category was not found. Please refresh and choose a valid category.',
    });
    return;
  }

  const rawOutputType = String(req.body?.output_type ?? existing.output_type ?? 'auto').trim().toLowerCase();
  const outputType = ['auto', 'image', 'video'].includes(rawOutputType) ? rawOutputType : 'auto';

  try {
    const normalized =
      req.body?.comfy_api_json && typeof req.body.comfy_api_json === 'object' && !Array.isArray(req.body.comfy_api_json)
        ? normalizeComfyWorkflowPayload(req.body.comfy_api_json)
        : null;
    const comfyApiJson = normalized
      ? JSON.stringify(normalized.workflow)
      : String(existing.comfy_api_json);
    const outputNodeIdsJson = Array.isArray(req.body?.output_node_ids)
      ? JSON.stringify(req.body.output_node_ids.map((nid: unknown) => String(nid)))
      : normalized && normalized.suggested_output_node_ids.length > 0 && String(existing.output_node_ids_json || '[]') === '[]'
        ? JSON.stringify(normalized.suggested_output_node_ids)
        : String(existing.output_node_ids_json || '[]');
    const uiInputsJson = Array.isArray(req.body?.ui_inputs)
      ? JSON.stringify(req.body.ui_inputs)
      : String(existing.ui_inputs_json);

    db.prepare(`
      UPDATE workflows
      SET name = ?, description = ?, category_id = ?, output_type = ?, output_node_ids_json = ?, comfy_api_json = ?, ui_inputs_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(name, description, categoryId, outputType, outputNodeIdsJson, comfyApiJson, uiInputsJson, id);

    const updated = db
      .prepare(`
        SELECT w.*, COALESCE(c.name, 'Uncategorized') AS category_name
        FROM workflows w
        LEFT JOIN categories c ON c.id = w.category_id
        WHERE w.id = ?
      `)
      .get(id);
    if (!updated) {
      res.status(404).json({ detail: 'Workflow template not found' });
      return;
    }
    res.json(mapWorkflowRow(updated));
  } catch (err) {
    res.status(400).json({
      detail: err instanceof Error ? err.message : 'Failed to update workflow template',
    });
  }
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
  const candidateDirs = new Set<string>();
  for (const out of gen.outputs) {
    const filePath = resolveSafeOutputsPath(out.filename);
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      candidateDirs.add(path.dirname(filePath));
    }
  }
  for (const inp of gen.input_media || []) {
    const filePath = resolveSafeOutputsPath(inp.filename);
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      candidateDirs.add(path.dirname(filePath));
    }
  }
  const outputsRoot = path.resolve(OUTPUTS_DIR);
  for (const dir of candidateDirs) {
    let curr = dir;
    while (curr.startsWith(`${outputsRoot}${path.sep}`)) {
      try {
        if (fs.existsSync(curr) && fs.readdirSync(curr).length === 0) {
          fs.rmdirSync(curr);
          curr = path.dirname(curr);
        } else {
          break;
        }
      } catch {
        break;
      }
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

// Queue Monitoring & Control
app.get('/api/queue', async (_req: Request, res: Response) => {
  const comfyUrl = getComfyUiUrl();
  let comfyConnected = false;
  let comfyError: string | null = null;
  const running: QueueTaskItem[] = [];
  const pending: QueueTaskItem[] = [];
  const activeIds = new Set<string>();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const response = await fetch(`${comfyUrl}/queue`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      comfyError = `HTTP ${response.status} from ${comfyUrl}/queue`;
    } else {
      comfyConnected = true;
      const payload = (await response.json()) as {
        queue_running?: unknown[];
        queue_pending?: unknown[];
      };
      const rawRunning = Array.isArray(payload.queue_running) ? payload.queue_running : [];
      const rawPending = Array.isArray(payload.queue_pending) ? payload.queue_pending : [];

      for (const entry of rawRunning) {
        const item = buildQueueItemFromComfyEntry(entry, 'running', 0);
        if (item) {
          activeIds.add(item.prompt_id);
          running.push(item);
        }
      }
      rawPending.forEach((entry, idx) => {
        const item = buildQueueItemFromComfyEntry(entry, 'queued', idx + 1);
        if (item) {
          activeIds.add(item.prompt_id);
          pending.push(item);
        }
      });
    }
  } catch (err) {
    comfyError = err instanceof Error ? err.message : `Unable to reach ComfyUI at ${comfyUrl}`;
  }

  // Include locally tracked queued/running tasks when ComfyUI is temporarily unreachable
  if (!comfyConnected) {
    for (const task of trackedTasks.values()) {
      if (task.state === 'running' && !activeIds.has(task.prompt_id)) {
        activeIds.add(task.prompt_id);
        running.push(stripInternalTaskFields(task));
      } else if (task.state === 'queued' && !activeIds.has(task.prompt_id)) {
        activeIds.add(task.prompt_id);
        pending.push({
          ...stripInternalTaskFields(task),
          queue_position: pending.length + 1,
        });
      }
    }
  }

  const recent = Array.from(trackedTasks.values())
    .filter(
      (t) =>
        !activeIds.has(t.prompt_id) &&
        (t.state === 'completed' || t.state === 'failed' || t.state === 'cancelled'),
    )
    .sort((a, b) => (b.finished_at || b.started_at || '').localeCompare(a.finished_at || a.started_at || ''))
    .slice(0, 20)
    .map(stripInternalTaskFields);

  res.json({
    comfyui_url: comfyUrl,
    comfy_connected: comfyConnected,
    comfy_error: comfyError,
    running,
    pending,
    recent,
    fetched_at: new Date().toISOString(),
  });
});

app.post('/api/queue/interrupt', async (_req: Request, res: Response) => {
  const comfyUrl = getComfyUiUrl();
  try {
    const response = await fetch(`${comfyUrl}/interrupt`, { method: 'POST' });
    if (!response.ok) {
      const text = await response.text();
      res.status(502).json({ detail: `ComfyUI interrupt failed (${response.status}): ${text}` });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({
      detail: err instanceof Error ? err.message : 'Unable to interrupt running task on ComfyUI',
    });
  }
});

app.post('/api/queue/cancel', async (req: Request, res: Response) => {
  const promptId = String(req.body?.prompt_id || '').trim();
  if (!promptId) {
    res.status(400).json({ detail: 'prompt_id is required' });
    return;
  }
  const comfyUrl = getComfyUiUrl();
  try {
    const response = await fetch(`${comfyUrl}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
    });
    if (!response.ok) {
      const text = await response.text();
      res.status(502).json({ detail: `ComfyUI cancel failed (${response.status}): ${text}` });
      return;
    }
    const existing = trackedTasks.get(promptId);
    if (existing) {
      updateTrackedTask(promptId, {
        state: 'cancelled',
        error_message: 'Removed from queue',
        finished_at: new Date().toISOString(),
        duration_ms: existing._startedAtMs ? Date.now() - existing._startedAtMs : null,
      });
    }
    res.json({ ok: true, deleted: promptId });
  } catch (err) {
    res.status(502).json({
      detail: err instanceof Error ? err.message : 'Unable to cancel queued task on ComfyUI',
    });
  }
});

app.post('/api/queue/clear', async (_req: Request, res: Response) => {
  const comfyUrl = getComfyUiUrl();
  try {
    const response = await fetch(`${comfyUrl}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    });
    if (!response.ok) {
      const text = await response.text();
      res.status(502).json({ detail: `ComfyUI queue clear failed (${response.status}): ${text}` });
      return;
    }
    const nowIso = new Date().toISOString();
    for (const [pid, task] of trackedTasks.entries()) {
      if (task.state === 'queued') {
        updateTrackedTask(pid, {
          state: 'cancelled',
          error_message: 'Cleared from queue',
          finished_at: nowIso,
          duration_ms: task._startedAtMs ? Date.now() - task._startedAtMs : null,
        });
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({
      detail: err instanceof Error ? err.message : 'Unable to clear ComfyUI queue',
    });
  }
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

  const normalizedTemplate = normalizeComfyWorkflowPayload(workflowTemplate.comfy_api_json).workflow;
  const workflowCopy: ComfyApiWorkflow = JSON.parse(
    JSON.stringify(normalizedTemplate),
  );

  // 1. Forward uploaded or reused media files to ComfyUI /upload/image
  interface PendingInputMedia {
    key: string;
    node_id: string;
    field_name: string;
    label?: string;
    original_filename: string;
    comfy_name: string;
    media_type: 'image' | 'video';
    buffer: Buffer;
  }

  const fieldLabelByKey = new Map<string, string>();
  for (const f of workflowTemplate.ui_inputs) {
    fieldLabelByKey.set(`${f.node_id}:${f.field_name}`, f.label);
  }

  const pendingInputMedia: PendingInputMedia[] = [];
  const handledMediaKeys = new Set<string>();
  const files = (req.files as Express.Multer.File[]) || [];

  try {
    for (const file of files) {
      // Field name format: "file:<node_id>:<field_name>"
      const parts = file.fieldname.split(':');
      if (parts.length >= 3 && parts[0] === 'file') {
        const nodeId = parts[1];
        const fieldName = parts.slice(2).join(':');
        const mediaKey = `${nodeId}:${fieldName}`;
        const origName = file.originalname || 'upload.png';
        const uploadedName = await uploadMediaToComfyUI(
          comfyUrl,
          file.buffer,
          origName,
          file.mimetype || guessMimeType(origName),
        );
        if (workflowCopy[nodeId]?.inputs) {
          workflowCopy[nodeId].inputs[fieldName] = uploadedName;
          submittedInputs[mediaKey] = uploadedName;
        }
        handledMediaKeys.add(mediaKey);
        pendingInputMedia.push({
          key: mediaKey,
          node_id: nodeId,
          field_name: fieldName,
          label: fieldLabelByKey.get(mediaKey),
          original_filename: origName,
          comfy_name: uploadedName,
          media_type: detectMediaTypeFromFilename(origName, file.mimetype),
          buffer: file.buffer,
        });
      }
    }

    const rawReusedMedia = req.body?.reused_media_json ? String(req.body.reused_media_json) : '';
    if (rawReusedMedia) {
      const reusedMap = JSON.parse(rawReusedMedia) as Record<string, Partial<InputMediaInfo>>;
      if (reusedMap && typeof reusedMap === 'object') {
        for (const [mediaKey, info] of Object.entries(reusedMap)) {
          if (handledMediaKeys.has(mediaKey) || !info || typeof info !== 'object') continue;
          const parts = mediaKey.split(':');
          if (parts.length < 2) continue;
          const nodeId = String(info.node_id || parts[0]);
          const fieldName = String(info.field_name || parts.slice(1).join(':'));
          const safePath = info.filename ? resolveSafeOutputsPath(info.filename) : null;
          if (safePath && fs.existsSync(safePath)) {
            const buffer = fs.readFileSync(safePath);
            const origName = info.original_filename || path.basename(safePath);
            const mimeType = guessMimeType(origName);
            const uploadedName = await uploadMediaToComfyUI(comfyUrl, buffer, origName, mimeType);
            if (workflowCopy[nodeId]?.inputs) {
              workflowCopy[nodeId].inputs[fieldName] = uploadedName;
              submittedInputs[mediaKey] = uploadedName;
            }
            handledMediaKeys.add(mediaKey);
            pendingInputMedia.push({
              key: mediaKey,
              node_id: nodeId,
              field_name: fieldName,
              label: info.label || fieldLabelByKey.get(mediaKey),
              original_filename: origName,
              comfy_name: uploadedName,
              media_type:
                info.media_type === 'video' || info.media_type === 'image'
                  ? info.media_type
                  : detectMediaTypeFromFilename(origName, mimeType),
              buffer,
            });
          } else if (info.comfy_name) {
            if (workflowCopy[nodeId]?.inputs) {
              workflowCopy[nodeId].inputs[fieldName] = info.comfy_name;
              submittedInputs[mediaKey] = info.comfy_name;
            }
          }
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

  // Persist local copies of uploaded/reused input media under <category>/<prompt_id>/inputs/
  const catDir = safeDirSegment(workflowTemplate.category_name, 'uncategorized');
  const promptDirSeg = safeDirSegment(promptId, 'unknown');
  const savedInputMedia: InputMediaInfo[] = [];
  if (pendingInputMedia.length > 0) {
    const inputsTargetDir = path.join(OUTPUTS_DIR, catDir, promptDirSeg, 'inputs');
    fs.mkdirSync(inputsTargetDir, { recursive: true });
    for (const item of pendingInputMedia) {
      const ext = path.extname(item.original_filename) || (item.media_type === 'video' ? '.mp4' : '.png');
      const baseSlug = safeDirSegment(item.field_name, 'input');
      const localName = `${baseSlug}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}${ext}`;
      const localPath = path.join(inputsTargetDir, localName);
      fs.writeFileSync(localPath, item.buffer);
      const relInputName = `${catDir}/${promptDirSeg}/inputs/${localName}`;
      const inputMeta = extractMediaMetadataFromFile(localPath, item.media_type, relInputName);
      savedInputMedia.push({
        key: item.key,
        node_id: item.node_id,
        field_name: item.field_name,
        label: item.label,
        filename: relInputName,
        original_filename: item.original_filename,
        comfy_name: item.comfy_name,
        url: buildOutputUrl(catDir, promptDirSeg, 'inputs', localName),
        media_type: item.media_type,
        width: inputMeta.width,
        height: inputMeta.height,
        duration_seconds: inputMeta.duration_seconds,
        file_size: inputMeta.file_size,
      });
    }
  }

  registerQueuedTask(
    {
      prompt_id: promptId,
      client_id: clientId,
      queue_number: null,
      queue_position: null,
      state: 'queued',
      workflow_id: workflowTemplate.id,
      workflow_name: workflowTemplate.name,
      category_name: workflowTemplate.category_name,
      source: 'comfycentre',
      node_count: Object.keys(workflowCopy).length,
      current_node_id: null,
      current_node_title: null,
      step_value: null,
      step_max: null,
      progress_percent: 0,
      submitted_inputs: submittedInputs,
      error_message: null,
      started_at: new Date(startedAt).toISOString(),
      finished_at: null,
      duration_ms: null,
    },
    startedAt,
  );

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
      const outputs = await downloadComfyOutputs(
        comfyUrl,
        promptId,
        workflowTemplate.output_node_ids,
        workflowTemplate.category_name,
      );
      const durationMs = Date.now() - startedAt;
      const hasVideo = outputs.some((o) => o.media_type === 'video');
      const primaryMediaType: 'image' | 'video' =
        workflowTemplate.output_type === 'video' || hasVideo ? 'video' : 'image';
      const primaryUrl = outputs[0]?.url || '';

      const insertResult = db
        .prepare(`
          INSERT INTO generations (
            workflow_id, workflow_name, category_name, prompt_id, client_id,
            status, media_type, primary_output_url, outputs_json, input_media_json, submitted_inputs_json, duration_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          JSON.stringify(savedInputMedia),
          JSON.stringify(submittedInputs),
          durationMs,
        );

      const savedRow = db
        .prepare('SELECT * FROM generations WHERE id = ?')
        .get(Number(insertResult.lastInsertRowid));
      const generation = mapGenerationRow(savedRow!);

      updateTrackedTask(promptId, {
        state: 'completed',
        progress_percent: 100,
        current_node_id: null,
        current_node_title: null,
        outputs,
        finished_at: new Date().toISOString(),
        duration_ms: durationMs,
      });

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
      updateTrackedTask(promptId, {
        state: 'failed',
        error_message: msg,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
      });
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
        updateTrackedTask(promptId, {
          state: 'running',
          current_node_id: nodeId,
          current_node_title: nodeTitle,
        });
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
      updateTrackedTask(promptId, {
        state: 'running',
        step_value: value,
        step_max: max,
        progress_percent: percent,
      });
      emitSseEvent(clientId, {
        type: 'progress',
        client_id: clientId,
        prompt_id: promptId,
        value,
        max,
        percent,
      });
    } else if (msgType === 'execution_interrupted') {
      finished = true;
      ws.close();
      const errMsg = 'Generation interrupted by user';
      updateTrackedTask(promptId, {
        state: 'cancelled',
        error_message: errMsg,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
      });
      emitSseEvent(clientId, {
        type: 'error',
        client_id: clientId,
        prompt_id: promptId,
        message: errMsg,
      });
    } else if (msgType === 'execution_error') {
      finished = true;
      ws.close();
      const errMsg = String(data.exception_message || 'ComfyUI execution error');
      updateTrackedTask(promptId, {
        state: 'failed',
        error_message: errMsg,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
      });
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
      const errMsg = err.message || 'ComfyUI WebSocket disconnected';
      updateTrackedTask(promptId, {
        state: 'failed',
        error_message: errMsg,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
      });
      emitSseEvent(clientId, {
        type: 'error',
        client_id: clientId,
        prompt_id: promptId,
        message: errMsg,
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

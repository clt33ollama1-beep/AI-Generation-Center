import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  FileJson,
  FolderPlus,
  Plus,
  Save,
  Trash2,
  Upload,
} from 'lucide-react';
import { api } from '../lib/api.ts';
import type {
  Category,
  ComfyApiWorkflow,
  InspectedNode,
  OutputMediaType,
  UIInputField,
  WidgetType,
  WorkflowTemplate,
} from '../types/comfy.ts';

interface TemplatesViewProps {
  categories: Category[];
  workflows: WorkflowTemplate[];
  createModeTrigger: number;
  onRefreshData: () => Promise<void>;
  onOpenInWorkspace: (workflowId: number) => void;
}

const WIDGET_OPTIONS: Array<{ value: WidgetType; label: string }> = [
  { value: 'text', label: 'Text Input' },
  { value: 'textarea', label: 'Textarea (Prompt)' },
  { value: 'number', label: 'Number' },
  { value: 'slider', label: 'Slider' },
  { value: 'seed_randomizer', label: 'Seed Randomizer' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'select', label: 'Select Dropdown' },
  { value: 'image_upload', label: 'Media Upload' },
];

export const TemplatesView: React.FC<TemplatesViewProps> = ({
  categories,
  workflows,
  createModeTrigger,
  onRefreshData,
  onOpenInWorkspace,
}) => {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState<number>(categories[0]?.id || 0);
  const [outputType, setOutputType] = useState<OutputMediaType>('auto');
  const [rawJsonText, setRawJsonText] = useState('');
  const [parsedWorkflow, setParsedWorkflow] = useState<ComfyApiWorkflow | null>(null);
  const [inspectedNodes, setInspectedNodes] = useState<InspectedNode[]>([]);
  const [mappedFields, setMappedFields] = useState<Record<string, UIInputField>>({});

  const [newCategoryName, setNewCategoryName] = useState('');
  const [addingCategory, setAddingCategory] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const startNewTemplate = () => {
    setEditingId(null);
    setName('');
    setDescription('');
    setCategoryId(categories[0]?.id || 0);
    setOutputType('auto');
    setRawJsonText('');
    setParsedWorkflow(null);
    setInspectedNodes([]);
    setMappedFields({});
    setError(null);
    setNotice(null);
  };

  useEffect(() => {
    if (createModeTrigger > 0) {
      startNewTemplate();
    }
  }, [createModeTrigger]);

  useEffect(() => {
    if (!categoryId && categories.length > 0) {
      setCategoryId(categories[0].id);
    }
  }, [categories, categoryId]);

  const loadTemplateForEdit = async (wf: WorkflowTemplate) => {
    setEditingId(wf.id);
    setName(wf.name);
    setDescription(wf.description);
    setCategoryId(wf.category_id);
    setOutputType(wf.output_type);
    setParsedWorkflow(wf.comfy_api_json);
    setRawJsonText(JSON.stringify(wf.comfy_api_json, null, 2));
    setError(null);
    setNotice(null);

    const mapped: Record<string, UIInputField> = {};
    for (const field of wf.ui_inputs) {
      mapped[`${field.node_id}:${field.field_name}`] = { ...field };
    }
    setMappedFields(mapped);

    try {
      setInspecting(true);
      const res = await api.inspectWorkflow(wf.comfy_api_json);
      setInspectedNodes(res.nodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to inspect workflow');
    } finally {
      setInspecting(false);
    }
  };

  const runInspect = async (jsonString: string) => {
    setError(null);
    setNotice(null);
    let parsed: ComfyApiWorkflow;
    try {
      parsed = JSON.parse(jsonString) as ComfyApiWorkflow;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON root must be an object keyed by ComfyUI node IDs');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid JSON format');
      return;
    }

    setInspecting(true);
    try {
      const res = await api.inspectWorkflow(parsed);
      setParsedWorkflow(parsed);
      setInspectedNodes(res.nodes);
      if (res.nodes.length === 0) {
        setError('No editable primitive inputs found. Make sure you exported using "Save (API Format)" in ComfyUI.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to inspect ComfyUI JSON');
    } finally {
      setInspecting(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setRawJsonText(text);
    if (!name.trim()) {
      setName(file.name.replace(/\.json$/i, ''));
    }
    await runInspect(text);
  };

  const toggleFieldMapping = (
    node: InspectedNode,
    input: InspectedNode['inputs'][number],
    checked: boolean,
  ) => {
    const key = `${node.node_id}:${input.field_name}`;
    setMappedFields((prev) => {
      const next = { ...prev };
      if (!checked) {
        delete next[key];
      } else {
        const currentCount = Object.keys(next).length;
        const cleanFieldLabel = input.field_name
          .replace(/_/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase());
        next[key] = {
          id: key,
          node_id: node.node_id,
          class_type: node.class_type,
          field_name: input.field_name,
          label: `${node.title} — ${cleanFieldLabel}`,
          widget: input.suggested_widget,
          value_type: input.value_type,
          default_value: input.default_value,
          min: input.value_type === 'int' || input.value_type === 'float' ? 0 : undefined,
          max: input.value_type === 'int' || input.value_type === 'float' ? 100 : undefined,
          step: input.value_type === 'float' ? 0.1 : 1,
          options: input.suggested_widget === 'select' ? [String(input.default_value)] : undefined,
          order: currentCount + 1,
        };
      }
      return next;
    });
  };

  const updateMappedField = (key: string, patch: Partial<UIInputField>) => {
    setMappedFields((prev) => {
      const existing = prev[key];
      if (!existing) return prev;
      return {
        ...prev,
        [key]: { ...existing, ...patch },
      };
    });
  };

  const handleSaveTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);

    if (!name.trim()) {
      setError('Template name is required');
      return;
    }
    if (!categoryId) {
      setError('Select or create a category');
      return;
    }
    if (!parsedWorkflow) {
      setError('Inspect a valid ComfyUI API JSON workflow first');
      return;
    }

    const uiInputs = Object.values(mappedFields).sort((a, b) => a.order - b.order);
    setSaving(true);
    try {
      if (editingId) {
        const updated = await api.updateWorkflow(editingId, {
          name: name.trim(),
          description: description.trim(),
          category_id: categoryId,
          output_type: outputType,
          comfy_api_json: parsedWorkflow,
          ui_inputs: uiInputs,
        });
        await onRefreshData();
        setNotice(`Saved changes to "${updated.name}".`);
      } else {
        const created = await api.createWorkflow({
          name: name.trim(),
          description: description.trim(),
          category_id: categoryId,
          output_type: outputType,
          comfy_api_json: parsedWorkflow,
          ui_inputs: uiInputs,
        });
        setEditingId(created.id);
        await onRefreshData();
        setNotice(`Created template "${created.name}".`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save template');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteTemplate = async (id: number, wfName: string) => {
    try {
      await api.deleteWorkflow(id);
      if (editingId === id) {
        startNewTemplate();
      }
      await onRefreshData();
      setNotice(`Deleted "${wfName}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete template');
    }
  };

  const handleCreateCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCategoryName.trim()) return;
    try {
      const created = await api.createCategory({ name: newCategoryName.trim() });
      setNewCategoryName('');
      setAddingCategory(false);
      await onRefreshData();
      setCategoryId(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create category');
    }
  };

  const handleDeleteCategory = async (id: number) => {
    try {
      await api.deleteCategory(id);
      await onRefreshData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete category');
    }
  };

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden bg-[#0B0D11]">
      {/* Left Sidebar: Categories & Saved Templates */}
      <aside className="w-[300px] shrink-0 border-r border-zinc-800/80 bg-[#12151B] flex flex-col min-h-0">
        <div className="p-4 border-b border-zinc-800/80 flex items-center justify-between">
          <h2 className="font-display text-sm font-semibold text-zinc-100">Templates</h2>
          <button
            type="button"
            onClick={startNewTemplate}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-100 rounded transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            New
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-5">
          {categories.map((cat) => {
            const catWorkflows = workflows.filter((w) => w.category_id === cat.id);
            return (
              <div key={cat.id} className="space-y-1.5">
                <div className="flex items-center justify-between px-2 text-xs">
                  <span className="font-medium text-zinc-400 truncate">{cat.name}</span>
                  {catWorkflows.length === 0 && categories.length > 1 && (
                    <button
                      type="button"
                      onClick={() => void handleDeleteCategory(cat.id)}
                      title="Delete empty category"
                      className="text-zinc-600 hover:text-red-400 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>

                <div className="space-y-1">
                  {catWorkflows.length === 0 ? (
                    <p className="px-2 py-1 text-[11px] text-zinc-600">No templates</p>
                  ) : (
                    catWorkflows.map((wf) => (
                      <div
                        key={wf.id}
                        className={`group flex items-center justify-between gap-2 px-3 py-2 rounded-md border text-xs transition-colors ${
                          editingId === wf.id
                            ? 'border-blue-500/50 bg-blue-600/15 text-blue-200'
                            : 'border-transparent hover:bg-zinc-800/60 text-zinc-300'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => void loadTemplateForEdit(wf)}
                          className="flex-1 text-left truncate font-medium cursor-pointer"
                        >
                          {wf.name}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteTemplate(wf.id, wf.name)}
                          title="Delete template"
                          className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 transition-opacity cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="p-3 border-t border-zinc-800/80">
          {addingCategory ? (
            <form onSubmit={handleCreateCategory} className="flex items-center gap-1.5">
              <input
                type="text"
                autoFocus
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                placeholder="Category name"
                className="flex-1 px-2.5 py-1.5 text-xs bg-[#0B0D11] border border-zinc-800 rounded text-zinc-100 focus:outline-none focus:border-blue-500"
              />
              <button
                type="submit"
                className="px-2.5 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded cursor-pointer"
              >
                Add
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setAddingCategory(true)}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-800/60 hover:bg-zinc-800 rounded-md transition-colors cursor-pointer"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              Add Category
            </button>
          )}
        </div>
      </aside>

      {/* Main Panel: Workflow Inspector & Input Mapping */}
      <main className="flex-1 min-w-0 overflow-y-auto">
        <form onSubmit={handleSaveTemplate} className="max-w-5xl mx-auto p-6 space-y-8">
          <div className="flex items-start justify-between gap-4 pb-4 border-b border-zinc-800/80">
            <div>
              <h1 className="font-display text-xl font-semibold text-zinc-100">
                {editingId ? `Edit Template: ${name || 'Untitled'}` : 'Create Workflow Template'}
              </h1>
              <p className="text-xs text-zinc-400 mt-1">
                Upload a ComfyUI "Save (API Format)" JSON file to inspect nodes and map primitive inputs to generation controls.
              </p>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              {editingId && (
                <button
                  type="button"
                  onClick={() => onOpenInWorkspace(editingId)}
                  className="px-3.5 py-2 text-xs font-medium text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-md transition-colors cursor-pointer"
                >
                  Open in Workspace
                </button>
              )}
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-md transition-colors cursor-pointer disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" />
                {saving ? 'Saving...' : 'Save Template'}
              </button>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2.5 p-3.5 rounded-md border border-red-900/60 bg-red-950/30 text-xs text-red-300">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {notice && (
            <div className="flex items-center gap-2.5 p-3.5 rounded-md border border-emerald-900/60 bg-emerald-950/30 text-xs text-emerald-300">
              <Check className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{notice}</span>
            </div>
          )}

          {/* Template Metadata */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Template Name
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Flux.1 Dev Portrait"
                className="w-full px-3 py-2 text-sm bg-[#12151B] border border-zinc-800 rounded-md text-zinc-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">Category</label>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm bg-[#12151B] border border-zinc-800 rounded-md text-zinc-100 focus:outline-none focus:border-blue-500"
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Expected Output Media
              </label>
              <select
                value={outputType}
                onChange={(e) => setOutputType(e.target.value as OutputMediaType)}
                className="w-full px-3 py-2 text-sm bg-[#12151B] border border-zinc-800 rounded-md text-zinc-100 focus:outline-none focus:border-blue-500"
              >
                <option value="auto">Auto-Detect (Image / Video)</option>
                <option value="image">Image (PNG / JPG / WEBP)</option>
                <option value="video">Video (MP4 / WEBM / GIF)</option>
              </select>
            </div>

            <div className="md:col-span-3">
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Description
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Short summary of model checkpoints, aspect ratio, or expected inputs"
                className="w-full px-3 py-2 text-sm bg-[#12151B] border border-zinc-800 rounded-md text-zinc-100 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {/* ComfyUI API JSON Upload / Paste */}
          <div className="rounded-lg border border-zinc-800 bg-[#12151B] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <FileJson className="w-4 h-4 text-zinc-400" />
                <h3 className="text-sm font-semibold text-zinc-100">
                  ComfyUI API Format JSON
                </h3>
              </div>

              <div className="flex items-center gap-2.5">
                <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-md transition-colors cursor-pointer">
                  <Upload className="w-3.5 h-3.5" />
                  Upload .json
                  <input
                    type="file"
                    accept=".json,application/json"
                    className="sr-only"
                    onChange={handleFileUpload}
                  />
                </label>
                <button
                  type="button"
                  disabled={!rawJsonText.trim() || inspecting}
                  onClick={() => void runInspect(rawJsonText)}
                  className="px-3.5 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-md transition-colors cursor-pointer disabled:opacity-50"
                >
                  {inspecting ? 'Inspecting...' : 'Inspect Nodes'}
                </button>
              </div>
            </div>

            <textarea
              rows={6}
              value={rawJsonText}
              onChange={(e) => setRawJsonText(e.target.value)}
              placeholder='Paste JSON exported from ComfyUI via "Save (API Format)"...'
              className="w-full px-3 py-2.5 text-xs font-mono bg-[#0B0D11] border border-zinc-800 rounded-md text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Dynamic Node Field Mapper */}
          {inspectedNodes.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-zinc-100">
                  Node Input Mapping ({Object.keys(mappedFields).length} exposed)
                </h3>
                <span className="text-xs text-zinc-500 tabular-nums">
                  {inspectedNodes.length} nodes with editable fields
                </span>
              </div>

              <div className="space-y-4">
                {inspectedNodes.map((node) => (
                  <div
                    key={node.node_id}
                    className="rounded-lg border border-zinc-800 bg-[#12151B] overflow-hidden"
                  >
                    <div className="px-4 py-2.5 border-b border-zinc-800/80 bg-[#161A22] flex items-center justify-between text-xs">
                      <span className="font-medium text-zinc-200">{node.title}</span>
                      <span className="font-mono text-zinc-500 tabular-nums">
                        Node {node.node_id} · {node.class_type}
                      </span>
                    </div>

                    <div className="divide-y divide-zinc-800/60">
                      {node.inputs.map((inp) => {
                        const key = `${node.node_id}:${inp.field_name}`;
                        const mapped = mappedFields[key];
                        const isChecked = Boolean(mapped);

                        return (
                          <div key={key} className="p-4 space-y-3">
                            <div className="flex items-center justify-between gap-4">
                              <label className="flex items-center gap-2.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={(e) =>
                                    toggleFieldMapping(node, inp, e.target.checked)
                                  }
                                  className="w-4 h-4 rounded border-zinc-700 bg-[#0B0D11] text-blue-600"
                                />
                                <span className="text-xs font-mono text-zinc-200">
                                  {inp.field_name}
                                </span>
                                <span className="text-[11px] font-mono text-zinc-500">
                                  ({inp.value_type})
                                </span>
                              </label>
                              <span className="text-[11px] font-mono text-zinc-500 truncate max-w-xs">
                                Default: {String(inp.default_value)}
                              </span>
                            </div>

                            {isChecked && mapped && (
                              <div className="pl-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-1">
                                <div>
                                  <label className="block text-[11px] text-zinc-400 mb-1">
                                    Form Label
                                  </label>
                                  <input
                                    type="text"
                                    value={mapped.label}
                                    onChange={(e) =>
                                      updateMappedField(key, { label: e.target.value })
                                    }
                                    className="w-full px-2.5 py-1.5 text-xs bg-[#0B0D11] border border-zinc-800 rounded text-zinc-100 focus:outline-none focus:border-blue-500"
                                  />
                                </div>

                                <div>
                                  <label className="block text-[11px] text-zinc-400 mb-1">
                                    UI Widget
                                  </label>
                                  <select
                                    value={mapped.widget}
                                    onChange={(e) =>
                                      updateMappedField(key, {
                                        widget: e.target.value as WidgetType,
                                      })
                                    }
                                    className="w-full px-2.5 py-1.5 text-xs bg-[#0B0D11] border border-zinc-800 rounded text-zinc-100 focus:outline-none focus:border-blue-500"
                                  >
                                    {WIDGET_OPTIONS.map((opt) => (
                                      <option key={opt.value} value={opt.value}>
                                        {opt.label}
                                      </option>
                                    ))}
                                  </select>
                                </div>

                                <div>
                                  <label className="block text-[11px] text-zinc-400 mb-1">
                                    Default Value
                                  </label>
                                  <input
                                    type="text"
                                    value={String(mapped.default_value ?? '')}
                                    onChange={(e) => {
                                      const raw = e.target.value;
                                      let val: string | number | boolean = raw;
                                      if (mapped.value_type === 'int') {
                                        val = parseInt(raw || '0', 10);
                                      } else if (mapped.value_type === 'float') {
                                        val = parseFloat(raw || '0');
                                      } else if (mapped.value_type === 'boolean') {
                                        val = raw === 'true';
                                      }
                                      updateMappedField(key, { default_value: val });
                                    }}
                                    className="w-full px-2.5 py-1.5 text-xs font-mono bg-[#0B0D11] border border-zinc-800 rounded text-zinc-100 focus:outline-none focus:border-blue-500"
                                  />
                                </div>

                                <div>
                                  <label className="block text-[11px] text-zinc-400 mb-1">
                                    Sort Order
                                  </label>
                                  <input
                                    type="number"
                                    value={mapped.order}
                                    onChange={(e) =>
                                      updateMappedField(key, {
                                        order: parseInt(e.target.value || '1', 10),
                                      })
                                    }
                                    className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums bg-[#0B0D11] border border-zinc-800 rounded text-zinc-100 focus:outline-none focus:border-blue-500"
                                  />
                                </div>

                                {(mapped.widget === 'slider' || mapped.widget === 'number') && (
                                  <>
                                    <div>
                                      <label className="block text-[11px] text-zinc-400 mb-1">
                                        Min
                                      </label>
                                      <input
                                        type="number"
                                        step="any"
                                        value={mapped.min ?? 0}
                                        onChange={(e) =>
                                          updateMappedField(key, {
                                            min: parseFloat(e.target.value || '0'),
                                          })
                                        }
                                        className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums bg-[#0B0D11] border border-zinc-800 rounded text-zinc-100"
                                      />
                                    </div>
                                    <div>
                                      <label className="block text-[11px] text-zinc-400 mb-1">
                                        Max
                                      </label>
                                      <input
                                        type="number"
                                        step="any"
                                        value={mapped.max ?? 100}
                                        onChange={(e) =>
                                          updateMappedField(key, {
                                            max: parseFloat(e.target.value || '100'),
                                          })
                                        }
                                        className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums bg-[#0B0D11] border border-zinc-800 rounded text-zinc-100"
                                      />
                                    </div>
                                    <div>
                                      <label className="block text-[11px] text-zinc-400 mb-1">
                                        Step
                                      </label>
                                      <input
                                        type="number"
                                        step="any"
                                        value={mapped.step ?? 1}
                                        onChange={(e) =>
                                          updateMappedField(key, {
                                            step: parseFloat(e.target.value || '1'),
                                          })
                                        }
                                        className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums bg-[#0B0D11] border border-zinc-800 rounded text-zinc-100"
                                      />
                                    </div>
                                  </>
                                )}

                                {mapped.widget === 'select' && (
                                  <div className="sm:col-span-2 lg:col-span-4">
                                    <label className="block text-[11px] text-zinc-400 mb-1">
                                      Dropdown Options (comma-separated)
                                    </label>
                                    <input
                                      type="text"
                                      value={(mapped.options || []).join(', ')}
                                      onChange={(e) =>
                                        updateMappedField(key, {
                                          options: e.target.value
                                            .split(',')
                                            .map((s) => s.trim())
                                            .filter(Boolean),
                                        })
                                      }
                                      placeholder="option_a, option_b, option_c"
                                      className="w-full px-2.5 py-1.5 text-xs font-mono bg-[#0B0D11] border border-zinc-800 rounded text-zinc-100"
                                    />
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </form>
      </main>
    </div>
  );
};

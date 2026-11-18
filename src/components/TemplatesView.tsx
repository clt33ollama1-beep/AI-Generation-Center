import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  FileJson,
  FolderPlus,
  Pencil,
  Plus,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { api } from '../lib/api.ts';
import type {
  AppInputHint,
  Category,
  ComfyApiWorkflow,
  InspectedNode,
  InspectedOutput,
  OutputMediaType,
  UIInputField,
  WidgetType,
  WorkflowInspectResponse,
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
  const [outputNodeIds, setOutputNodeIds] = useState<string[]>([]);
  const [rawJsonText, setRawJsonText] = useState('');
  const [parsedWorkflow, setParsedWorkflow] = useState<ComfyApiWorkflow | null>(null);
  const [inspectedNodes, setInspectedNodes] = useState<InspectedNode[]>([]);
  const [inspectedOutputs, setInspectedOutputs] = useState<InspectedOutput[]>([]);
  const [appInputs, setAppInputs] = useState<AppInputHint[]>([]);
  const [lastInspectRes, setLastInspectRes] = useState<WorkflowInspectResponse | null>(null);
  const [mappedFields, setMappedFields] = useState<Record<string, UIInputField>>({});

  const [newCategoryName, setNewCategoryName] = useState('');
  const [addingCategory, setAddingCategory] = useState(false);
  const [editingCatId, setEditingCatId] = useState<number | null>(null);
  const [editingCatName, setEditingCatName] = useState('');
  const [savingCategoryId, setSavingCategoryId] = useState<number | null>(null);
  const [confirmDeleteCatId, setConfirmDeleteCatId] = useState<number | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [nodeFilter, setNodeFilter] = useState('');

  const buildDefaultMappedField = (
    node: InspectedNode,
    input: InspectedNode['inputs'][number],
    order: number,
  ): UIInputField => {
    const key = `${node.node_id}:${input.field_name}`;
    const cleanFieldLabel = input.field_name
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
    const numDefault = typeof input.default_value === 'number' ? input.default_value : 0;
    const isNumeric = input.value_type === 'int' || input.value_type === 'float';
    return {
      id: key,
      node_id: node.node_id,
      class_type: node.class_type,
      field_name: input.field_name,
      label: `${node.title} — ${cleanFieldLabel}`,
      widget: input.suggested_widget,
      value_type: input.value_type,
      default_value: input.default_value,
      min: input.suggested_widget === 'slider' ? Math.min(0, numDefault) : undefined,
      max: input.suggested_widget === 'slider' ? Math.max(100, numDefault) : undefined,
      step: isNumeric ? (input.value_type === 'float' ? 0.1 : 1) : undefined,
      options: input.suggested_widget === 'select' ? [String(input.default_value)] : undefined,
      order,
    };
  };

  const applyAppSchemaDefaults = (res: WorkflowInspectResponse): number => {
    const suggestedKeys = res.suggested_field_keys || [];
    let autoMappedCount = 0;
    if (suggestedKeys.length > 0) {
      const autoMapped: Record<string, UIInputField> = {};
      let order = 1;
      for (const key of suggestedKeys) {
        const colonIdx = key.indexOf(':');
        if (colonIdx === -1) continue;
        const targetNodeId = key.slice(0, colonIdx);
        const targetFieldName = key.slice(colonIdx + 1);
        const foundNode = res.nodes.find((n) => n.node_id === targetNodeId);
        const foundInput = foundNode?.inputs.find((i) => i.field_name === targetFieldName);
        if (foundNode && foundInput) {
          autoMapped[key] = buildDefaultMappedField(foundNode, foundInput, order++);
          autoMappedCount++;
        }
      }
      if (autoMappedCount > 0) {
        setMappedFields(autoMapped);
      }
    }
    if (res.suggested_output_type && res.suggested_output_type !== 'auto') {
      setOutputType(res.suggested_output_type);
    }
    if (res.suggested_output_node_ids) {
      setOutputNodeIds(res.suggested_output_node_ids);
    }
    return autoMappedCount;
  };

  const startNewTemplate = () => {
    setEditingId(null);
    setName('');
    setDescription('');
    setCategoryId(categories[0]?.id || 0);
    setOutputType('auto');
    setOutputNodeIds([]);
    setRawJsonText('');
    setParsedWorkflow(null);
    setInspectedNodes([]);
    setInspectedOutputs([]);
    setAppInputs([]);
    setLastInspectRes(null);
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
    setOutputNodeIds(wf.output_node_ids || []);
    setParsedWorkflow(wf.comfy_api_json);
    setRawJsonText(JSON.stringify(wf.comfy_api_json, null, 2));
    setAppInputs([]);
    setLastInspectRes(null);
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
      setInspectedOutputs(res.outputs || []);
      setAppInputs(res.app_inputs || []);
      setLastInspectRes(res);
      if ((!wf.output_node_ids || wf.output_node_ids.length === 0) && res.suggested_output_node_ids?.length) {
        setOutputNodeIds(res.suggested_output_node_ids);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to inspect workflow');
    } finally {
      setInspecting(false);
    }
  };

  const runInspect = async (jsonString: string, resetMapping = false) => {
    setError(null);
    setNotice(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonString) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON root must be a ComfyUI workflow or API JSON object');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid JSON format');
      return;
    }

    setInspecting(true);
    try {
      const res = await api.inspectWorkflow(parsed);
      const executableWorkflow = (res.converted_api_json || parsed) as ComfyApiWorkflow;
      setParsedWorkflow(executableWorkflow);
      setInspectedNodes(res.nodes);
      setInspectedOutputs(res.outputs || []);
      setAppInputs(res.app_inputs || []);
      setLastInspectRes(res);

      let autoMappedCount = 0;
      if (resetMapping || Object.keys(mappedFields).length === 0) {
        autoMappedCount = applyAppSchemaDefaults(res);
      } else if (outputNodeIds.length === 0 && res.suggested_output_node_ids?.length) {
        setOutputNodeIds(res.suggested_output_node_ids);
        if (outputType === 'auto' && res.suggested_output_type && res.suggested_output_type !== 'auto') {
          setOutputType(res.suggested_output_type);
        }
      }

      if (res.nodes.length === 0) {
        setError('No editable primitive inputs found in this ComfyUI JSON.');
      } else if (res.source_format === 'workflow' && res.conversion_stats) {
        const stats = res.conversion_stats;
        const outputSummary =
          (res.suggested_output_node_ids?.length || 0) > 0
            ? ` Primary output node: ${res.suggested_output_node_ids!.join(', ')} (${res.suggested_output_type || 'auto'}).`
            : '';
        const autoHint =
          autoMappedCount > 0 ? ` Loaded ${autoMappedCount} .app.json input controls.` : '';
        setNotice(
          `Converted ComfyUI workflow graph to API format (${stats.converted_api_nodes} active nodes, ${stats.skipped_nodes} bypassed/virtual nodes omitted).${autoHint}${outputSummary}`,
        );
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
      setName(file.name.replace(/(\.app)?\.json$/i, ''));
    }
    await runInspect(text, !editingId);
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
        next[key] = buildDefaultMappedField(node, input, currentCount + 1);
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
          output_node_ids: outputNodeIds,
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
          output_node_ids: outputNodeIds,
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

  const toggleOutputNode = (nodeId: string, checked: boolean) => {
    setOutputNodeIds((prev) => {
      if (checked) {
        return prev.includes(nodeId) ? prev : [...prev, nodeId];
      }
      return prev.filter((id) => id !== nodeId);
    });
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
    const trimmed = newCategoryName.trim();
    if (!trimmed) return;
    try {
      setCategoryError(null);
      setError(null);
      const created = await api.createCategory({ name: trimmed });
      setNewCategoryName('');
      setAddingCategory(false);
      await onRefreshData();
      setCategoryId(created.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create category';
      setCategoryError(msg);
      setError(msg);
    }
  };

  const handleStartEditCategory = (cat: Category) => {
    setConfirmDeleteCatId(null);
    setEditingCatId(cat.id);
    setEditingCatName(cat.name || '');
    setCategoryError(null);
    setError(null);
  };

  const handleSaveCategoryEdit = async (e: React.FormEvent, id: number) => {
    e.preventDefault();
    if (savingCategoryId === id) return;
    const trimmed = editingCatName.trim();
    if (!trimmed) {
      setCategoryError('Category name is required');
      setError('Category name is required');
      return;
    }
    try {
      setSavingCategoryId(id);
      setCategoryError(null);
      setError(null);
      const updated = await api.updateCategory(id, { name: trimmed });
      setEditingCatId(null);
      setEditingCatName('');
      await onRefreshData();
      setNotice(`Updated category to "${updated.name}".`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update category';
      setCategoryError(msg);
      setError(msg);
    } finally {
      setSavingCategoryId(null);
    }
  };

  const handleDeleteCategory = async (cat: Category) => {
    try {
      setCategoryError(null);
      setError(null);
      const result = await api.deleteCategory(cat.id);
      setConfirmDeleteCatId(null);
      if (editingCatId === cat.id) {
        setEditingCatId(null);
      }
      await onRefreshData();
      if (categoryId === cat.id) {
        if (result.uncategorized_category_id) {
          setCategoryId(result.uncategorized_category_id);
        } else {
          const fallback = categories.find((c) => c.id !== cat.id);
          setCategoryId(fallback?.id || 0);
        }
      }
      if ((result.reassigned_count || 0) > 0) {
        setNotice(
          `Deleted category "${cat.name}" and moved ${result.reassigned_count} template(s) to "Uncategorized".`,
        );
      } else {
        setNotice(`Deleted category "${cat.name}".`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete category';
      setCategoryError(msg);
      setError(msg);
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
          {categoryError && (
            <div className="p-2.5 rounded border border-red-900/60 bg-red-950/30 text-[11px] text-red-300 flex items-start justify-between gap-2">
              <span className="break-words">{categoryError}</span>
              <button
                type="button"
                onClick={() => setCategoryError(null)}
                className="text-red-400 hover:text-red-200 cursor-pointer shrink-0"
                aria-label="Dismiss category error"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          {categories.map((cat) => {
            const catWorkflows = workflows.filter((w) => w.category_id === cat.id);
            const isUncategorized =
              (cat.slug || '').toLowerCase() === 'uncategorized' ||
              (cat.name || '').trim().toLowerCase() === 'uncategorized';
            const canDeleteCategory =
              !(isUncategorized && (catWorkflows.length > 0 || categories.length <= 1));
            const isEditingThisCat = editingCatId === cat.id;
            const isConfirmingDelete = confirmDeleteCatId === cat.id;
            const isSavingThisCat = savingCategoryId === cat.id;

            return (
              <div key={cat.id} className="space-y-1.5">
                {isEditingThisCat ? (
                  <form
                    onSubmit={(e) => void handleSaveCategoryEdit(e, cat.id)}
                    className="flex items-center gap-1 px-1"
                  >
                    <input
                      type="text"
                      autoFocus
                      disabled={isSavingThisCat}
                      value={editingCatName}
                      onChange={(e) => setEditingCatName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && e.nativeEvent.isComposing) {
                          e.preventDefault();
                        } else if (e.key === 'Escape') {
                          setEditingCatId(null);
                          setCategoryError(null);
                        }
                      }}
                      aria-label="Edit category name"
                      className="flex-1 min-w-0 px-2 py-1 text-xs bg-[#0B0D11] border border-blue-500 rounded text-zinc-100 focus:outline-none disabled:opacity-60"
                    />
                    <button
                      type="submit"
                      disabled={isSavingThisCat}
                      title="Save category name"
                      aria-label="Save category name"
                      className="p-1 text-emerald-400 hover:bg-zinc-800 rounded cursor-pointer shrink-0 disabled:opacity-50"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={isSavingThisCat}
                      onClick={() => {
                        setEditingCatId(null);
                        setCategoryError(null);
                      }}
                      title="Cancel"
                      aria-label="Cancel category edit"
                      className="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded cursor-pointer shrink-0 disabled:opacity-50"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </form>
                ) : (
                  <div className="group/cat flex items-center justify-between gap-2 px-2 text-xs">
                    <span className="font-medium text-zinc-400 truncate">
                      {cat.name}
                      <span className="ml-1.5 font-mono text-[11px] text-zinc-600 tabular-nums">
                        {catWorkflows.length}
                      </span>
                    </span>
                    <div className="flex items-center gap-1 opacity-70 group-hover/cat:opacity-100 transition-opacity shrink-0">
                      <button
                        type="button"
                        onClick={() => handleStartEditCategory(cat)}
                        title={`Edit category "${cat.name}"`}
                        aria-label={`Edit category ${cat.name}`}
                        className="p-1 text-zinc-500 hover:text-zinc-200 rounded hover:bg-zinc-800/80 transition-colors cursor-pointer"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      {canDeleteCategory && (
                        <button
                          type="button"
                          onClick={() => {
                            if (catWorkflows.length > 0) {
                              setEditingCatId(null);
                              setConfirmDeleteCatId(isConfirmingDelete ? null : cat.id);
                            } else {
                              void handleDeleteCategory(cat);
                            }
                          }}
                          title={
                            catWorkflows.length > 0
                              ? `Delete "${cat.name}" and move templates to Uncategorized`
                              : `Delete category "${cat.name}"`
                          }
                          aria-label={`Delete category ${cat.name}`}
                          className="p-1 text-zinc-500 hover:text-red-400 rounded hover:bg-zinc-800/80 transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {isConfirmingDelete && (
                  <div className="mx-1 p-2 rounded border border-amber-800/60 bg-amber-950/30 text-[11px] space-y-1.5">
                    <p className="text-amber-200 leading-snug">
                      Delete "{cat.name}" and move {catWorkflows.length} template
                      {catWorkflows.length > 1 ? 's' : ''} to Uncategorized?
                    </p>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void handleDeleteCategory(cat)}
                        className="px-2 py-1 text-[11px] font-medium bg-red-600 hover:bg-red-500 text-white rounded cursor-pointer"
                      >
                        Move & Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteCatId(null)}
                        className="px-2 py-1 text-[11px] font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

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
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.nativeEvent.isComposing) {
                    e.preventDefault();
                  } else if (e.key === 'Escape') {
                    setAddingCategory(false);
                    setNewCategoryName('');
                  }
                }}
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
                Upload a ComfyUI "Save (API Format)" or workflow graph JSON (.json / .app.json) file to inspect nodes and map inputs to generation controls.
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
                  ComfyUI Workflow / API JSON
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
              placeholder='Paste JSON exported from ComfyUI ("Save (API Format)" or standard workflow .json / .app.json)...'
              className="w-full px-3 py-2.5 text-xs font-mono bg-[#0B0D11] border border-zinc-800 rounded-md text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Loaded App Input & Output Schema */}
          {(appInputs.length > 0 || inspectedOutputs.length > 0) && (
            <div className="rounded-lg border border-zinc-800 bg-[#12151B] p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-zinc-800/80">
                <div>
                  <h3 className="text-sm font-semibold text-zinc-100">
                    Loaded Workflow Inputs & Outputs
                  </h3>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Detected output nodes and .app.json linearData input/output bindings for this template.
                  </p>
                </div>
                {lastInspectRes && (appInputs.length > 0 || (lastInspectRes.suggested_output_node_ids?.length || 0) > 0) && (
                  <button
                    type="button"
                    onClick={() => {
                      const count = applyAppSchemaDefaults(lastInspectRes);
                      setNotice(
                        `Loaded ${count} .app.json input controls and ${lastInspectRes.suggested_output_node_ids?.length || 0} output node(s).`,
                      );
                    }}
                    className="px-3 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-100 rounded-md transition-colors cursor-pointer"
                  >
                    Apply .app.json Defaults
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {appInputs.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-zinc-300">
                      Declared App Inputs ({appInputs.length})
                    </div>
                    <div className="divide-y divide-zinc-800/70 rounded-md border border-zinc-800 bg-[#0B0D11]">
                      {appInputs.map((item) => (
                        <div
                          key={item.key}
                          className="px-3 py-2 flex items-center justify-between gap-2 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="text-zinc-200 font-medium truncate">
                              {item.title} · <span className="font-mono">{item.field_name}</span>
                            </div>
                            <div className="text-[11px] font-mono text-zinc-500 truncate">
                              Node {item.node_id} · {item.class_type}
                              {!item.mapped && item.reason ? ` · ${item.reason}` : ''}
                            </div>
                          </div>
                          <span
                            className={`text-[11px] font-mono shrink-0 ${
                              item.mapped ? 'text-emerald-400' : 'text-zinc-500'
                            }`}
                          >
                            {item.mapped ? 'Mapped' : 'Skipped'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {inspectedOutputs.length > 0 && (
                  <div className={appInputs.length > 0 ? 'space-y-2' : 'lg:col-span-2 space-y-2'}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-zinc-300">
                        Captured Output Nodes ({outputNodeIds.length} selected)
                      </span>
                      <span className="text-[11px] text-zinc-500">
                        Prioritized during generation
                      </span>
                    </div>
                    <div className="divide-y divide-zinc-800/70 rounded-md border border-zinc-800 bg-[#0B0D11]">
                      {inspectedOutputs.map((out) => {
                        const checked = outputNodeIds.includes(out.node_id);
                        return (
                          <label
                            key={out.node_id}
                            className="px-3 py-2 flex items-center justify-between gap-3 text-xs cursor-pointer hover:bg-zinc-900/50"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => toggleOutputNode(out.node_id, e.target.checked)}
                                className="w-3.5 h-3.5 rounded border-zinc-700 bg-[#0B0D11] text-blue-600"
                              />
                              <div className="min-w-0">
                                <div className="text-zinc-200 font-medium truncate">
                                  {out.title}
                                  {out.is_primary_app_output && (
                                    <span className="ml-2 text-[11px] font-mono text-blue-400">
                                      App Output
                                    </span>
                                  )}
                                </div>
                                <div className="text-[11px] font-mono text-zinc-500 truncate">
                                  Node {out.node_id} · {out.class_type}
                                </div>
                              </div>
                            </div>
                            <span className="text-[11px] font-mono text-zinc-400 uppercase shrink-0">
                              {out.media_type} · {out.format}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Dynamic Node Field Mapper */}
          {inspectedNodes.length > 0 && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-zinc-100">
                  Node Input Mapping ({Object.keys(mappedFields).length} exposed)
                </h3>
                <div className="flex items-center gap-3">
                  {inspectedNodes.length > 6 && (
                    <input
                      type="text"
                      value={nodeFilter}
                      onChange={(e) => setNodeFilter(e.target.value)}
                      placeholder="Filter nodes or fields..."
                      className="px-2.5 py-1 text-xs bg-[#12151B] border border-zinc-800 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500"
                    />
                  )}
                  <span className="text-xs text-zinc-500 tabular-nums">
                    {inspectedNodes.length} nodes with editable fields
                  </span>
                </div>
              </div>

              <div className="space-y-4">
                {inspectedNodes
                  .filter((node) => {
                    const q = nodeFilter.trim().toLowerCase();
                    if (!q) return true;
                    return (
                      node.title.toLowerCase().includes(q) ||
                      node.class_type.toLowerCase().includes(q) ||
                      node.node_id.includes(q) ||
                      node.inputs.some((i) => i.field_name.toLowerCase().includes(q))
                    );
                  })
                  .map((node) => (
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

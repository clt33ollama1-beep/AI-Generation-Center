import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Download,
  Film,
  Image as ImageIcon,
  Loader2,
  Play,
  RotateCcw,
  Search,
  Sparkles,
} from 'lucide-react';
import { api } from '../lib/api.ts';
import type {
  Category,
  GenerationRecord,
  OutputFileInfo,
  ProgressEventPayload,
  WorkflowTemplate,
} from '../types/comfy.ts';
import { DynamicField } from './DynamicField.tsx';

interface WorkspaceViewProps {
  categories: Category[];
  workflows: WorkflowTemplate[];
  selectedWorkflowId: number | null;
  prefilledInputs?: Record<string, unknown> | null;
  onSelectWorkflow: (id: number) => void;
  onClearPrefilled?: () => void;
  onOpenConnection: () => void;
  onGenerationComplete: (generation: GenerationRecord) => void;
  onGoTemplates: () => void;
}

const DRAFT_STORAGE_PREFIX = 'comfycentre:draft:';

interface StoredWorkflowDraft {
  values?: Record<string, string | number | boolean>;
  seedLocks?: Record<string, boolean>;
}

function loadWorkflowDraft(workflowId: number): StoredWorkflowDraft | null {
  try {
    const raw = window.localStorage.getItem(`${DRAFT_STORAGE_PREFIX}${workflowId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredWorkflowDraft;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function saveWorkflowDraft(workflowId: number, draft: StoredWorkflowDraft): void {
  try {
    window.localStorage.setItem(`${DRAFT_STORAGE_PREFIX}${workflowId}`, JSON.stringify(draft));
  } catch {
    // ignore storage quota/privacy errors
  }
}

function clearWorkflowDraft(workflowId: number): void {
  try {
    window.localStorage.removeItem(`${DRAFT_STORAGE_PREFIX}${workflowId}`);
  } catch {
    // ignore storage errors
  }
}

export const WorkspaceView: React.FC<WorkspaceViewProps> = ({
  categories,
  workflows,
  selectedWorkflowId,
  prefilledInputs,
  onSelectWorkflow,
  onClearPrefilled,
  onOpenConnection,
  onGenerationComplete,
  onGoTemplates,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedCats, setCollapsedCats] = useState<Record<number, boolean>>({});
  const [formValues, setFormValues] = useState<Record<string, string | number | boolean>>({});
  const [fileValues, setFileValues] = useState<Record<string, File | null>>({});
  const [seedLocks, setSeedLocks] = useState<Record<string, boolean>>({});

  const [isRunning, setIsRunning] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [stepProgress, setStepProgress] = useState<{ value: number; max: number } | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('Ready');
  const [activeNodeLabel, setActiveNodeLabel] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [runError, setRunError] = useState<string | null>(null);
  const [latestGeneration, setLatestGeneration] = useState<GenerationRecord | null>(null);
  const [selectedOutputIndex, setSelectedOutputIndex] = useState(0);

  const unsubscribeSseRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<number | null>(null);

  const activeWorkflow = useMemo(() => {
    if (workflows.length === 0) return null;
    return workflows.find((w) => w.id === selectedWorkflowId) || workflows[0];
  }, [workflows, selectedWorkflowId]);

  // Initialize form values when active workflow or prefilledInputs changes,
  // restoring any saved localStorage draft for the workflow.
  useEffect(() => {
    if (!activeWorkflow) return;
    const draft = loadWorkflowDraft(activeWorkflow.id);
    const initialValues: Record<string, string | number | boolean> = {};

    for (const field of activeWorkflow.ui_inputs) {
      const key = `${field.node_id}:${field.field_name}`;
      if (prefilledInputs && key in prefilledInputs && field.value_type !== 'media') {
        initialValues[key] = prefilledInputs[key] as string | number | boolean;
      } else if (draft?.values && key in draft.values && field.value_type !== 'media') {
        initialValues[key] = draft.values[key];
      } else {
        initialValues[key] = field.default_value;
      }
    }

    const nextSeedLocks = draft?.seedLocks ? { ...draft.seedLocks } : {};
    setFormValues(initialValues);
    setSeedLocks(nextSeedLocks);
    setFileValues({});
    setRunError(null);

    if (prefilledInputs) {
      saveWorkflowDraft(activeWorkflow.id, {
        values: initialValues,
        seedLocks: nextSeedLocks,
      });
    }
  }, [activeWorkflow, prefilledInputs]);

  useEffect(() => {
    return () => {
      unsubscribeSseRef.current?.();
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, []);

  const groupedWorkflows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return categories
      .map((cat) => {
        const items = workflows.filter((w) => {
          if (w.category_id !== cat.id) return false;
          if (!q) return true;
          return (
            w.name.toLowerCase().includes(q) ||
            w.description.toLowerCase().includes(q) ||
            cat.name.toLowerCase().includes(q)
          );
        });
        return { category: cat, items };
      })
      .filter((group) => group.items.length > 0 || !q);
  }, [categories, workflows, searchQuery]);

  const handleResetDefaults = () => {
    if (!activeWorkflow) return;
    const defaults: Record<string, string | number | boolean> = {};
    for (const field of activeWorkflow.ui_inputs) {
      defaults[`${field.node_id}:${field.field_name}`] = field.default_value;
    }
    clearWorkflowDraft(activeWorkflow.id);
    onClearPrefilled?.();
    setFormValues(defaults);
    setSeedLocks({});
    setFileValues({});
    setRunError(null);
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeWorkflow || isRunning) return;

    // Auto-randomize unlocked seeds
    const nextValues = { ...formValues };
    for (const field of activeWorkflow.ui_inputs) {
      const key = `${field.node_id}:${field.field_name}`;
      if (field.widget === 'seed_randomizer' && !seedLocks[key]) {
        nextValues[key] = Math.floor(Math.random() * 2_147_483_647);
      }
    }
    setFormValues(nextValues);
    saveWorkflowDraft(activeWorkflow.id, { values: nextValues, seedLocks });

    const clientId = crypto.randomUUID();
    setIsRunning(true);
    setRunError(null);
    setProgressPercent(0);
    setStepProgress(null);
    setActiveNodeLabel(null);
    setStatusMessage('Connecting to ComfyUI...');
    setElapsedSeconds(0);

    if (timerRef.current) window.clearInterval(timerRef.current);
    const startMs = Date.now();
    timerRef.current = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startMs) / 1000));
    }, 1000);

    unsubscribeSseRef.current?.();
    unsubscribeSseRef.current = api.subscribeProgress(
      clientId,
      (evt: ProgressEventPayload) => {
        if (evt.type === 'status') {
          setStatusMessage(evt.message || 'Queued on ComfyUI');
        } else if (evt.type === 'executing') {
          setActiveNodeLabel(evt.node_title || `Node ${evt.node_id}`);
          setStatusMessage(`Running ${evt.node_title || evt.node_id}`);
        } else if (evt.type === 'progress') {
          if (typeof evt.value === 'number' && typeof evt.max === 'number') {
            setStepProgress({ value: evt.value, max: evt.max });
          }
          if (typeof evt.percent === 'number') {
            setProgressPercent(evt.percent);
          }
        } else if (evt.type === 'completed' && evt.generation) {
          setIsRunning(false);
          setProgressPercent(100);
          setStatusMessage('Completed');
          setActiveNodeLabel(null);
          setLatestGeneration(evt.generation);
          setSelectedOutputIndex(0);
          onGenerationComplete(evt.generation);
          if (timerRef.current) window.clearInterval(timerRef.current);
          unsubscribeSseRef.current?.();
        } else if (evt.type === 'error') {
          setIsRunning(false);
          setRunError(evt.message || 'Generation failed');
          setStatusMessage('Failed');
          if (timerRef.current) window.clearInterval(timerRef.current);
          unsubscribeSseRef.current?.();
        }
      },
    );

    try {
      const formData = new FormData();
      formData.append('workflow_id', String(activeWorkflow.id));
      formData.append('client_id', clientId);
      formData.append('inputs_json', JSON.stringify(nextValues));

      for (const field of activeWorkflow.ui_inputs) {
        const key = `${field.node_id}:${field.field_name}`;
        const file = fileValues[key];
        if (file) {
          formData.append(`file:${field.node_id}:${field.field_name}`, file);
        }
      }

      await api.submitGeneration(formData);
    } catch (err) {
      setIsRunning(false);
      if (timerRef.current) window.clearInterval(timerRef.current);
      unsubscribeSseRef.current?.();
      setRunError(err instanceof Error ? err.message : 'Failed to queue generation');
      setStatusMessage('Connection error');
    }
  };

  const sortedFields = useMemo(() => {
    if (!activeWorkflow) return [];
    return [...activeWorkflow.ui_inputs].sort((a, b) => a.order - b.order);
  }, [activeWorkflow]);

  const currentOutput: OutputFileInfo | null =
    latestGeneration?.outputs?.[selectedOutputIndex] || null;

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden bg-[#0B0D11]">
      {/* Left Sidebar: Category Accordion & Workflow Selector */}
      <aside className="w-[270px] shrink-0 border-r border-zinc-800/80 bg-[#12151B] flex flex-col min-h-0">
        <div className="p-3.5 border-b border-zinc-800/80">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter workflows..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-[#0B0D11] border border-zinc-800 rounded-md text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2.5 space-y-2">
          {groupedWorkflows.length === 0 ? (
            <div className="p-4 text-center space-y-2">
              <p className="text-xs text-zinc-400">No workflows match your filter.</p>
            </div>
          ) : (
            groupedWorkflows.map(({ category, items }) => {
              const isCollapsed = Boolean(collapsedCats[category.id]);
              return (
                <div key={category.id} className="space-y-1">
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsedCats((prev) => ({
                        ...prev,
                        [category.id]: !prev[category.id],
                      }))
                    }
                    className="w-full flex items-center justify-between px-2 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200 rounded transition-colors cursor-pointer"
                  >
                    <span className="flex items-center gap-1.5 truncate">
                      {isCollapsed ? (
                        <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                      )}
                      <span className="truncate">{category.name}</span>
                    </span>
                    <span className="font-mono text-[11px] text-zinc-500 tabular-nums">
                      {items.length}
                    </span>
                  </button>

                  {!isCollapsed && (
                    <div className="space-y-0.5 pl-2">
                      {items.map((wf) => {
                        const isSelected = activeWorkflow?.id === wf.id;
                        return (
                          <button
                            key={wf.id}
                            type="button"
                            onClick={() => onSelectWorkflow(wf.id)}
                            className={`w-full text-left px-3 py-2 rounded-md text-xs transition-colors flex items-center justify-between gap-2 cursor-pointer ${
                              isSelected
                                ? 'bg-blue-600/15 text-blue-300 border border-blue-500/40'
                                : 'text-zinc-300 hover:bg-zinc-800/60 border border-transparent'
                            }`}
                          >
                            <span className="truncate font-medium">{wf.name}</span>
                            {wf.output_type === 'video' ? (
                              <Film className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                            ) : (
                              <ImageIcon className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="p-3 border-t border-zinc-800/80 flex items-center justify-between text-[11px] text-zinc-500">
          <span className="tabular-nums">{workflows.length} templates</span>
          <button
            type="button"
            onClick={onGoTemplates}
            className="text-zinc-400 hover:text-zinc-200 underline underline-offset-2 cursor-pointer"
          >
            Manage
          </button>
        </div>
      </aside>

      {/* Center Panel: Dynamic Parameter Form */}
      <section className="flex-1 min-w-0 overflow-y-auto border-r border-zinc-800/80">
        {!activeWorkflow ? (
          <div className="h-full flex flex-col items-center justify-center p-8 text-center space-y-3">
            <p className="text-sm font-medium text-zinc-200">No workflow templates configured</p>
            <p className="text-xs text-zinc-500 max-w-sm">
              Upload a ComfyUI API JSON file in the Template Manager to generate a dynamic input form.
            </p>
            <button
              type="button"
              onClick={onGoTemplates}
              className="px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-md transition-colors cursor-pointer"
            >
              Create First Template
            </button>
          </div>
        ) : (
          <form onSubmit={handleGenerate} className="p-6 max-w-2xl mx-auto space-y-6">
            <div className="pb-4 border-b border-zinc-800/80 space-y-1.5">
              <div className="flex items-center gap-2 text-xs text-zinc-400">
                <span>{activeWorkflow.category_name}</span>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">{sortedFields.length} parameters</span>
                <span aria-hidden="true">·</span>
                <span>{activeWorkflow.output_type === 'video' ? 'Video output' : 'Image output'}</span>
              </div>
              <h1 className="font-display text-xl font-semibold text-zinc-100">
                {activeWorkflow.name}
              </h1>
              {activeWorkflow.description && (
                <p className="text-xs text-zinc-400 leading-relaxed">
                  {activeWorkflow.description}
                </p>
              )}
            </div>

            {sortedFields.length === 0 ? (
              <div className="p-5 rounded-md border border-zinc-800 bg-[#12151B] text-xs text-zinc-400">
                This workflow has no exposed UI inputs. Open the Template Manager to map node fields to controls.
              </div>
            ) : (
              <div className="space-y-5">
                {sortedFields.map((field) => {
                  const key = `${field.node_id}:${field.field_name}`;
                  return (
                    <DynamicField
                      key={field.id || key}
                      field={field}
                      value={formValues[key] ?? field.default_value}
                      fileValue={fileValues[key] ?? null}
                      seedLocked={Boolean(seedLocks[key])}
                      onToggleSeedLock={
                        field.widget === 'seed_randomizer'
                          ? () =>
                              setSeedLocks((prev) => {
                                const next = {
                                  ...prev,
                                  [key]: !prev[key],
                                };
                                saveWorkflowDraft(activeWorkflow.id, {
                                  values: formValues,
                                  seedLocks: next,
                                });
                                return next;
                              })
                          : undefined
                      }
                      onChange={(val) =>
                        setFormValues((prev) => {
                          const next = {
                            ...prev,
                            [key]: val,
                          };
                          saveWorkflowDraft(activeWorkflow.id, {
                            values: next,
                            seedLocks,
                          });
                          return next;
                        })
                      }
                      onFileChange={(file) =>
                        setFileValues((prev) => ({
                          ...prev,
                          [key]: file,
                        }))
                      }
                    />
                  );
                })}
              </div>
            )}

            <div className="pt-4 border-t border-zinc-800/80 flex items-center justify-between gap-4">
              <button
                type="button"
                onClick={handleResetDefaults}
                disabled={isRunning}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-zinc-300 bg-zinc-800/70 hover:bg-zinc-800 rounded-md transition-colors cursor-pointer disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset Defaults
              </button>

              <button
                type="submit"
                disabled={isRunning}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 active:bg-blue-700 rounded-md transition-colors cursor-pointer disabled:opacity-60"
              >
                {isRunning ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 fill-current" />
                    Generate Output
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </section>

      {/* Right Panel: Execution Progress & Live Output Preview */}
      <section className="w-[440px] xl:w-[500px] shrink-0 bg-[#12151B] flex flex-col min-h-0">
        <div className="p-4 border-b border-zinc-800/80 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-zinc-200">{statusMessage}</span>
            <div className="flex items-center gap-3 font-mono text-zinc-400 tabular-nums">
              {stepProgress && (
                <span>
                  Step {stepProgress.value}/{stepProgress.max}
                </span>
              )}
              <span>{progressPercent}%</span>
              {(isRunning || elapsedSeconds > 0) && <span>{elapsedSeconds}s</span>}
            </div>
          </div>

          <div className="h-1.5 w-full bg-[#0B0D11] rounded-full overflow-hidden border border-zinc-800/60">
            <div
              className={`h-full transition-all duration-200 ${
                runError ? 'bg-red-500' : 'bg-blue-500'
              }`}
              style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
            />
          </div>

          {activeNodeLabel && (
            <div className="text-[11px] font-mono text-zinc-400 truncate">
              Executing: {activeNodeLabel}
            </div>
          )}

          {runError && (
            <div className="p-3 rounded-md border border-red-900/60 bg-red-950/30 text-xs text-red-300 space-y-2">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <span className="break-words">{runError}</span>
              </div>
              <button
                type="button"
                onClick={onOpenConnection}
                className="text-xs font-medium text-red-200 underline underline-offset-2 hover:text-white cursor-pointer"
              >
                Check ComfyUI Connection Settings
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 min-h-0 p-4 flex flex-col">
          {currentOutput ? (
            <div className="flex-1 min-h-0 flex flex-col gap-3">
              <div className="flex-1 min-h-0 rounded-md border border-zinc-800 bg-[#0B0D11] flex items-center justify-center overflow-hidden">
                {currentOutput.media_type === 'video' ? (
                  <video
                    key={currentOutput.url}
                    src={currentOutput.url}
                    controls
                    autoPlay
                    loop
                    muted
                    playsInline
                    className="max-w-full max-h-full object-contain"
                  />
                ) : (
                  <img
                    src={currentOutput.url}
                    alt={latestGeneration?.workflow_name || 'Generated output'}
                    referrerPolicy="no-referrer"
                    className="max-w-full max-h-full object-contain"
                  />
                )}
              </div>

              {latestGeneration && latestGeneration.outputs.length > 1 && (
                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                  {latestGeneration.outputs.map((out, idx) => (
                    <button
                      key={out.filename}
                      type="button"
                      onClick={() => setSelectedOutputIndex(idx)}
                      className={`px-2.5 py-1 text-xs font-mono rounded border transition-colors shrink-0 cursor-pointer ${
                        idx === selectedOutputIndex
                          ? 'border-blue-500 bg-blue-600/15 text-blue-300'
                          : 'border-zinc-800 bg-[#0B0D11] text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      Output {idx + 1}
                    </button>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between pt-2 border-t border-zinc-800/80 text-xs">
                <div className="text-zinc-400 truncate space-x-2">
                  <span className="font-mono text-zinc-300">{currentOutput.format.toUpperCase()}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    {((latestGeneration?.duration_ms || 0) / 1000).toFixed(1)}s
                  </span>
                </div>
                <a
                  href={currentOutput.url}
                  download={currentOutput.original_filename || currentOutput.filename}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-100 rounded-md transition-colors shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download
                </a>
              </div>
            </div>
          ) : (
            <div className="flex-1 rounded-md border border-zinc-800/80 bg-[#0B0D11] flex flex-col items-center justify-center p-6 text-center space-y-2.5">
              <Sparkles className="w-6 h-6 text-zinc-600" />
              <p className="text-xs font-medium text-zinc-300">Live Output Viewport</p>
              <p className="text-xs text-zinc-500 max-w-xs leading-relaxed">
                Generated PNG/WEBP stills and VHS_VideoCombine MP4/WEBM/GIF animations will stream and render here upon completion.
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

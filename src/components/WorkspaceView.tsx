import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
  Film,
  Image as ImageIcon,
  ListPlus,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  Square,
  X,
  XCircle,
} from 'lucide-react';
import type {
  Category,
  GenerationRecord,
  InputMediaInfo,
  OutputFileInfo,
  QueueTask,
  WorkflowTemplate,
} from '../types/comfy.ts';
import { DynamicField } from './DynamicField.tsx';

interface WorkspaceViewProps {
  categories: Category[];
  workflows: WorkflowTemplate[];
  selectedWorkflowId: number | null;
  prefilledGeneration?: GenerationRecord | null;
  onSelectWorkflow: (id: number) => void;
  onClearPrefilled?: () => void;
  onOpenConnection: () => void;
  onGoTemplates: () => void;
  queueTasks: QueueTask[];
  isQueueRunning: boolean;
  selectedOutputTaskId: string | null;
  onSelectOutputTask: (taskId: string | null) => void;
  onEnqueueTask: (args: {
    workflow: WorkflowTemplate;
    values: Record<string, string | number | boolean>;
    fileValues: Record<string, File | null>;
    reusedMedia: Record<string, InputMediaInfo>;
    startNow: boolean;
  }) => string;
  onStartQueue: () => void;
  onPauseQueue: () => void;
  onRunTaskNow: (taskId: string) => void;
  onMoveTaskUp: (taskId: string) => void;
  onCancelTask: (taskId: string) => void;
  onRetryTask: (taskId: string) => void;
  onRequeueTask: (taskId: string) => void;
  onRemoveTask: (taskId: string) => void;
  onClearFinishedTasks: () => void;
}

const DRAFT_STORAGE_PREFIX = 'comfycentre:draft:';

interface StoredWorkflowDraft {
  values?: Record<string, string | number | boolean>;
  seedLocks?: Record<string, boolean>;
  reusedMedia?: Record<string, InputMediaInfo>;
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
  prefilledGeneration,
  onSelectWorkflow,
  onClearPrefilled,
  onOpenConnection,
  onGoTemplates,
  queueTasks,
  isQueueRunning,
  selectedOutputTaskId,
  onSelectOutputTask,
  onEnqueueTask,
  onStartQueue,
  onPauseQueue,
  onRunTaskNow,
  onMoveTaskUp,
  onCancelTask,
  onRetryTask,
  onRequeueTask,
  onRemoveTask,
  onClearFinishedTasks,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedCats, setCollapsedCats] = useState<Record<number, boolean>>({});
  const [formValues, setFormValues] = useState<Record<string, string | number | boolean>>({});
  const [fileValues, setFileValues] = useState<Record<string, File | null>>({});
  const [reusedMedia, setReusedMedia] = useState<Record<string, InputMediaInfo>>({});
  const [seedLocks, setSeedLocks] = useState<Record<string, boolean>>({});
  const [selectedOutputIndex, setSelectedOutputIndex] = useState(0);
  const [queuedFeedback, setQueuedFeedback] = useState<string | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);

  const activeWorkflow = useMemo(() => {
    if (workflows.length === 0) return null;
    return workflows.find((w) => w.id === selectedWorkflowId) || workflows[0];
  }, [workflows, selectedWorkflowId]);

  // Initialize form values when active workflow or prefilledGeneration changes,
  // restoring any saved localStorage draft for the workflow.
  useEffect(() => {
    if (!activeWorkflow) return;
    const isApplyingPrefill =
      Boolean(prefilledGeneration) && prefilledGeneration!.workflow_id === activeWorkflow.id;
    const draft = loadWorkflowDraft(activeWorkflow.id);
    const initialValues: Record<string, string | number | boolean> = {};
    const nextReusedMedia: Record<string, InputMediaInfo> = {};
    const nextSeedLocks: Record<string, boolean> =
      !isApplyingPrefill && draft?.seedLocks ? { ...draft.seedLocks } : {};

    const prefilledInputs = isApplyingPrefill ? prefilledGeneration!.submitted_inputs || {} : null;
    const prefilledInputMedia = isApplyingPrefill ? prefilledGeneration!.input_media || [] : [];

    for (const field of activeWorkflow.ui_inputs) {
      const key = `${field.node_id}:${field.field_name}`;
      if (isApplyingPrefill && prefilledInputs) {
        const hasVal = key in prefilledInputs || field.id in prefilledInputs;
        if (field.value_type === 'media') {
          const matchedMedia = prefilledInputMedia.find(
            (m) => m.key === key || (m.node_id === field.node_id && m.field_name === field.field_name),
          );
          if (matchedMedia) {
            nextReusedMedia[key] = matchedMedia;
            initialValues[key] = matchedMedia.comfy_name || '';
          } else if (hasVal) {
            const raw = (key in prefilledInputs ? prefilledInputs[key] : prefilledInputs[field.id]) ?? '';
            initialValues[key] = String(raw);
          } else {
            initialValues[key] = field.default_value;
          }
        } else if (hasVal) {
          initialValues[key] = (
            key in prefilledInputs ? prefilledInputs[key] : prefilledInputs[field.id]
          ) as string | number | boolean;
          if (field.widget === 'seed_randomizer') {
            nextSeedLocks[key] = true;
          }
        } else {
          initialValues[key] = field.default_value;
        }
      } else {
        if (field.value_type === 'media') {
          if (draft?.reusedMedia && draft.reusedMedia[key]) {
            nextReusedMedia[key] = draft.reusedMedia[key];
          }
          if (draft?.values && key in draft.values) {
            initialValues[key] = draft.values[key];
          } else {
            initialValues[key] = field.default_value;
          }
        } else if (draft?.values && key in draft.values) {
          initialValues[key] = draft.values[key];
        } else {
          initialValues[key] = field.default_value;
        }
      }
    }

    setFormValues(initialValues);
    setSeedLocks(nextSeedLocks);
    setReusedMedia(nextReusedMedia);
    setFileValues({});

    if (isApplyingPrefill) {
      saveWorkflowDraft(activeWorkflow.id, {
        values: initialValues,
        seedLocks: nextSeedLocks,
        reusedMedia: nextReusedMedia,
      });
    }
  }, [activeWorkflow, prefilledGeneration]);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
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
    setReusedMedia({});
    setFileValues({});
  };

  const showQueuedToast = (msg: string) => {
    setQueuedFeedback(msg);
    if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = window.setTimeout(() => {
      setQueuedFeedback(null);
    }, 2200);
  };

  const prepareSubmissionValues = () => {
    if (!activeWorkflow) return null;
    const nextValues = { ...formValues };
    for (const field of activeWorkflow.ui_inputs) {
      const key = `${field.node_id}:${field.field_name}`;
      if (field.widget === 'seed_randomizer' && !seedLocks[key]) {
        nextValues[key] = Math.floor(Math.random() * 2_147_483_647);
      }
    }
    setFormValues(nextValues);
    saveWorkflowDraft(activeWorkflow.id, { values: nextValues, seedLocks, reusedMedia });
    return nextValues;
  };

  const handleGenerate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeWorkflow) return;
    const nextValues = prepareSubmissionValues();
    if (!nextValues) return;

    const alreadyRunning = queueTasks.some((t) => t.status === 'running');
    onEnqueueTask({
      workflow: activeWorkflow,
      values: nextValues,
      fileValues,
      reusedMedia,
      startNow: true,
    });
    if (alreadyRunning) {
      showQueuedToast(`Queued "${activeWorkflow.name}" after active task`);
    }
  };

  const handleAddToQueue = () => {
    if (!activeWorkflow) return;
    const nextValues = prepareSubmissionValues();
    if (!nextValues) return;

    onEnqueueTask({
      workflow: activeWorkflow,
      values: nextValues,
      fileValues,
      reusedMedia,
      startNow: false,
    });
    showQueuedToast(`Added "${activeWorkflow.name}" to queue`);
  };

  const sortedFields = useMemo(() => {
    if (!activeWorkflow) return [];
    return [...activeWorkflow.ui_inputs].sort((a, b) => a.order - b.order);
  }, [activeWorkflow]);

  const runningTask = useMemo(
    () => queueTasks.find((t) => t.status === 'running') || null,
    [queueTasks],
  );
  const queuedTasks = useMemo(
    () => queueTasks.filter((t) => t.status === 'queued'),
    [queueTasks],
  );
  const finishedTasks = useMemo(
    () =>
      queueTasks.filter(
        (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled',
      ),
    [queueTasks],
  );

  const selectedOutputTask = useMemo(() => {
    if (selectedOutputTaskId) {
      const match = queueTasks.find((t) => t.id === selectedOutputTaskId && t.generation);
      if (match) return match;
    }
    for (let i = queueTasks.length - 1; i >= 0; i--) {
      if (queueTasks[i].status === 'completed' && queueTasks[i].generation) {
        return queueTasks[i];
      }
    }
    return null;
  }, [queueTasks, selectedOutputTaskId]);

  const latestGeneration = selectedOutputTask?.generation || null;

  useEffect(() => {
    setSelectedOutputIndex(0);
  }, [selectedOutputTask?.id]);

  const lastTask = queueTasks[queueTasks.length - 1] || null;
  const displayTask = runningTask || (lastTask && lastTask.status === 'failed' ? lastTask : null) || selectedOutputTask;
  const statusMessage = runningTask
    ? runningTask.statusMessage
    : displayTask?.status === 'failed'
      ? displayTask.statusMessage
      : displayTask?.status === 'completed'
        ? 'Completed'
        : queuedTasks.length > 0
          ? `${queuedTasks.length} task${queuedTasks.length > 1 ? 's' : ''} queued`
          : 'Ready';
  const progressPercent = runningTask
    ? runningTask.progressPercent
    : displayTask?.status === 'completed'
      ? 100
      : 0;
  const stepProgress = runningTask?.stepProgress || null;
  const activeNodeLabel = runningTask?.activeNodeLabel || null;
  const elapsedSeconds = runningTask?.elapsedSeconds || 0;
  const runError = runningTask?.error || (lastTask?.status === 'failed' ? lastTask.error : null);

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
          <form onSubmit={handleGenerate} noValidate className="p-6 max-w-2xl mx-auto space-y-6">
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
                      reusedMedia={reusedMedia[key] ?? null}
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
                                  reusedMedia,
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
                            reusedMedia,
                          });
                          return next;
                        })
                      }
                      onFileChange={(file) => {
                        setFileValues((prev) => ({
                          ...prev,
                          [key]: file,
                        }));
                        if (file && reusedMedia[key]) {
                          setReusedMedia((prev) => {
                            const next = { ...prev };
                            delete next[key];
                            saveWorkflowDraft(activeWorkflow.id, {
                              values: formValues,
                              seedLocks,
                              reusedMedia: next,
                            });
                            return next;
                          });
                        }
                      }}
                      onClearReusedMedia={() => {
                        const nextReused = { ...reusedMedia };
                        delete nextReused[key];
                        const nextValues = {
                          ...formValues,
                          [key]: '',
                        };
                        setReusedMedia(nextReused);
                        setFormValues(nextValues);
                        saveWorkflowDraft(activeWorkflow.id, {
                          values: nextValues,
                          seedLocks,
                          reusedMedia: nextReused,
                        });
                      }}
                    />
                  );
                })}
              </div>
            )}

            <div className="pt-4 border-t border-zinc-800/80 space-y-2.5">
              {queuedFeedback && (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded bg-blue-950/40 border border-blue-800/60 text-xs text-blue-300">
                  <Check className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{queuedFeedback}</span>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={handleResetDefaults}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-zinc-300 bg-zinc-800/70 hover:bg-zinc-800 rounded-md transition-colors cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Reset Defaults
                </button>

                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={handleAddToQueue}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium text-zinc-100 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700/80 rounded-md transition-colors cursor-pointer"
                  >
                    <ListPlus className="w-4 h-4 text-zinc-300" />
                    Add to Queue
                  </button>

                  <button
                    type="submit"
                    className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 active:bg-blue-700 rounded-md transition-colors cursor-pointer"
                  >
                    <Play className="w-4 h-4 fill-current" />
                    {runningTask ? 'Queue & Start Next' : 'Generate Output'}
                  </button>
                </div>
              </div>
            </div>
          </form>
        )}
      </section>

      {/* Right Panel: Execution Progress, Running Queue & Live Output Preview */}
      <section className="w-[440px] xl:w-[500px] shrink-0 bg-[#12151B] flex flex-col min-h-0">
        <div className="p-4 border-b border-zinc-800/80 space-y-2.5 shrink-0">
          <div className="flex items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2 min-w-0">
              {runningTask && <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0" />}
              <span className="font-medium text-zinc-200 truncate">{statusMessage}</span>
            </div>
            <div className="flex items-center gap-3 font-mono text-zinc-400 tabular-nums shrink-0">
              {stepProgress && (
                <span>
                  Step {stepProgress.value}/{stepProgress.max}
                </span>
              )}
              <span>{progressPercent}%</span>
              {(Boolean(runningTask) || elapsedSeconds > 0) && <span>{elapsedSeconds}s</span>}
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

        {/* Running Queue Section */}
        <div className="border-b border-zinc-800/80 bg-[#0E1117] flex flex-col shrink-0">
          <div className="px-4 py-2.5 border-b border-zinc-800/60 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="text-xs font-semibold text-zinc-200">Running Queue</h2>
              <span className="text-[11px] font-mono text-zinc-500 tabular-nums truncate">
                {runningTask ? '1 running' : 'Idle'} · {queuedTasks.length} queued
              </span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {queuedTasks.length > 0 && !isQueueRunning && (
                <button
                  type="button"
                  onClick={onStartQueue}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-white bg-blue-600 hover:bg-blue-500 rounded transition-colors cursor-pointer"
                >
                  <Play className="w-3 h-3 fill-current" />
                  Start Queue
                </button>
              )}
              {isQueueRunning && (runningTask || queuedTasks.length > 0) && (
                <button
                  type="button"
                  onClick={onPauseQueue}
                  title="Pause after active task finishes"
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors cursor-pointer"
                >
                  <Pause className="w-3 h-3" />
                  Pause
                </button>
              )}
              {finishedTasks.length > 0 && (
                <button
                  type="button"
                  onClick={onClearFinishedTasks}
                  className="px-2 py-1 text-[11px] font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded transition-colors cursor-pointer"
                >
                  Clear Done
                </button>
              )}
            </div>
          </div>

          <div className="max-h-[210px] overflow-y-auto divide-y divide-zinc-800/60">
            {queueTasks.length === 0 ? (
              <div className="px-4 py-3 text-xs text-zinc-500">
                Queue is empty. Click Generate Output to run now or Add to Queue to batch tasks.
              </div>
            ) : (
              (() => {
                let queuedIndex = 0;
                return queueTasks.map((task) => {
                  const currentQueuedPos = task.status === 'queued' ? ++queuedIndex : 0;
                  const isPreviewSelected = selectedOutputTask?.id === task.id;
                  return (
                    <div
                      key={task.id}
                      className={`px-4 py-2.5 space-y-1.5 transition-colors ${
                        isPreviewSelected
                          ? 'bg-blue-950/20'
                          : task.status === 'running'
                            ? 'bg-zinc-900/50'
                            : 'hover:bg-zinc-900/30'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <button
                          type="button"
                          disabled={task.status !== 'completed' || !task.generation}
                          onClick={() => {
                            if (task.status === 'completed' && task.generation) {
                              onSelectOutputTask(task.id);
                            }
                          }}
                          className={`flex-1 min-w-0 flex items-start gap-2 text-left ${
                            task.status === 'completed' && task.generation
                              ? 'cursor-pointer'
                              : 'cursor-default'
                          }`}
                        >
                          <span className="mt-0.5 shrink-0">
                            {task.status === 'running' && (
                              <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />
                            )}
                            {task.status === 'queued' && (
                              <span className="inline-block font-mono text-[11px] text-zinc-400 tabular-nums">
                                #{currentQueuedPos}
                              </span>
                            )}
                            {task.status === 'completed' && (
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                            )}
                            {task.status === 'failed' && (
                              <AlertCircle className="w-3.5 h-3.5 text-red-400" />
                            )}
                            {task.status === 'cancelled' && (
                              <XCircle className="w-3.5 h-3.5 text-zinc-500" />
                            )}
                          </span>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <span className="font-medium text-zinc-200 truncate">
                                {task.workflowName}
                              </span>
                              <span className="font-mono text-[11px] text-zinc-500 tabular-nums shrink-0">
                                {task.status === 'running' &&
                                  `${task.progressPercent}% · ${task.elapsedSeconds}s`}
                                {task.status === 'queued' && 'Queued'}
                                {task.status === 'completed' &&
                                  `${((task.generation?.duration_ms || 0) / 1000).toFixed(1)}s`}
                                {task.status === 'failed' && (
                                  <span className="text-red-400">Failed</span>
                                )}
                                {task.status === 'cancelled' && 'Cancelled'}
                              </span>
                            </div>
                            <p className="text-[11px] text-zinc-500 truncate mt-0.5">
                              {task.status === 'failed' && task.error
                                ? task.error
                                : task.status === 'running' && task.activeNodeLabel
                                  ? `${task.activeNodeLabel} · ${task.summaryText}`
                                  : task.summaryText}
                            </p>
                          </div>
                        </button>

                        <div className="flex items-center gap-0.5 shrink-0">
                          {task.status === 'queued' && !runningTask && (
                            <button
                              type="button"
                              onClick={() => onRunTaskNow(task.id)}
                              title="Start this task now"
                              aria-label={`Start ${task.workflowName}`}
                              className="p-1 text-blue-400 hover:text-blue-300 hover:bg-zinc-800 rounded cursor-pointer"
                            >
                              <Play className="w-3 h-3 fill-current" />
                            </button>
                          )}
                          {task.status === 'queued' && currentQueuedPos > 1 && (
                            <button
                              type="button"
                              onClick={() => onMoveTaskUp(task.id)}
                              title="Move up in queue"
                              aria-label="Move up in queue"
                              className="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded cursor-pointer"
                            >
                              <ChevronUp className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {task.status === 'running' && (
                            <button
                              type="button"
                              onClick={() => onCancelTask(task.id)}
                              title="Stop waiting for this task"
                              aria-label="Cancel running task"
                              className="p-1 text-amber-400 hover:text-amber-300 hover:bg-zinc-800 rounded cursor-pointer"
                            >
                              <Square className="w-3 h-3 fill-current" />
                            </button>
                          )}
                          {(task.status === 'failed' || task.status === 'cancelled') && (
                            <button
                              type="button"
                              onClick={() => onRetryTask(task.id)}
                              title="Retry task"
                              aria-label="Retry task"
                              className="p-1 text-zinc-400 hover:text-blue-400 hover:bg-zinc-800 rounded cursor-pointer"
                            >
                              <RotateCcw className="w-3 h-3" />
                            </button>
                          )}
                          {task.status === 'completed' && (
                            <button
                              type="button"
                              onClick={() => onRequeueTask(task.id)}
                              title="Run again in queue"
                              aria-label="Re-queue task"
                              className="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded cursor-pointer"
                            >
                              <RotateCcw className="w-3 h-3" />
                            </button>
                          )}
                          {task.status !== 'running' && (
                            <button
                              type="button"
                              onClick={() => onRemoveTask(task.id)}
                              title="Remove from queue"
                              aria-label="Remove task"
                              className="p-1 text-zinc-500 hover:text-red-400 hover:bg-zinc-800 rounded cursor-pointer"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>

                      {task.status === 'running' && (
                        <div className="h-1 w-full bg-[#0B0D11] rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500 transition-all duration-200"
                            style={{ width: `${Math.min(100, Math.max(0, task.progressPercent))}%` }}
                          />
                        </div>
                      )}
                    </div>
                  );
                });
              })()
            )}
          </div>
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

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import type {
  GenerationRecord,
  InputMediaInfo,
  ProgressEventPayload,
  QueueTask,
  WorkflowTemplate,
} from '../types/comfy.ts';

export function generateClientId(): string {
  if (typeof window !== 'undefined' && window.crypto) {
    if (typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    if (typeof window.crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildTaskSummary(
  workflow: WorkflowTemplate,
  submittedInputs: Record<string, string | number | boolean>,
  fileValues: Record<string, File>,
  reusedMedia: Record<string, InputMediaInfo>,
): string {
  const sorted = [...workflow.ui_inputs].sort((a, b) => a.order - b.order);
  const parts: string[] = [];

  for (const field of sorted) {
    const key = `${field.node_id}:${field.field_name}`;
    if (field.value_type === 'media') {
      const f = fileValues[key];
      const r = reusedMedia[key];
      const mediaName = f?.name || r?.original_filename || r?.comfy_name;
      if (mediaName) {
        parts.push(mediaName);
        break;
      }
    } else if (field.widget === 'textarea' || field.widget === 'text') {
      const val = String(submittedInputs[key] ?? '').trim();
      if (val) {
        parts.push(val.length > 44 ? `${val.slice(0, 44)}...` : val);
        break;
      }
    }
  }

  for (const field of sorted) {
    if (field.widget === 'seed_randomizer') {
      const key = `${field.node_id}:${field.field_name}`;
      const seedVal = submittedInputs[key];
      if (seedVal !== undefined && seedVal !== '') {
        parts.push(`Seed ${seedVal}`);
        break;
      }
    }
  }

  if (parts.length === 0) {
    return `${workflow.category_name} · ${sorted.length} params`;
  }
  return parts.join(' · ');
}

interface EnqueueTaskArgs {
  workflow: WorkflowTemplate;
  values: Record<string, string | number | boolean>;
  fileValues: Record<string, File | null>;
  reusedMedia: Record<string, InputMediaInfo>;
  startNow: boolean;
}

interface RunningHandle {
  taskId: string;
  unsubscribe: () => void;
  timerId: number;
}

export function useGenerationQueue(
  onGenerationComplete: (generation: GenerationRecord) => void,
) {
  const [tasks, setTasks] = useState<QueueTask[]>([]);
  const [isQueueRunning, setIsQueueRunning] = useState(false);
  const [selectedOutputTaskId, setSelectedOutputTaskId] = useState<string | null>(null);

  const runningHandleRef = useRef<RunningHandle | null>(null);
  const onGenerationCompleteRef = useRef(onGenerationComplete);
  onGenerationCompleteRef.current = onGenerationComplete;

  const updateTask = useCallback((taskId: string, updater: (prev: QueueTask) => QueueTask) => {
    setTasks((prev) => prev.map((t) => (t.id === taskId ? updater(t) : t)));
  }, []);

  const cleanupRunningHandle = useCallback((expectedTaskId?: string) => {
    const handle = runningHandleRef.current;
    if (!handle) return;
    if (expectedTaskId && handle.taskId !== expectedTaskId) return;
    window.clearInterval(handle.timerId);
    handle.unsubscribe();
    runningHandleRef.current = null;
  }, []);

  const executeTask = useCallback(
    async (task: QueueTask) => {
      const clientId = generateClientId();
      const startedAt = Date.now();

      const timerId = window.setInterval(() => {
        if (runningHandleRef.current?.taskId !== task.id) return;
        const secs = Math.floor((Date.now() - startedAt) / 1000);
        updateTask(task.id, (prev) =>
          prev.status === 'running' ? { ...prev, elapsedSeconds: secs } : prev,
        );
      }, 1000);

      const unsubscribe = api.subscribeProgress(
        clientId,
        (evt: ProgressEventPayload) => {
          if (runningHandleRef.current?.taskId !== task.id) return;
          if (evt.type === 'status') {
            updateTask(task.id, (prev) => ({
              ...prev,
              statusMessage: evt.message || 'Queued on ComfyUI',
            }));
          } else if (evt.type === 'executing') {
            const label = evt.node_title || `Node ${evt.node_id}`;
            updateTask(task.id, (prev) => ({
              ...prev,
              activeNodeLabel: label,
              statusMessage: `Running ${label}`,
            }));
          } else if (evt.type === 'progress') {
            updateTask(task.id, (prev) => ({
              ...prev,
              stepProgress:
                typeof evt.value === 'number' && typeof evt.max === 'number'
                  ? { value: evt.value, max: evt.max }
                  : prev.stepProgress,
              progressPercent:
                typeof evt.percent === 'number' ? evt.percent : prev.progressPercent,
            }));
          } else if (evt.type === 'completed' && evt.generation) {
            const gen = evt.generation;
            cleanupRunningHandle(task.id);
            updateTask(task.id, (prev) => ({
              ...prev,
              status: 'completed',
              progressPercent: 100,
              statusMessage: 'Completed',
              activeNodeLabel: null,
              error: null,
              generation: gen,
            }));
            setSelectedOutputTaskId(task.id);
            onGenerationCompleteRef.current(gen);
          } else if (evt.type === 'error') {
            const msg = evt.message || 'Generation failed';
            cleanupRunningHandle(task.id);
            updateTask(task.id, (prev) => ({
              ...prev,
              status: 'failed',
              statusMessage: 'Failed',
              activeNodeLabel: null,
              error: msg,
            }));
          }
        },
      );

      runningHandleRef.current = {
        taskId: task.id,
        unsubscribe,
        timerId,
      };

      updateTask(task.id, (prev) => ({
        ...prev,
        status: 'running',
        progressPercent: 0,
        stepProgress: null,
        activeNodeLabel: null,
        elapsedSeconds: 0,
        statusMessage: 'Connecting to ComfyUI...',
        error: null,
      }));

      try {
        const formData = new FormData();
        formData.append('workflow_id', String(task.workflowId));
        formData.append('client_id', clientId);
        formData.append('inputs_json', JSON.stringify(task.submittedInputs));

        const reusedMediaPayload: Record<string, InputMediaInfo> = {};
        for (const field of task.uiInputs) {
          const key = `${field.node_id}:${field.field_name}`;
          const file = task.fileValues[key];
          if (file) {
            formData.append(`file:${field.node_id}:${field.field_name}`, file);
          } else if (task.reusedMedia[key]) {
            reusedMediaPayload[key] = task.reusedMedia[key];
          }
        }
        if (Object.keys(reusedMediaPayload).length > 0) {
          formData.append('reused_media_json', JSON.stringify(reusedMediaPayload));
        }

        await api.submitGeneration(formData);
      } catch (err) {
        if (runningHandleRef.current?.taskId !== task.id) return;
        const msg = err instanceof Error ? err.message : 'Failed to queue generation';
        cleanupRunningHandle(task.id);
        updateTask(task.id, (prev) => ({
          ...prev,
          status: 'failed',
          statusMessage: 'Connection error',
          activeNodeLabel: null,
          error: msg,
        }));
      }
    },
    [cleanupRunningHandle, updateTask],
  );

  // Advance queue sequentially whenever isQueueRunning is active and no task is currently running
  useEffect(() => {
    if (!isQueueRunning) return;
    if (runningHandleRef.current !== null) return;

    const nextQueued = tasks.find((t) => t.status === 'queued');
    if (!nextQueued) {
      setIsQueueRunning(false);
      return;
    }

    void executeTask(nextQueued);
  }, [isQueueRunning, tasks, executeTask]);

  useEffect(() => {
    return () => {
      cleanupRunningHandle();
    };
  }, [cleanupRunningHandle]);

  const enqueueTask = useCallback(
    ({ workflow, values, fileValues, reusedMedia, startNow }: EnqueueTaskArgs): string => {
      const cleanFiles: Record<string, File> = {};
      for (const [key, file] of Object.entries(fileValues)) {
        if (file) {
          cleanFiles[key] = file;
        }
      }

      const taskId = `task-${generateClientId()}`;
      const newTask: QueueTask = {
        id: taskId,
        workflowId: workflow.id,
        workflowName: workflow.name,
        categoryName: workflow.category_name,
        outputType: workflow.output_type,
        uiInputs: workflow.ui_inputs,
        submittedInputs: { ...values },
        fileValues: cleanFiles,
        reusedMedia: { ...reusedMedia },
        summaryText: buildTaskSummary(workflow, values, cleanFiles, reusedMedia),
        status: 'queued',
        progressPercent: 0,
        stepProgress: null,
        activeNodeLabel: null,
        statusMessage: 'Queued',
        elapsedSeconds: 0,
        error: null,
        generation: null,
        createdAt: Date.now(),
      };

      setTasks((prev) => [...prev, newTask]);
      if (startNow) {
        setIsQueueRunning(true);
      }
      return taskId;
    },
    [],
  );

  const startQueue = useCallback(() => {
    setIsQueueRunning(true);
  }, []);

  const pauseQueue = useCallback(() => {
    setIsQueueRunning(false);
  }, []);

  const runTaskNow = useCallback((taskId: string) => {
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.id === taskId && t.status === 'queued');
      if (idx === -1) return prev;
      const firstQueuedIdx = prev.findIndex((t) => t.status === 'queued');
      if (firstQueuedIdx === -1 || firstQueuedIdx === idx) return prev;
      const next = [...prev];
      const [item] = next.splice(idx, 1);
      next.splice(firstQueuedIdx, 0, item);
      return next;
    });
    setIsQueueRunning(true);
  }, []);

  const moveTaskUp = useCallback((taskId: string) => {
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.id === taskId && t.status === 'queued');
      if (idx <= 0) return prev;
      let prevQueuedIdx = -1;
      for (let i = idx - 1; i >= 0; i--) {
        if (prev[i].status === 'queued') {
          prevQueuedIdx = i;
          break;
        }
      }
      if (prevQueuedIdx === -1) return prev;
      const next = [...prev];
      const tmp = next[prevQueuedIdx];
      next[prevQueuedIdx] = next[idx];
      next[idx] = tmp;
      return next;
    });
  }, []);

  const cancelTask = useCallback(
    (taskId: string) => {
      if (runningHandleRef.current?.taskId === taskId) {
        cleanupRunningHandle(taskId);
      }
      updateTask(taskId, (prev) =>
        prev.status === 'running' || prev.status === 'queued'
          ? {
              ...prev,
              status: 'cancelled',
              statusMessage: 'Cancelled',
              activeNodeLabel: null,
            }
          : prev,
      );
    },
    [cleanupRunningHandle, updateTask],
  );

  const retryTask = useCallback(
    (taskId: string) => {
      updateTask(taskId, (prev) =>
        prev.status === 'failed' || prev.status === 'cancelled'
          ? {
              ...prev,
              status: 'queued',
              progressPercent: 0,
              stepProgress: null,
              activeNodeLabel: null,
              elapsedSeconds: 0,
              statusMessage: 'Queued',
              error: null,
            }
          : prev,
      );
      setIsQueueRunning(true);
    },
    [updateTask],
  );

  const requeueTask = useCallback((taskId: string) => {
    setTasks((prev) => {
      const src = prev.find((t) => t.id === taskId);
      if (!src) return prev;
      const clone: QueueTask = {
        ...src,
        id: `task-${generateClientId()}`,
        submittedInputs: { ...src.submittedInputs },
        fileValues: { ...src.fileValues },
        reusedMedia: { ...src.reusedMedia },
        status: 'queued',
        progressPercent: 0,
        stepProgress: null,
        activeNodeLabel: null,
        statusMessage: 'Queued',
        elapsedSeconds: 0,
        error: null,
        generation: null,
        createdAt: Date.now(),
      };
      return [...prev, clone];
    });
    setIsQueueRunning(true);
  }, []);

  const removeTask = useCallback(
    (taskId: string) => {
      if (runningHandleRef.current?.taskId === taskId) {
        cleanupRunningHandle(taskId);
      }
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
      setSelectedOutputTaskId((prev) => (prev === taskId ? null : prev));
    },
    [cleanupRunningHandle],
  );

  const clearFinished = useCallback(() => {
    setTasks((prev) => prev.filter((t) => t.status === 'queued' || t.status === 'running'));
  }, []);

  return {
    tasks,
    isQueueRunning,
    selectedOutputTaskId,
    setSelectedOutputTaskId,
    enqueueTask,
    startQueue,
    pauseQueue,
    runTaskNow,
    moveTaskUp,
    cancelTask,
    retryTask,
    requeueTask,
    removeTask,
    clearFinished,
  };
}

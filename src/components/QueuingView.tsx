import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Layers,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Search,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react';
import { api } from '../lib/api.ts';
import type { QueueStatusResponse, QueueTaskItem } from '../types/comfy.ts';

interface QueuingViewProps {
  onOpenConnection: () => void;
  onOpenWorkspace: (workflowId?: number | null) => void;
  onOpenGallery: () => void;
}

type QueueTabFilter = 'all' | 'running' | 'queued' | 'recent';

function formatElapsed(iso?: string | null, durationMs?: number | null, nowMs?: number): string {
  if (typeof durationMs === 'number' && durationMs >= 0) {
    const secs = durationMs / 1000;
    if (secs >= 60) {
      const mins = Math.floor(secs / 60);
      const rem = Math.round(secs % 60);
      return `${mins}m ${String(rem).padStart(2, '0')}s`;
    }
    return `${secs.toFixed(1)}s`;
  }
  if (!iso || !nowMs) return '—';
  const startedMs = new Date(iso).getTime();
  if (Number.isNaN(startedMs)) return '—';
  const secs = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  if (secs >= 60) {
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return `${mins}m ${String(rem).padStart(2, '0')}s`;
  }
  return `${secs}s`;
}

function formatClockTime(iso?: string | null): string {
  if (!iso) return '—';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function renderStateIndicator(state: QueueTaskItem['state']) {
  switch (state) {
    case 'running':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-400">
          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
          Running
        </span>
      );
    case 'queued':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400">
          <Clock className="w-3.5 h-3.5 shrink-0" />
          Queued
        </span>
      );
    case 'completed':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          Completed
        </span>
      );
    case 'cancelled':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-400">
          <Ban className="w-3.5 h-3.5 shrink-0" />
          Cancelled
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400">
          <XCircle className="w-3.5 h-3.5 shrink-0" />
          Failed
        </span>
      );
  }
}

export const QueuingView: React.FC<QueuingViewProps> = ({
  onOpenConnection,
  onOpenWorkspace,
  onOpenGallery,
}) => {
  const [queueData, setQueueData] = useState<QueueStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [tabFilter, setTabFilter] = useState<QueueTabFilter>('all');
  const [search, setSearch] = useState('');
  const [expandedTaskIds, setExpandedTaskIds] = useState<Record<string, boolean>>({});
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const loadQueue = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const data = await api.getQueueStatus();
      setQueueData(data);
      setNowMs(Date.now());
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to fetch queue status');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadQueue(false);
  }, [loadQueue]);

  useEffect(() => {
    if (!autoRefresh) return;
    const pollTimer = window.setInterval(() => {
      void loadQueue(false);
    }, 2000);
    return () => window.clearInterval(pollTimer);
  }, [autoRefresh, loadQueue]);

  useEffect(() => {
    const tickTimer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(tickTimer);
  }, []);

  const toggleExpand = (promptId: string) => {
    setExpandedTaskIds((prev) => ({
      ...prev,
      [promptId]: !prev[promptId],
    }));
  };

  const handleInterrupt = async () => {
    setActionError(null);
    setActionNotice(null);
    setActionBusyId('__interrupt__');
    try {
      await api.interruptQueue();
      setActionNotice('Sent interrupt signal to ComfyUI.');
      await loadQueue(true);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to interrupt running task');
    } finally {
      setActionBusyId(null);
    }
  };

  const handleCancelPending = async (promptId: string) => {
    setActionError(null);
    setActionNotice(null);
    setActionBusyId(promptId);
    try {
      await api.cancelQueuedTask(promptId);
      setActionNotice(`Removed task ${promptId.slice(0, 8)} from queue.`);
      await loadQueue(true);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to cancel queued task');
    } finally {
      setActionBusyId(null);
    }
  };

  const handleClearPending = async () => {
    setActionError(null);
    setActionNotice(null);
    setActionBusyId('__clear__');
    try {
      await api.clearPendingQueue();
      setConfirmClearAll(false);
      setActionNotice('Cleared pending ComfyUI queue.');
      await loadQueue(true);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to clear pending queue');
    } finally {
      setActionBusyId(null);
    }
  };

  const matchesSearch = useCallback(
    (task: QueueTaskItem) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      const hay = `${task.workflow_name} ${task.category_name} ${task.prompt_id} ${task.current_node_title || ''} ${JSON.stringify(task.submitted_inputs || {})}`.toLowerCase();
      return hay.includes(q);
    },
    [search],
  );

  const runningList = useMemo(
    () => (queueData?.running || []).filter(matchesSearch),
    [queueData, matchesSearch],
  );
  const pendingList = useMemo(
    () => (queueData?.pending || []).filter(matchesSearch),
    [queueData, matchesSearch],
  );
  const recentList = useMemo(
    () => (queueData?.recent || []).filter(matchesSearch),
    [queueData, matchesSearch],
  );

  const showRunning = tabFilter === 'all' || tabFilter === 'running';
  const showQueued = tabFilter === 'all' || tabFilter === 'queued';
  const showRecent = tabFilter === 'all' || tabFilter === 'recent';

  const totalVisible =
    (showRunning ? runningList.length : 0) +
    (showQueued ? pendingList.length : 0) +
    (showRecent ? recentList.length : 0);

  const totalRaw =
    (queueData?.running.length || 0) +
    (queueData?.pending.length || 0) +
    (queueData?.recent.length || 0);

  const renderTaskCard = (task: QueueTaskItem) => {
    const isExpanded = Boolean(expandedTaskIds[task.prompt_id]);
    const paramEntries = Object.entries(task.submitted_inputs || {});
    const isBusy = actionBusyId === task.prompt_id;

    return (
      <div
        key={`${task.state}-${task.prompt_id}`}
        className="rounded-lg border border-zinc-800/80 bg-[#12151B] overflow-hidden"
      >
        <div className="p-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2.5">
                {renderStateIndicator(task.state)}
                <span className="text-zinc-600" aria-hidden="true">
                  ·
                </span>
                <h3 className="text-sm font-semibold text-zinc-100 truncate">
                  {task.workflow_name}
                </h3>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400 tabular-nums">
                <span>{task.category_name}</span>
                {task.queue_position !== null && task.queue_position !== undefined && task.state === 'queued' && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono text-amber-300">Position #{task.queue_position}</span>
                  </>
                )}
                {task.queue_number !== null && task.queue_number !== undefined && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono text-zinc-500">Queue #{task.queue_number}</span>
                  </>
                )}
                <span aria-hidden="true">·</span>
                <span className="font-mono text-zinc-500" title={task.prompt_id}>
                  Prompt {task.prompt_id.slice(0, 12)}
                </span>
                {task.node_count > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono text-zinc-500">{task.node_count} nodes</span>
                  </>
                )}
                {task.source === 'external' && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="text-zinc-500">External client</span>
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs font-mono text-zinc-400 tabular-nums mr-1">
                {task.state === 'running' || task.state === 'queued'
                  ? `Elapsed ${formatElapsed(task.started_at, null, nowMs)}`
                  : `Duration ${formatElapsed(task.started_at, task.duration_ms, nowMs)}`}
              </span>

              {paramEntries.length > 0 && (
                <button
                  type="button"
                  onClick={() => toggleExpand(task.prompt_id)}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-800/70 hover:bg-zinc-800 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {isExpanded ? (
                    <ChevronDown className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5" />
                  )}
                  Parameters ({paramEntries.length})
                </button>
              )}

              {task.workflow_id && (
                <button
                  type="button"
                  onClick={() => onOpenWorkspace(task.workflow_id)}
                  className="px-2.5 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-800/70 hover:bg-zinc-800 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Open Workflow
                </button>
              )}

              {task.state === 'completed' && (
                <button
                  type="button"
                  onClick={onOpenGallery}
                  className="px-2.5 py-1.5 text-xs font-medium text-blue-300 bg-blue-600/15 hover:bg-blue-600/25 border border-blue-500/30 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  View Gallery
                </button>
              )}

              {task.state === 'running' && (
                <button
                  type="button"
                  disabled={actionBusyId === '__interrupt__'}
                  onClick={() => void handleInterrupt()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-200 bg-red-950/60 hover:bg-red-900/70 border border-red-900/70 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  <Square className="w-3 h-3 fill-current" />
                  Interrupt
                </button>
              )}

              {task.state === 'queued' && (
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => void handleCancelPending(task.prompt_id)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-200 bg-zinc-800 hover:bg-red-950/70 hover:text-red-200 hover:border-red-900/70 border border-zinc-700/60 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {isBusy ? 'Removing...' : 'Cancel'}
                </button>
              )}
            </div>
          </div>

          {task.state === 'running' && (
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-mono text-zinc-300 truncate">
                  {task.current_node_title
                    ? `Executing: ${task.current_node_title}${task.current_node_id ? ` (Node ${task.current_node_id})` : ''}`
                    : 'Executing workflow on ComfyUI...'}
                </span>
                <span className="font-mono text-zinc-400 tabular-nums shrink-0 ml-3">
                  {typeof task.step_value === 'number' && typeof task.step_max === 'number'
                    ? `Step ${task.step_value}/${task.step_max} · `
                    : ''}
                  {task.progress_percent}%
                </span>
              </div>
              <div className="h-1.5 w-full bg-[#0B0D11] rounded-full overflow-hidden border border-zinc-800/80">
                <div
                  className="h-full bg-blue-500 transition-all duration-200"
                  style={{ width: `${Math.min(100, Math.max(4, task.progress_percent || 0))}%` }}
                />
              </div>
            </div>
          )}

          {task.error_message && (task.state === 'failed' || task.state === 'cancelled') && (
            <div className="text-xs font-mono text-red-300/90 bg-red-950/25 border border-red-900/40 rounded px-3 py-2 break-words">
              {task.error_message}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-zinc-500 tabular-nums">
            <span>Full Prompt ID: {task.prompt_id}</span>
            {task.started_at && (
              <>
                <span aria-hidden="true">·</span>
                <span>Started: {formatClockTime(task.started_at)}</span>
              </>
            )}
            {task.finished_at && (
              <>
                <span aria-hidden="true">·</span>
                <span>Finished: {formatClockTime(task.finished_at)}</span>
              </>
            )}
          </div>
        </div>

        {isExpanded && paramEntries.length > 0 && (
          <div className="border-t border-zinc-800/80 bg-[#0B0D11] px-4 py-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {paramEntries.map(([key, val]) => (
              <div key={key} className="text-xs space-y-0.5 min-w-0">
                <div className="font-mono text-[11px] text-zinc-500 truncate">{key}</div>
                <div className="font-mono text-zinc-200 break-words tabular-nums">
                  {String(val)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-[#0B0D11]">
      {/* Toolbar */}
      <div className="px-6 py-3.5 border-b border-zinc-800/80 bg-[#12151B] flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-1 p-1 bg-[#0B0D11] border border-zinc-800 rounded-md">
            {(
              [
                { id: 'all', label: 'All Tasks' },
                { id: 'running', label: `Running (${queueData?.running.length || 0})` },
                { id: 'queued', label: `Queued (${queueData?.pending.length || 0})` },
                { id: 'recent', label: `Recent (${queueData?.recent.length || 0})` },
              ] as Array<{ id: QueueTabFilter; label: string }>
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setTabFilter(tab.id)}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                  tabFilter === tab.id
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setAutoRefresh((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              autoRefresh
                ? 'border-blue-500/40 bg-blue-600/15 text-blue-300'
                : 'border-zinc-800 bg-[#0B0D11] text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {autoRefresh ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            {autoRefresh ? 'Live Polling (2s)' : 'Polling Paused'}
          </button>

          <button
            type="button"
            disabled={refreshing}
            onClick={() => void loadQueue(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0B0D11] border border-zinc-800 hover:border-zinc-700 text-zinc-200 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {(queueData?.running.length || 0) > 0 && (
            <button
              type="button"
              disabled={actionBusyId === '__interrupt__'}
              onClick={() => void handleInterrupt()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-200 bg-red-950/60 hover:bg-red-900/70 border border-red-900/70 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <Square className="w-3 h-3 fill-current" />
              Interrupt Running
            </button>
          )}

          {(queueData?.pending.length || 0) > 0 &&
            (confirmClearAll ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={actionBusyId === '__clear__'}
                  onClick={() => void handleClearPending()}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-500 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  Confirm Clear ({queueData?.pending.length})
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClearAll(false)}
                  className="px-2.5 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmClearAll(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear Pending
              </button>
            ))}

          <div className="relative w-60">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter workflow or prompt ID..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-[#0B0D11] border border-zinc-800 rounded-md text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Summary Metrics Row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="rounded-lg border border-zinc-800/80 bg-[#12151B] px-4 py-3.5 space-y-1">
            <div className="text-xs text-zinc-400">Running Now</div>
            <div className="text-xl font-semibold font-mono tabular-nums text-zinc-100">
              {queueData?.running.length ?? 0}
            </div>
          </div>

          <div className="rounded-lg border border-zinc-800/80 bg-[#12151B] px-4 py-3.5 space-y-1">
            <div className="text-xs text-zinc-400">Pending in Queue</div>
            <div className="text-xl font-semibold font-mono tabular-nums text-zinc-100">
              {queueData?.pending.length ?? 0}
            </div>
          </div>

          <div className="rounded-lg border border-zinc-800/80 bg-[#12151B] px-4 py-3.5 space-y-1">
            <div className="text-xs text-zinc-400">Recent Session Tasks</div>
            <div className="text-xl font-semibold font-mono tabular-nums text-zinc-100">
              {queueData?.recent.length ?? 0}
            </div>
          </div>

          <div className="rounded-lg border border-zinc-800/80 bg-[#12151B] px-4 py-3.5 space-y-1">
            <div className="text-xs text-zinc-400">ComfyUI Worker</div>
            <div className="flex items-center justify-between gap-2 pt-0.5">
              {queueData?.comfy_connected ? (
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-400">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  Connected
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-400">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  Unreachable
                </span>
              )}
              <span className="text-[11px] font-mono text-zinc-500 tabular-nums truncate">
                {queueData?.fetched_at ? formatClockTime(queueData.fetched_at) : '—'}
              </span>
            </div>
          </div>
        </div>

        {/* ComfyUI Unreachable Banner */}
        {queueData && !queueData.comfy_connected && (
          <div className="rounded-lg border border-amber-900/60 bg-amber-950/25 px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-start gap-2.5 text-amber-200 min-w-0">
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-0.5 min-w-0">
                <p className="font-medium">
                  Cannot reach ComfyUI queue endpoint at {queueData.comfyui_url}
                </p>
                {queueData.comfy_error && (
                  <p className="font-mono text-[11px] text-amber-300/80 break-all">
                    {queueData.comfy_error}
                  </p>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={onOpenConnection}
              className="px-3 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-100 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Connection Settings
            </button>
          </div>
        )}

        {actionError && (
          <div className="rounded-md border border-red-900/60 bg-red-950/30 px-4 py-3 text-xs text-red-300 flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 min-w-0">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
              <span className="break-words">{actionError}</span>
            </span>
            <button
              type="button"
              onClick={() => setActionError(null)}
              className="text-red-300 hover:text-white underline underline-offset-2 shrink-0 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {actionNotice && (
          <div className="rounded-md border border-emerald-900/60 bg-emerald-950/30 px-4 py-3 text-xs text-emerald-300 flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 min-w-0">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span className="break-words">{actionNotice}</span>
            </span>
            <button
              type="button"
              onClick={() => setActionNotice(null)}
              className="text-emerald-300 hover:text-white underline underline-offset-2 shrink-0 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {loading && !queueData ? (
          <div className="space-y-3">
            {[1, 2, 3].map((row) => (
              <div
                key={row}
                className="h-24 rounded-lg border border-zinc-800/80 bg-[#12151B] animate-pulse"
              />
            ))}
          </div>
        ) : totalVisible === 0 ? (
          <div className="min-h-[320px] rounded-lg border border-zinc-800/80 bg-[#12151B] flex flex-col items-center justify-center p-8 text-center space-y-3">
            <Layers className="w-7 h-7 text-zinc-600" />
            <p className="text-sm font-medium text-zinc-200">
              {totalRaw === 0 ? 'No tasks currently queued or running' : 'No matching queue tasks'}
            </p>
            <p className="text-xs text-zinc-500 max-w-md leading-relaxed">
              {totalRaw === 0
                ? 'Submit a workflow from the Workspace to monitor live execution progress, queue position, and recent task outcomes here.'
                : 'Try switching the status tab or clearing your search query.'}
            </p>
            {totalRaw === 0 && (
              <button
                type="button"
                onClick={() => onOpenWorkspace(null)}
                className="px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-md transition-colors cursor-pointer"
              >
                Open Workspace
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            {showRunning && runningList.length > 0 && (
              <section className="space-y-3">
                <div className="flex items-center justify-between text-xs text-zinc-400">
                  <h2 className="font-display text-sm font-semibold text-zinc-100">
                    Currently Executing
                  </h2>
                  <span className="font-mono tabular-nums">{runningList.length} active</span>
                </div>
                <div className="space-y-3">{runningList.map(renderTaskCard)}</div>
              </section>
            )}

            {showQueued && pendingList.length > 0 && (
              <section className="space-y-3">
                <div className="flex items-center justify-between text-xs text-zinc-400">
                  <h2 className="font-display text-sm font-semibold text-zinc-100">
                    Waiting in Queue
                  </h2>
                  <span className="font-mono tabular-nums">{pendingList.length} pending</span>
                </div>
                <div className="space-y-3">{pendingList.map(renderTaskCard)}</div>
              </section>
            )}

            {showRecent && recentList.length > 0 && (
              <section className="space-y-3">
                <div className="flex items-center justify-between text-xs text-zinc-400">
                  <h2 className="font-display text-sm font-semibold text-zinc-100">
                    Recent Session Tasks
                  </h2>
                  <span className="font-mono tabular-nums">{recentList.length} recorded</span>
                </div>
                <div className="space-y-3">{recentList.map(renderTaskCard)}</div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

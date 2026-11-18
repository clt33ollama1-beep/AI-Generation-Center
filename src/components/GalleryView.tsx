import React, { useEffect, useMemo, useState } from 'react';
import {
  Clock,
  Download,
  ExternalLink,
  Film,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  Play,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../lib/api.ts';
import type { Category, GenerationRecord, WorkflowTemplate } from '../types/comfy.ts';

interface GalleryViewProps {
  categories: Category[];
  generations: GenerationRecord[];
  workflows: WorkflowTemplate[];
  onDeleted: (id: number) => void;
  onReuseInWorkspace: (generation: GenerationRecord) => void;
  onGoWorkspace: () => void;
}

type SortOption = 'newest' | 'oldest' | 'duration_desc' | 'duration_asc';

interface LightboxMedia {
  url: string;
  title: string;
  filename: string;
  mediaType: 'image' | 'video';
}

function parseTimestampMs(iso: string): number {
  const normalized = iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`;
  const ms = new Date(normalized).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function formatDuration(durationMs: number): string {
  const safeMs = Math.max(0, Number(durationMs || 0));
  const seconds = safeMs / 1000;
  if (seconds >= 60) {
    const mins = Math.floor(seconds / 60);
    const rem = Math.round(seconds % 60);
    return `${mins}m ${String(rem).padStart(2, '0')}s`;
  }
  return `${seconds.toFixed(1)}s`;
}

export const GalleryView: React.FC<GalleryViewProps> = ({
  categories,
  generations,
  workflows,
  onDeleted,
  onReuseInWorkspace,
  onGoWorkspace,
}) => {
  const [mediaFilter, setMediaFilter] = useState<'all' | 'image' | 'video'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [workflowFilter, setWorkflowFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<SortOption>('newest');
  const [search, setSearch] = useState('');
  const [activeItem, setActiveItem] = useState<GenerationRecord | null>(null);
  const [selectedOutputIndex, setSelectedOutputIndex] = useState(0);
  const [lightboxMedia, setLightboxMedia] = useState<LightboxMedia | null>(null);
  const [lightboxMode, setLightboxMode] = useState<'original' | 'fit'>('original');
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const categoryOptions = useMemo(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const c of categories) {
      if (c.name && !seen.has(c.name)) {
        seen.add(c.name);
        names.push(c.name);
      }
    }
    for (const g of generations) {
      if (g.category_name && !seen.has(g.category_name)) {
        seen.add(g.category_name);
        names.push(g.category_name);
      }
    }
    return names;
  }, [categories, generations]);

  const availableWorkflows = useMemo(() => {
    if (categoryFilter === 'all') return workflows;
    return workflows.filter((wf) => wf.category_name === categoryFilter);
  }, [workflows, categoryFilter]);

  const handleCategoryChange = (nextCategory: string) => {
    setCategoryFilter(nextCategory);
    if (nextCategory === 'all') return;
    const stillValid = workflows.some(
      (wf) => String(wf.id) === workflowFilter && wf.category_name === nextCategory,
    );
    if (!stillValid) {
      setWorkflowFilter('all');
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = generations.filter((g) => {
      if (mediaFilter !== 'all' && g.media_type !== mediaFilter) return false;
      if (categoryFilter !== 'all' && g.category_name !== categoryFilter) return false;
      if (workflowFilter !== 'all' && String(g.workflow_id) !== workflowFilter) return false;
      if (q) {
        const hay = `${g.workflow_name} ${g.category_name} ${g.prompt_id} ${JSON.stringify(g.submitted_inputs)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    return [...list].sort((a, b) => {
      if (sortBy === 'duration_desc') {
        const diff = (b.duration_ms || 0) - (a.duration_ms || 0);
        return diff !== 0 ? diff : b.id - a.id;
      }
      if (sortBy === 'duration_asc') {
        const diff = (a.duration_ms || 0) - (b.duration_ms || 0);
        return diff !== 0 ? diff : b.id - a.id;
      }
      const timeDiff = parseTimestampMs(a.created_at) - parseTimestampMs(b.created_at);
      if (sortBy === 'oldest') {
        return timeDiff !== 0 ? timeDiff : a.id - b.id;
      }
      return timeDiff !== 0 ? -timeDiff : b.id - a.id;
    });
  }, [generations, mediaFilter, categoryFilter, workflowFilter, sortBy, search]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (lightboxMedia) {
        setLightboxMedia(null);
      } else if (activeItem) {
        setActiveItem(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [lightboxMedia, activeItem]);

  const openDetailModal = (item: GenerationRecord) => {
    setSelectedOutputIndex(0);
    setActiveItem(item);
  };

  const openOriginalLightbox = (media: LightboxMedia) => {
    setNaturalSize(null);
    setLightboxMode('original');
    setLightboxMedia(media);
  };

  const handleDelete = async (id: number) => {
    setDeletingId(id);
    try {
      await api.deleteGeneration(id);
      if (activeItem?.id === id) {
        setActiveItem(null);
      }
      onDeleted(id);
    } finally {
      setDeletingId(null);
    }
  };

  const formatTimestamp = (iso: string) => {
    const normalized = iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`;
    const dt = new Date(normalized);
    if (Number.isNaN(dt.getTime())) return iso;
    return dt.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const activeOutput = activeItem
    ? activeItem.outputs[selectedOutputIndex] || activeItem.outputs[0] || null
    : null;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-[#0B0D11]">
      {/* Filter Toolbar */}
      <div className="px-6 py-3.5 border-b border-zinc-800/80 bg-[#12151B] flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-1 p-1 bg-[#0B0D11] border border-zinc-800 rounded-md">
            {(['all', 'image', 'video'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setMediaFilter(tab)}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors capitalize cursor-pointer ${
                  mediaFilter === tab
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {tab === 'all' ? 'All Media' : `${tab}s`}
              </button>
            ))}
          </div>

          <select
            aria-label="Filter by category"
            value={categoryFilter}
            onChange={(e) => handleCategoryChange(e.target.value)}
            className="px-3 py-1.5 text-xs bg-[#0B0D11] border border-zinc-800 rounded-md text-zinc-200 focus:outline-none focus:border-blue-500 cursor-pointer"
          >
            <option value="all">All Categories</option>
            {categoryOptions.map((catName) => (
              <option key={catName} value={catName}>
                {catName}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by workflow template"
            value={workflowFilter}
            onChange={(e) => setWorkflowFilter(e.target.value)}
            className="px-3 py-1.5 text-xs bg-[#0B0D11] border border-zinc-800 rounded-md text-zinc-200 focus:outline-none focus:border-blue-500 cursor-pointer max-w-[240px]"
          >
            <option value="all">
              {categoryFilter === 'all' ? 'All Workflows' : `All in ${categoryFilter}`}
            </option>
            {availableWorkflows.map((wf) => (
              <option key={wf.id} value={String(wf.id)}>
                {wf.name}
              </option>
            ))}
          </select>

          <select
            aria-label="Sort gallery items"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortOption)}
            className="px-3 py-1.5 text-xs bg-[#0B0D11] border border-zinc-800 rounded-md text-zinc-200 focus:outline-none focus:border-blue-500 cursor-pointer"
          >
            <option value="newest">Sort: Newest First</option>
            <option value="oldest">Sort: Oldest First</option>
            <option value="duration_desc">Sort: Duration (Longest)</option>
            <option value="duration_asc">Sort: Duration (Fastest)</option>
          </select>
        </div>

        <div className="flex items-center gap-4">
          <div className="relative w-60">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search prompts or parameters..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-[#0B0D11] border border-zinc-800 rounded-md text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500"
            />
          </div>
          <span className="text-xs font-mono text-zinc-500 tabular-nums whitespace-nowrap">
            {filtered.length} items
          </span>
        </div>
      </div>

      {/* Media Grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {filtered.length === 0 ? (
          <div className="h-full min-h-[360px] flex flex-col items-center justify-center text-center space-y-3">
            {generations.length === 0 ? (
              <>
                <ImageIcon className="w-7 h-7 text-zinc-600" />
                <p className="text-sm font-medium text-zinc-200">No generated outputs yet</p>
                <p className="text-xs text-zinc-500 max-w-sm leading-relaxed">
                  Run a workflow in the Workspace to save rendered PNG/WEBP images and VHS_VideoCombine MP4/WEBM clips here with full parameter metadata.
                </p>
                <button
                  type="button"
                  onClick={onGoWorkspace}
                  className="px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-md transition-colors cursor-pointer"
                >
                  Open Workspace
                </button>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-zinc-200">No matching results</p>
                <p className="text-xs text-zinc-500">
                  Adjust your category, workflow, media filter, or search terms.
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5 items-stretch">
            {filtered.map((item) => {
              const primary = item.outputs[0];
              const isVideo = item.media_type === 'video' || primary?.media_type === 'video';
              const hasInputs = Boolean(item.input_media && item.input_media.length > 0);
              return (
                <div
                  key={item.id}
                  className="group rounded-lg border border-zinc-800/80 bg-[#12151B] overflow-hidden flex flex-col h-full"
                >
                  {/* Fixed-height uncropped media viewport */}
                  <div className="relative h-60 w-full shrink-0 bg-[#07090C] overflow-hidden border-b border-zinc-800/60">
                    <button
                      type="button"
                      onClick={() => openDetailModal(item)}
                      className="w-full h-full flex items-center justify-center p-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      title="View details, inputs, and parameters"
                    >
                      {primary?.url ? (
                        isVideo ? (
                          <video
                            src={primary.url}
                            muted
                            loop
                            playsInline
                            onMouseEnter={(e) => {
                              void e.currentTarget.play().catch(() => {});
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.pause();
                            }}
                            className="max-w-full max-h-full w-full h-full object-contain"
                          />
                        ) : (
                          <img
                            src={primary.url}
                            alt={item.workflow_name}
                            referrerPolicy="no-referrer"
                            className="max-w-full max-h-full w-full h-full object-contain"
                          />
                        )
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-zinc-600">
                          <ImageIcon className="w-6 h-6" />
                        </div>
                      )}
                    </button>

                    <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5">
                      {isVideo && (
                        <span
                          title="Video output"
                          className="p-1.5 rounded-md bg-black/75 border border-zinc-700/60 text-zinc-100 pointer-events-none"
                        >
                          <Film className="w-3.5 h-3.5" />
                        </span>
                      )}
                      {primary?.url && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openOriginalLightbox({
                              url: primary.url,
                              title: item.workflow_name,
                              filename: primary.original_filename || primary.filename,
                              mediaType: isVideo ? 'video' : 'image',
                            });
                          }}
                          title="Open original size"
                          aria-label="Open original size"
                          className="p-1.5 rounded-md bg-black/75 hover:bg-blue-600 border border-zinc-700/60 hover:border-blue-500 text-zinc-200 hover:text-white transition-colors cursor-pointer"
                        >
                          <Maximize2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Fixed-structure footer to preserve uniform grid alignment */}
                  <div className="p-3.5 flex-1 flex flex-col justify-between gap-2 min-w-0">
                    <div className="flex items-start justify-between gap-2 min-w-0">
                      <button
                        type="button"
                        onClick={() => openDetailModal(item)}
                        className="min-w-0 text-left cursor-pointer hover:text-blue-400 transition-colors"
                      >
                        <p className="text-xs font-medium text-zinc-100 truncate">
                          {item.workflow_name}
                        </p>
                        <p className="text-[11px] text-zinc-500 truncate tabular-nums mt-0.5">
                          {item.category_name} · {formatTimestamp(item.created_at)}
                        </p>
                      </button>

                      {primary?.url && (
                        <a
                          href={primary.url}
                          download={primary.original_filename || primary.filename}
                          title="Download media"
                          className="p-1.5 text-zinc-400 hover:text-zinc-100 rounded hover:bg-zinc-800 transition-colors shrink-0"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-2 pt-2 border-t border-zinc-800/60 text-[11px] font-mono text-zinc-400 tabular-nums">
                      <span className="inline-flex items-center gap-1 shrink-0" title="Generation duration">
                        <Clock className="w-3 h-3 text-zinc-500" />
                        {formatDuration(item.duration_ms)}
                      </span>
                      <span className="text-zinc-500 truncate">
                        {item.outputs.length > 1 ? `${item.outputs.length} outputs` : primary?.format?.toUpperCase() || item.media_type.toUpperCase()}
                        {hasInputs ? ` · ${item.input_media!.length} input${item.input_media!.length > 1 ? 's' : ''}` : ''}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Metadata, Input Media & Output Inspector Modal */}
      {activeItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setActiveItem(null)}
        >
          <div
            className="w-full max-w-6xl max-h-[90vh] rounded-lg border border-zinc-800 bg-[#12151B] flex flex-col overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between gap-4 shrink-0">
              <div className="min-w-0">
                <h2 className="font-display text-sm font-semibold text-zinc-100 truncate">
                  {activeItem.workflow_name}
                </h2>
                <p className="text-xs text-zinc-500 tabular-nums">
                  {activeItem.category_name} · {formatTimestamp(activeItem.created_at)} ·{' '}
                  Generation time: {formatDuration(activeItem.duration_ms)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveItem(null)}
                className="p-1.5 text-zinc-400 hover:text-zinc-100 rounded hover:bg-zinc-800 cursor-pointer"
                aria-label="Close inspector"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
              {/* Left Output Viewport */}
              <div className="lg:col-span-7 bg-[#07090C] flex flex-col min-h-[280px] overflow-hidden border-b lg:border-b-0 lg:border-r border-zinc-800">
                <div className="relative flex-1 min-h-0 flex items-center justify-center p-4 overflow-hidden">
                  {activeOutput?.url ? (
                    activeOutput.media_type === 'video' ? (
                      <video
                        key={activeOutput.url}
                        src={activeOutput.url}
                        controls
                        autoPlay
                        loop
                        muted
                        playsInline
                        className="max-w-full max-h-[64vh] object-contain"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          openOriginalLightbox({
                            url: activeOutput.url,
                            title: activeItem.workflow_name,
                            filename: activeOutput.original_filename || activeOutput.filename,
                            mediaType: 'image',
                          })
                        }
                        title="Click to view original size"
                        className="flex items-center justify-center max-w-full max-h-[64vh] cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      >
                        <img
                          src={activeOutput.url}
                          alt={activeItem.workflow_name}
                          referrerPolicy="no-referrer"
                          className="max-w-full max-h-[64vh] object-contain"
                        />
                      </button>
                    )
                  ) : (
                    <span className="text-xs text-zinc-500">Output file unavailable</span>
                  )}

                  {activeOutput?.url && (
                    <button
                      type="button"
                      onClick={() =>
                        openOriginalLightbox({
                          url: activeOutput.url,
                          title: activeItem.workflow_name,
                          filename: activeOutput.original_filename || activeOutput.filename,
                          mediaType: activeOutput.media_type === 'video' ? 'video' : 'image',
                        })
                      }
                      className="absolute top-3 right-3 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-black/80 hover:bg-blue-600 border border-zinc-700/80 hover:border-blue-500 text-zinc-200 hover:text-white transition-colors cursor-pointer"
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                      Original Size
                    </button>
                  )}
                </div>

                {activeItem.outputs.length > 1 && (
                  <div className="px-4 py-2.5 border-t border-zinc-800/80 bg-[#0B0D11] flex items-center gap-2 overflow-x-auto shrink-0">
                    {activeItem.outputs.map((out, idx) => (
                      <button
                        key={out.filename}
                        type="button"
                        onClick={() => setSelectedOutputIndex(idx)}
                        className={`px-2.5 py-1 text-xs font-mono rounded border transition-colors shrink-0 cursor-pointer ${
                          idx === selectedOutputIndex
                            ? 'border-blue-500 bg-blue-600/15 text-blue-300'
                            : 'border-zinc-800 bg-[#12151B] text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        Output {idx + 1}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Right Details: Prompt ID, Input Media, Submitted Parameters */}
              <div className="lg:col-span-5 flex flex-col min-h-0">
                <div className="flex-1 overflow-y-auto p-5 space-y-5">
                  <div className="space-y-1">
                    <span className="text-[11px] font-medium text-zinc-400">Prompt ID</span>
                    <p className="text-xs font-mono text-zinc-200 break-all">
                      {activeItem.prompt_id}
                    </p>
                  </div>

                  {activeItem.input_media && activeItem.input_media.length > 0 && (
                    <div className="space-y-2">
                      <span className="text-[11px] font-medium text-zinc-400">
                        Input Media ({activeItem.input_media.length})
                      </span>
                      <div className="space-y-2.5">
                        {activeItem.input_media.map((inp) => (
                          <div
                            key={`${inp.key}-${inp.filename}`}
                            className="rounded-md border border-zinc-800 bg-[#0B0D11] overflow-hidden"
                          >
                            <div className="relative h-40 w-full bg-[#07090C] flex items-center justify-center p-2">
                              {inp.media_type === 'video' ? (
                                <video
                                  src={inp.url}
                                  controls
                                  muted
                                  loop
                                  playsInline
                                  className="max-w-full max-h-full w-full h-full object-contain"
                                />
                              ) : (
                                <button
                                  type="button"
                                  onClick={() =>
                                    openOriginalLightbox({
                                      url: inp.url,
                                      title: inp.label || inp.field_name,
                                      filename: inp.original_filename || inp.comfy_name,
                                      mediaType: 'image',
                                    })
                                  }
                                  title="Click to view original size"
                                  className="w-full h-full flex items-center justify-center cursor-zoom-in"
                                >
                                  <img
                                    src={inp.url}
                                    alt={inp.original_filename || inp.field_name}
                                    referrerPolicy="no-referrer"
                                    className="max-w-full max-h-full w-full h-full object-contain"
                                  />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() =>
                                  openOriginalLightbox({
                                    url: inp.url,
                                    title: inp.label || inp.field_name,
                                    filename: inp.original_filename || inp.comfy_name,
                                    mediaType: inp.media_type === 'video' ? 'video' : 'image',
                                  })
                                }
                                title="Open input in original size"
                                className="absolute top-2 right-2 p-1.5 rounded bg-black/75 hover:bg-blue-600 border border-zinc-700/60 text-zinc-200 hover:text-white transition-colors cursor-pointer"
                              >
                                <Maximize2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                            <div className="px-3 py-2 border-t border-zinc-800/70 flex items-center justify-between gap-2 text-xs">
                              <span className="text-zinc-300 font-medium truncate">
                                {inp.label || inp.field_name}
                              </span>
                              <span className="font-mono text-[11px] text-zinc-500 truncate">
                                {inp.original_filename}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    <span className="text-[11px] font-medium text-zinc-400">
                      Submitted Parameters
                    </span>
                    <div className="rounded-md border border-zinc-800 bg-[#0B0D11] divide-y divide-zinc-800/70">
                      {Object.entries(activeItem.submitted_inputs).map(([key, val]) => (
                        <div key={key} className="px-3 py-2 text-xs space-y-0.5">
                          <div className="font-mono text-[11px] text-zinc-500">{key}</div>
                          <div className="text-zinc-200 break-words font-mono tabular-nums">
                            {String(val)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="p-4 border-t border-zinc-800 flex items-center justify-between gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={deletingId === activeItem.id}
                    onClick={() => void handleDelete(activeItem.id)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-red-300 hover:bg-red-950/50 rounded-md transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete
                  </button>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        onReuseInWorkspace(activeItem);
                        setActiveItem(null);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-md transition-colors cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5" />
                      Reuse Parameters
                    </button>
                    {activeOutput?.url && (
                      <a
                        href={activeOutput.url}
                        download={activeOutput.original_filename || activeOutput.filename}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-md transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Download
                      </a>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Original Size Full-Resolution Lightbox Popup */}
      {lightboxMedia && (
        <div
          className="fixed inset-0 z-[60] bg-black/95 flex flex-col"
          role="dialog"
          aria-modal="true"
          aria-label="Original size viewer"
        >
          <div className="px-5 py-3 border-b border-zinc-800 bg-[#12151B]/95 flex items-center justify-between gap-4 shrink-0">
            <div className="min-w-0 flex items-center gap-3">
              <span className="text-xs font-semibold text-zinc-100 truncate">
                {lightboxMedia.title}
              </span>
              <span className="text-xs font-mono text-zinc-400 truncate hidden sm:inline">
                {lightboxMedia.filename}
              </span>
              {naturalSize && (
                <span className="text-xs font-mono text-blue-400 tabular-nums shrink-0">
                  {naturalSize.width} × {naturalSize.height}px
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() =>
                  setLightboxMode((prev) => (prev === 'original' ? 'fit' : 'original'))
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-md transition-colors cursor-pointer"
              >
                {lightboxMode === 'original' ? (
                  <>
                    <Minimize2 className="w-3.5 h-3.5" />
                    Fit Screen
                  </>
                ) : (
                  <>
                    <Maximize2 className="w-3.5 h-3.5" />
                    Original Size (1:1)
                  </>
                )}
              </button>

              <a
                href={lightboxMedia.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-md transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Open Raw
              </a>

              <a
                href={lightboxMedia.url}
                download={lightboxMedia.filename}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Download
              </a>

              <button
                type="button"
                onClick={() => setLightboxMedia(null)}
                className="p-1.5 text-zinc-400 hover:text-zinc-100 rounded hover:bg-zinc-800 cursor-pointer"
                aria-label="Close original size viewer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div
            className="flex-1 min-h-0 overflow-auto flex p-4"
            onClick={() => setLightboxMedia(null)}
          >
            {lightboxMedia.mediaType === 'video' ? (
              <video
                src={lightboxMedia.url}
                controls
                autoPlay
                loop
                playsInline
                onLoadedMetadata={(e) => {
                  setNaturalSize({
                    width: e.currentTarget.videoWidth,
                    height: e.currentTarget.videoHeight,
                  });
                }}
                onClick={(e) => e.stopPropagation()}
                className={
                  lightboxMode === 'original'
                    ? 'm-auto max-w-none max-h-none block'
                    : 'm-auto max-w-full max-h-full object-contain block'
                }
              />
            ) : (
              <img
                src={lightboxMedia.url}
                alt={lightboxMedia.title}
                referrerPolicy="no-referrer"
                onLoad={(e) => {
                  setNaturalSize({
                    width: e.currentTarget.naturalWidth,
                    height: e.currentTarget.naturalHeight,
                  });
                }}
                onClick={(e) => e.stopPropagation()}
                className={
                  lightboxMode === 'original'
                    ? 'm-auto max-w-none max-h-none block'
                    : 'm-auto max-w-full max-h-full object-contain block'
                }
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
};

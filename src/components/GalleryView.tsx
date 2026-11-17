import React, { useMemo, useState } from 'react';
import { Download, Film, Image as ImageIcon, Play, Search, Trash2, X } from 'lucide-react';
import { api } from '../lib/api.ts';
import type { GenerationRecord, WorkflowTemplate } from '../types/comfy.ts';

interface GalleryViewProps {
  generations: GenerationRecord[];
  workflows: WorkflowTemplate[];
  onDeleted: (id: number) => void;
  onReuseInWorkspace: (generation: GenerationRecord) => void;
  onGoWorkspace: () => void;
}

export const GalleryView: React.FC<GalleryViewProps> = ({
  generations,
  workflows,
  onDeleted,
  onReuseInWorkspace,
  onGoWorkspace,
}) => {
  const [mediaFilter, setMediaFilter] = useState<'all' | 'image' | 'video'>('all');
  const [workflowFilter, setWorkflowFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [activeItem, setActiveItem] = useState<GenerationRecord | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return generations.filter((g) => {
      if (mediaFilter !== 'all' && g.media_type !== mediaFilter) return false;
      if (workflowFilter !== 'all' && String(g.workflow_id) !== workflowFilter) return false;
      if (q) {
        const hay = `${g.workflow_name} ${g.category_name} ${JSON.stringify(g.submitted_inputs)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [generations, mediaFilter, workflowFilter, search]);

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

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-[#0B0D11]">
      {/* Filter Toolbar */}
      <div className="px-6 py-3.5 border-b border-zinc-800/80 bg-[#12151B] flex flex-wrap items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-3">
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
            aria-label="Filter by workflow template"
            value={workflowFilter}
            onChange={(e) => setWorkflowFilter(e.target.value)}
            className="px-3 py-1.5 text-xs bg-[#0B0D11] border border-zinc-800 rounded-md text-zinc-200 focus:outline-none focus:border-blue-500"
          >
            <option value="all">All Workflows</option>
            {workflows.map((wf) => (
              <option key={wf.id} value={String(wf.id)}>
                {wf.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-4">
          <div className="relative w-64">
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
                <p className="text-xs text-zinc-500">Adjust your media filter or search terms.</p>
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {filtered.map((item) => {
              const primary = item.outputs[0];
              const isVideo = item.media_type === 'video' || primary?.media_type === 'video';
              return (
                <div
                  key={item.id}
                  className="group rounded-lg border border-zinc-800/80 bg-[#12151B] overflow-hidden flex flex-col"
                >
                  <button
                    type="button"
                    onClick={() => setActiveItem(item)}
                    className="relative aspect-square w-full bg-[#0B0D11] overflow-hidden cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
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
                          className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                        />
                      ) : (
                        <img
                          src={primary.url}
                          alt={item.workflow_name}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                        />
                      )
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-zinc-600">
                        <ImageIcon className="w-6 h-6" />
                      </div>
                    )}

                    {isVideo && (
                      <span className="absolute top-2.5 right-2.5 p-1.5 rounded-md bg-black/70 text-zinc-100">
                        <Film className="w-3.5 h-3.5" />
                      </span>
                    )}
                  </button>

                  <div className="p-3.5 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-zinc-100 truncate">
                        {item.workflow_name}
                      </p>
                      <p className="text-[11px] text-zinc-500 truncate tabular-nums mt-0.5">
                        {item.category_name} · {formatTimestamp(item.created_at)}
                      </p>
                    </div>

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
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Metadata & Output Inspector Modal */}
      {activeItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-5xl max-h-[90vh] rounded-lg border border-zinc-800 bg-[#12151B] flex flex-col overflow-hidden shadow-2xl">
            <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between gap-4 shrink-0">
              <div className="min-w-0">
                <h2 className="font-display text-sm font-semibold text-zinc-100 truncate">
                  {activeItem.workflow_name}
                </h2>
                <p className="text-xs text-zinc-500 tabular-nums">
                  {activeItem.category_name} · {formatTimestamp(activeItem.created_at)} ·{' '}
                  {(activeItem.duration_ms / 1000).toFixed(1)}s
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
              <div className="lg:col-span-7 bg-[#0B0D11] flex items-center justify-center p-4 min-h-[280px] overflow-hidden border-b lg:border-b-0 lg:border-r border-zinc-800">
                {activeItem.outputs[0]?.url ? (
                  activeItem.media_type === 'video' ? (
                    <video
                      src={activeItem.outputs[0].url}
                      controls
                      autoPlay
                      loop
                      muted
                      playsInline
                      className="max-w-full max-h-[68vh] object-contain"
                    />
                  ) : (
                    <img
                      src={activeItem.outputs[0].url}
                      alt={activeItem.workflow_name}
                      referrerPolicy="no-referrer"
                      className="max-w-full max-h-[68vh] object-contain"
                    />
                  )
                ) : (
                  <span className="text-xs text-zinc-500">Output file unavailable</span>
                )}
              </div>

              <div className="lg:col-span-5 flex flex-col min-h-0">
                <div className="flex-1 overflow-y-auto p-5 space-y-4">
                  <div className="space-y-1">
                    <span className="text-[11px] font-medium text-zinc-400">Prompt ID</span>
                    <p className="text-xs font-mono text-zinc-200 break-all">
                      {activeItem.prompt_id}
                    </p>
                  </div>

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
                    {activeItem.outputs[0]?.url && (
                      <a
                        href={activeItem.outputs[0].url}
                        download={
                          activeItem.outputs[0].original_filename ||
                          activeItem.outputs[0].filename
                        }
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
    </div>
  );
};

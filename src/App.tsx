import { useCallback, useEffect, useState } from 'react';
import { api } from './lib/api.ts';
import type { Category, GenerationRecord, WorkflowTemplate } from './types/comfy.ts';
import { TopBar, type AppRoute } from './components/TopBar.tsx';
import { ConnectionModal } from './components/ConnectionModal.tsx';
import { WorkspaceView } from './components/WorkspaceView.tsx';
import { TemplatesView } from './components/TemplatesView.tsx';
import { QueuingView } from './components/QueuingView.tsx';
import { GalleryView } from './components/GalleryView.tsx';

function getInitialRoute(): AppRoute {
  const path = window.location.pathname;
  if (path.startsWith('/templates')) return '/templates';
  if (path.startsWith('/queuing')) return '/queuing';
  if (path.startsWith('/gallery')) return '/gallery';
  return '/';
}

function getInitialWorkflowId(): number | null {
  try {
    const saved = window.localStorage.getItem('comfycentre:selected_workflow_id');
    if (saved) {
      const parsed = Number(saved);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch {
    // ignore storage errors
  }
  return null;
}

export default function App() {
  const [route, setRoute] = useState<AppRoute>(getInitialRoute);
  const [categories, setCategories] = useState<Category[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([]);
  const [generations, setGenerations] = useState<GenerationRecord[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<number | null>(getInitialWorkflowId);
  const [prefilledGeneration, setPrefilledGeneration] = useState<GenerationRecord | null>(null);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [createTemplateTrigger, setCreateTemplateTrigger] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const navigate = useCallback((nextRoute: AppRoute) => {
    setRoute(nextRoute);
    if (window.location.pathname !== nextRoute) {
      window.history.pushState({}, '', nextRoute);
    }
  }, []);

  useEffect(() => {
    const onPopState = () => {
      setRoute(getInitialRoute());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const refreshAll = useCallback(async () => {
    const [catsRes, wfsRes, gensRes] = await Promise.allSettled([
      api.listCategories(),
      api.listWorkflows(),
      api.listGenerations(),
    ]);

    const errors: string[] = [];

    if (catsRes.status === 'fulfilled' && Array.isArray(catsRes.value)) {
      setCategories(catsRes.value);
    } else if (catsRes.status === 'rejected') {
      errors.push(catsRes.reason instanceof Error ? catsRes.reason.message : 'Failed to load categories');
    }

    if (wfsRes.status === 'fulfilled' && Array.isArray(wfsRes.value)) {
      const nextWfs = wfsRes.value;
      setWorkflows(nextWfs);
      setSelectedWorkflowId((prev) => {
        if (prev && nextWfs.some((w) => w.id === prev)) return prev;
        return nextWfs[0]?.id ?? null;
      });
    } else if (wfsRes.status === 'rejected') {
      errors.push(wfsRes.reason instanceof Error ? wfsRes.reason.message : 'Failed to load workflows');
    }

    if (gensRes.status === 'fulfilled' && Array.isArray(gensRes.value)) {
      setGenerations(gensRes.value);
    } else if (gensRes.status === 'rejected') {
      errors.push(gensRes.reason instanceof Error ? gensRes.reason.message : 'Failed to load gallery');
    }

    if (errors.length > 0) {
      const msg = errors[0];
      setLoadError(msg);
      throw new Error(msg);
    }
    setLoadError(null);
  }, []);

  useEffect(() => {
    if (selectedWorkflowId !== null) {
      try {
        window.localStorage.setItem('comfycentre:selected_workflow_id', String(selectedWorkflowId));
      } catch {
        // ignore storage errors
      }
    }
  }, [selectedWorkflowId]);

  useEffect(() => {
    let cancelled = false;
    const loadWithRetry = async () => {
      const delays = [0, 800, 1800];
      for (let i = 0; i < delays.length; i++) {
        if (cancelled) return;
        if (delays[i] > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, delays[i]));
        }
        if (cancelled) return;
        try {
          await refreshAll();
          return;
        } catch {
          if (i === delays.length - 1) {
            return;
          }
        }
      }
    };
    void loadWithRetry().finally(() => {
      if (!cancelled) {
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [refreshAll]);

  const handleNewTemplate = () => {
    setCreateTemplateTrigger((c) => c + 1);
    navigate('/templates');
  };

  const handleReuseInWorkspace = (gen: GenerationRecord) => {
    setSelectedWorkflowId(gen.workflow_id);
    setPrefilledGeneration(gen);
    navigate('/');
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-[#0B0D11] text-zinc-100 overflow-hidden">
      <TopBar
        activeRoute={route}
        onNavigate={navigate}
        onOpenConnection={() => setConnectionOpen(true)}
        onNewTemplate={handleNewTemplate}
      />

      {loadError && !loading && (
        <div className="px-6 py-2.5 bg-red-950/60 border-b border-red-900/70 flex items-center justify-between gap-4 text-xs text-red-200 shrink-0">
          <span className="truncate">Failed to sync studio data: {loadError}</span>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void refreshAll().catch(() => {}).finally(() => setLoading(false));
            }}
            className="px-2.5 py-1 text-xs font-medium bg-red-900/80 hover:bg-red-800 text-white rounded transition-colors cursor-pointer shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-xs text-zinc-500">
          Loading studio workspace...
        </div>
      ) : (
        <>
          {route === '/' && (
            <WorkspaceView
              categories={categories}
              workflows={workflows}
              selectedWorkflowId={selectedWorkflowId}
              prefilledGeneration={prefilledGeneration}
              onSelectWorkflow={(id) => {
                setPrefilledGeneration(null);
                setSelectedWorkflowId(id);
              }}
              onClearPrefilled={() => setPrefilledGeneration(null)}
              onOpenConnection={() => setConnectionOpen(true)}
              onGenerationComplete={(gen) => {
                setGenerations((prev) => [gen, ...prev]);
              }}
              onGoTemplates={handleNewTemplate}
            />
          )}

          {route === '/templates' && (
            <TemplatesView
              categories={categories}
              workflows={workflows}
              createModeTrigger={createTemplateTrigger}
              onRefreshData={refreshAll}
              onOpenInWorkspace={(wfId) => {
                setPrefilledGeneration(null);
                setSelectedWorkflowId(wfId);
                navigate('/');
              }}
            />
          )}

          {route === '/queuing' && (
            <QueuingView
              onOpenConnection={() => setConnectionOpen(true)}
              onOpenWorkspace={(wfId) => {
                setPrefilledGeneration(null);
                if (wfId) {
                  setSelectedWorkflowId(wfId);
                }
                navigate('/');
              }}
              onOpenGallery={() => {
                void refreshAll().catch(() => {});
                navigate('/gallery');
              }}
            />
          )}

          {route === '/gallery' && (
            <GalleryView
              categories={categories}
              generations={generations}
              workflows={workflows}
              onDeleted={(id) => {
                setGenerations((prev) => prev.filter((g) => g.id !== id));
              }}
              onReuseInWorkspace={handleReuseInWorkspace}
              onGoWorkspace={() => navigate('/')}
            />
          )}
        </>
      )}

      <ConnectionModal
        isOpen={connectionOpen}
        onClose={() => setConnectionOpen(false)}
      />
    </div>
  );
}

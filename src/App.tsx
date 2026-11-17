import { useCallback, useEffect, useState } from 'react';
import { api } from './lib/api.ts';
import type { Category, GenerationRecord, WorkflowTemplate } from './types/comfy.ts';
import { TopBar, type AppRoute } from './components/TopBar.tsx';
import { ConnectionModal } from './components/ConnectionModal.tsx';
import { WorkspaceView } from './components/WorkspaceView.tsx';
import { TemplatesView } from './components/TemplatesView.tsx';
import { GalleryView } from './components/GalleryView.tsx';

function getInitialRoute(): AppRoute {
  const path = window.location.pathname;
  if (path.startsWith('/templates')) return '/templates';
  if (path.startsWith('/gallery')) return '/gallery';
  return '/';
}

export default function App() {
  const [route, setRoute] = useState<AppRoute>(getInitialRoute);
  const [categories, setCategories] = useState<Category[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([]);
  const [generations, setGenerations] = useState<GenerationRecord[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<number | null>(null);
  const [prefilledInputs, setPrefilledInputs] = useState<Record<string, unknown> | null>(null);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [createTemplateTrigger, setCreateTemplateTrigger] = useState(0);
  const [loading, setLoading] = useState(true);

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
    const [cats, wfs, gens] = await Promise.all([
      api.listCategories(),
      api.listWorkflows(),
      api.listGenerations(),
    ]);
    setCategories(cats);
    setWorkflows(wfs);
    setGenerations(gens);
    setSelectedWorkflowId((prev) => {
      if (prev && wfs.some((w) => w.id === prev)) return prev;
      return wfs[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    void refreshAll().finally(() => setLoading(false));
  }, [refreshAll]);

  const handleNewTemplate = () => {
    setCreateTemplateTrigger((c) => c + 1);
    navigate('/templates');
  };

  const handleReuseInWorkspace = (gen: GenerationRecord) => {
    setSelectedWorkflowId(gen.workflow_id);
    setPrefilledInputs(gen.submitted_inputs);
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
              prefilledInputs={prefilledInputs}
              onSelectWorkflow={(id) => {
                setPrefilledInputs(null);
                setSelectedWorkflowId(id);
              }}
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
                setPrefilledInputs(null);
                setSelectedWorkflowId(wfId);
                navigate('/');
              }}
            />
          )}

          {route === '/gallery' && (
            <GalleryView
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

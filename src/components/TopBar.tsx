import React from 'react';

export type AppRoute = '/' | '/templates' | '/queuing' | '/gallery';

interface TopBarProps {
  activeRoute: AppRoute;
  onNavigate: (route: AppRoute) => void;
  onOpenConnection: () => void;
  onNewTemplate: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  activeRoute,
  onNavigate,
  onOpenConnection,
  onNewTemplate,
}) => {
  const navLinkClass = (isActive: boolean) =>
    `text-sm font-medium transition-colors duration-150 whitespace-nowrap shrink-0 py-1 border-b-2 ${
      isActive
        ? 'text-zinc-100 border-blue-500'
        : 'text-zinc-400 border-transparent hover:text-zinc-100 hover:border-zinc-700'
    }`;

  return (
    <header className="h-14 border-b border-zinc-800/80 bg-[#0B0D11] px-6 flex items-center justify-between gap-8 shrink-0">
      <a
        href="/"
        onClick={(e) => {
          e.preventDefault();
          onNavigate('/');
        }}
        className="font-display text-base font-semibold tracking-tight text-zinc-100 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
      >
        ComfyCentre
      </a>

      <nav className="flex items-center gap-6" aria-label="Primary Navigation">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('/');
          }}
          className={navLinkClass(activeRoute === '/')}
        >
          Workspace
        </a>
        <a
          href="/templates"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('/templates');
          }}
          className={navLinkClass(activeRoute === '/templates')}
        >
          Templates
        </a>
        <a
          href="/queuing"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('/queuing');
          }}
          className={navLinkClass(activeRoute === '/queuing')}
        >
          Queuing
        </a>
        <a
          href="/gallery"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('/gallery');
          }}
          className={navLinkClass(activeRoute === '/gallery')}
        >
          Gallery
        </a>
        <button
          type="button"
          onClick={onOpenConnection}
          className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors duration-150 whitespace-nowrap shrink-0 py-1 border-b-2 border-transparent hover:border-zinc-700 cursor-pointer"
        >
          Connection
        </button>
      </nav>

      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={onNewTemplate}
          className="px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 active:bg-blue-700 rounded-md transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          New Template
        </button>
      </div>
    </header>
  );
};

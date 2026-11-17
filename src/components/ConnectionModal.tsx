import React, { useEffect, useState } from 'react';
import { CheckCircle2, RefreshCw, Server, X, AlertCircle } from 'lucide-react';
import { api } from '../lib/api.ts';
import type { ComfyHealthResponse } from '../types/comfy.ts';

interface ConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onUpdated?: (url: string) => void;
}

export const ConnectionModal: React.FC<ConnectionModalProps> = ({
  isOpen,
  onClose,
  onUpdated,
}) => {
  const [comfyUrl, setComfyUrl] = useState('');
  const [health, setHealth] = useState<ComfyHealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = async () => {
    setLoading(true);
    setError(null);
    try {
      const [settings, status] = await Promise.all([
        api.getSettings(),
        api.checkComfyHealth(),
      ]);
      setComfyUrl(settings.comfyui_url);
      setHealth(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to query settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void loadStatus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSaveAndTest = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateSettings(comfyUrl);
      onUpdated?.(updated.comfyui_url);
      const status = await api.checkComfyHealth();
      setHealth(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update ComfyUI URL');
    } finally {
      setSaving(false);
    }
  };

  const formatVram = (bytes?: number) => {
    if (!bytes) return 'Unknown';
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="connection-modal-title"
    >
      <div className="w-full max-w-lg rounded-lg border border-zinc-800 bg-[#12151B] shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-2.5">
            <Server className="w-4 h-4 text-zinc-400" />
            <h2 id="connection-modal-title" className="font-display text-base font-semibold text-zinc-100">
              Remote ComfyUI Backend
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-100 rounded-md hover:bg-zinc-800 transition-colors cursor-pointer"
            aria-label="Close connection settings"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSaveAndTest} className="p-5 space-y-5">
          <div>
            <label htmlFor="comfyui-url-input" className="block text-xs font-medium text-zinc-300 mb-1.5">
              ComfyUI Endpoint URL
            </label>
            <input
              id="comfyui-url-input"
              type="url"
              required
              value={comfyUrl}
              onChange={(e) => setComfyUrl(e.target.value)}
              placeholder="http://192.168.1.100:8188"
              className="w-full px-3 py-2 text-sm font-mono bg-[#0B0D11] border border-zinc-800 rounded-md text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500"
            />
            <p className="mt-1.5 text-xs text-zinc-500">
              Supports HTTP and HTTPS endpoints on your LAN, VPN, or remote GPU host. WebSocket relays automatically via ws:// or wss://.
            </p>
          </div>

          {error && (
            <div className="flex items-start gap-2.5 p-3 rounded-md border border-red-900/60 bg-red-950/30 text-xs text-red-300">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {health && (
            <div className="rounded-md border border-zinc-800 bg-[#0B0D11] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-400">Connection Status</span>
                {health.connected ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Connected
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400">
                    <AlertCircle className="w-3.5 h-3.5" />
                    Unreachable
                  </span>
                )}
              </div>

              {health.connected && health.system_stats ? (
                <div className="pt-2 border-t border-zinc-800/80 space-y-2 text-xs">
                  <div className="flex justify-between text-zinc-400">
                    <span>ComfyUI Version</span>
                    <span className="font-mono text-zinc-200 tabular-nums">
                      {health.system_stats.system?.comfyui_version || 'Unknown'}
                    </span>
                  </div>
                  <div className="flex justify-between text-zinc-400">
                    <span>PyTorch</span>
                    <span className="font-mono text-zinc-200 tabular-nums">
                      {health.system_stats.system?.pytorch_version || 'Unknown'}
                    </span>
                  </div>
                  {health.system_stats.devices?.map((dev, idx) => (
                    <div key={idx} className="flex justify-between text-zinc-400">
                      <span className="truncate max-w-[200px]">{dev.name || `Device ${idx}`}</span>
                      <span className="font-mono text-zinc-200 tabular-nums">
                        {formatVram(dev.vram_free)} free / {formatVram(dev.vram_total)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-zinc-500 font-mono break-all">
                  {health.error || 'Verify ComfyUI is running with --listen 0.0.0.0'}
                </p>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-zinc-800">
            <button
              type="button"
              onClick={() => void loadStatus()}
              disabled={loading || saving}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-zinc-300 bg-zinc-800/70 hover:bg-zinc-800 rounded-md transition-colors cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Test Connection
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-md transition-colors cursor-pointer disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Endpoint'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

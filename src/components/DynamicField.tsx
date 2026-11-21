import React, { useEffect, useState } from 'react';
import { Dices, Lock, Unlock, Upload, X, Film, Image as ImageIcon } from 'lucide-react';
import {
  formatDimensions,
  formatFileSize,
  formatVideoDuration,
  type MeasuredMediaMeta,
} from '../lib/mediaMeta.ts';
import type { InputMediaInfo, UIInputField } from '../types/comfy.ts';

interface DynamicFieldProps {
  field: UIInputField;
  value: string | number | boolean;
  fileValue: File | null;
  reusedMedia?: InputMediaInfo | null;
  seedLocked?: boolean;
  onToggleSeedLock?: () => void;
  onChange: (value: string | number | boolean) => void;
  onFileChange: (file: File | null) => void;
  onClearReusedMedia?: () => void;
}

export const DynamicField: React.FC<DynamicFieldProps> = ({
  field,
  value,
  fileValue,
  reusedMedia = null,
  seedLocked = false,
  onToggleSeedLock,
  onChange,
  onFileChange,
  onClearReusedMedia,
}) => {
  const [dragOver, setDragOver] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [measuredMeta, setMeasuredMeta] = useState<MeasuredMediaMeta | null>(null);

  useEffect(() => {
    if (!fileValue) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(fileValue);
    setPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [fileValue]);

  const inputBaseClass =
    'w-full px-3 py-2 text-sm bg-[#0B0D11] border border-zinc-800 rounded-md text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500 transition-colors';

  const randomizeSeed = () => {
    const next = Math.floor(Math.random() * 2_147_483_647);
    onChange(next);
  };

  const handleDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) {
      onFileChange(dropped);
    }
  };

  const isVideoFile = fileValue?.type.startsWith('video/');
  const activePreviewUrl = fileValue && previewUrl ? previewUrl : reusedMedia?.url || null;
  const activeIsVideo = fileValue ? Boolean(isVideoFile) : reusedMedia?.media_type === 'video';
  const activeFileName = fileValue
    ? fileValue.name
    : reusedMedia
      ? reusedMedia.original_filename || reusedMedia.comfy_name
      : '';
  const legacyMediaName =
    !activePreviewUrl && typeof value === 'string' && value.trim() ? value.trim() : '';

  useEffect(() => {
    setMeasuredMeta(null);
  }, [activePreviewUrl]);

  const dimText = formatDimensions(
    measuredMeta?.width ?? reusedMedia?.width,
    measuredMeta?.height ?? reusedMedia?.height,
  );
  const durationText = activeIsVideo
    ? formatVideoDuration(measuredMeta?.durationSeconds ?? reusedMedia?.duration_seconds)
    : null;
  const fileSizeText = formatFileSize(fileValue ? fileValue.size : reusedMedia?.file_size);
  const mediaMetaParts = [dimText, durationText, fileSizeText].filter(Boolean) as string[];

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <label
          htmlFor={`field-${field.id}`}
          className="text-xs font-medium text-zinc-200 truncate"
        >
          {field.label}
        </label>
        <span className="text-[11px] font-mono text-zinc-500 shrink-0 tabular-nums">
          Node {field.node_id} · {field.field_name}
        </span>
      </div>

      {field.widget === 'textarea' && (
        <textarea
          id={`field-${field.id}`}
          rows={4}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputBaseClass} resize-y leading-relaxed`}
        />
      )}

      {field.widget === 'text' && (
        <input
          id={`field-${field.id}`}
          type="text"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className={inputBaseClass}
        />
      )}

      {field.widget === 'number' && (
        <input
          id={`field-${field.id}`}
          type="number"
          value={Number(value ?? 0)}
          min={field.min}
          max={field.max}
          step={field.step ?? (field.value_type === 'float' ? 0.1 : 1)}
          onChange={(e) => {
            const parsed =
              field.value_type === 'int'
                ? parseInt(e.target.value, 10)
                : parseFloat(e.target.value);
            onChange(Number.isNaN(parsed) ? 0 : parsed);
          }}
          className={`${inputBaseClass} font-mono tabular-nums`}
        />
      )}

      {field.widget === 'slider' && (
        <div className="flex items-center gap-3 pt-0.5">
          <input
            id={`field-${field.id}`}
            type="range"
            min={field.min ?? 0}
            max={field.max ?? 100}
            step={field.step ?? (field.value_type === 'float' ? 0.1 : 1)}
            value={Number(value ?? field.min ?? 0)}
            onChange={(e) => {
              const parsed =
                field.value_type === 'int'
                  ? parseInt(e.target.value, 10)
                  : parseFloat(e.target.value);
              onChange(Number.isNaN(parsed) ? 0 : parsed);
            }}
            className="flex-1 accent-blue-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg"
          />
          <input
            type="number"
            aria-label={`${field.label} numeric value`}
            min={field.min}
            max={field.max}
            step={field.step ?? (field.value_type === 'float' ? 0.1 : 1)}
            value={Number(value ?? 0)}
            onChange={(e) => {
              const parsed =
                field.value_type === 'int'
                  ? parseInt(e.target.value, 10)
                  : parseFloat(e.target.value);
              onChange(Number.isNaN(parsed) ? 0 : parsed);
            }}
            className="w-20 px-2.5 py-1.5 text-xs font-mono tabular-nums bg-[#0B0D11] border border-zinc-800 rounded-md text-zinc-100 text-right focus:outline-none focus:border-blue-500"
          />
        </div>
      )}

      {field.widget === 'seed_randomizer' && (
        <div className="flex items-center gap-2">
          <input
            id={`field-${field.id}`}
            type="number"
            value={Number(value ?? 0)}
            onChange={(e) => {
              const parsed = parseInt(e.target.value, 10);
              onChange(Number.isNaN(parsed) ? 0 : parsed);
            }}
            className={`${inputBaseClass} font-mono tabular-nums flex-1`}
          />
          <button
            type="button"
            onClick={randomizeSeed}
            title="Randomize seed"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 rounded-md transition-colors shrink-0 cursor-pointer"
          >
            <Dices className="w-3.5 h-3.5" />
            Random
          </button>
          {onToggleSeedLock && (
            <button
              type="button"
              onClick={onToggleSeedLock}
              title={seedLocked ? 'Seed locked across runs' : 'Auto-randomize seed on run'}
              className={`p-2 rounded-md border transition-colors shrink-0 cursor-pointer ${
                seedLocked
                  ? 'border-blue-500/60 bg-blue-600/15 text-blue-400'
                  : 'border-zinc-800 bg-[#0B0D11] text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {seedLocked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      )}

      {field.widget === 'checkbox' && (
        <label className="flex items-center gap-2.5 py-1.5 cursor-pointer select-none">
          <input
            id={`field-${field.id}`}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="w-4 h-4 rounded border-zinc-700 bg-[#0B0D11] text-blue-600 focus:ring-blue-500"
          />
          <span className="text-xs text-zinc-300">{Boolean(value) ? 'Enabled' : 'Disabled'}</span>
        </label>
      )}

      {field.widget === 'select' && (() => {
        const currentStr = String(value ?? '');
        const baseOpts = field.options || [];
        const renderedOpts =
          currentStr !== '' && !baseOpts.includes(currentStr)
            ? [currentStr, ...baseOpts]
            : baseOpts;
        return (
          <select
            id={`field-${field.id}`}
            value={currentStr}
            onChange={(e) => {
              const raw = e.target.value;
              if (field.value_type === 'int') {
                const parsed = parseInt(raw, 10);
                onChange(Number.isNaN(parsed) ? raw : parsed);
              } else if (field.value_type === 'float') {
                const parsed = parseFloat(raw);
                onChange(Number.isNaN(parsed) ? raw : parsed);
              } else {
                onChange(raw);
              }
            }}
            className={`${inputBaseClass} cursor-pointer`}
          >
            {renderedOpts.map((opt) => (
              <option key={opt} value={opt} className="bg-[#12151B] text-zinc-100">
                {opt}
              </option>
            ))}
          </select>
        );
      })()}

      {field.widget === 'image_upload' && (
        <div className="space-y-2">
          {activePreviewUrl ? (
            <div className="relative rounded-md border border-zinc-800 bg-[#0B0D11] overflow-hidden">
              {activeIsVideo ? (
                <video
                  src={activePreviewUrl}
                  controls
                  muted
                  loop
                  preload="metadata"
                  onLoadedMetadata={(e) => {
                    const dur = e.currentTarget.duration;
                    setMeasuredMeta({
                      width: e.currentTarget.videoWidth || null,
                      height: e.currentTarget.videoHeight || null,
                      durationSeconds: Number.isFinite(dur) && dur > 0 ? dur : null,
                    });
                  }}
                  className="w-full h-52 object-contain bg-black"
                />
              ) : (
                <img
                  src={activePreviewUrl}
                  alt={activeFileName || field.label}
                  onLoad={(e) => {
                    setMeasuredMeta({
                      width: e.currentTarget.naturalWidth || null,
                      height: e.currentTarget.naturalHeight || null,
                    });
                  }}
                  className="w-full h-52 object-contain bg-black/40"
                />
              )}
              <div className="flex items-center justify-between px-3 py-2 border-t border-zinc-800 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-zinc-300 min-w-0">
                    {activeIsVideo ? (
                      <Film className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                    ) : (
                      <ImageIcon className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                    )}
                    <span className="truncate">{activeFileName}</span>
                    {!fileValue && reusedMedia && (
                      <span className="text-[11px] font-mono text-blue-400 shrink-0">(reused)</span>
                    )}
                  </div>
                  {mediaMetaParts.length > 0 && (
                    <div className="text-[11px] font-mono text-zinc-400 tabular-nums truncate mt-0.5 pl-5">
                      {mediaMetaParts.join(' · ')}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0 ml-2">
                  <label
                    htmlFor={`field-${field.id}`}
                    className="text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
                  >
                    Replace
                    <input
                      id={`field-${field.id}`}
                      type="file"
                      accept="image/*,video/*"
                      className="sr-only"
                      onChange={(e) => {
                        const selected = e.target.files?.[0] || null;
                        if (selected) onFileChange(selected);
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      if (fileValue) {
                        onFileChange(null);
                      } else {
                        onClearReusedMedia?.();
                      }
                    }}
                    className="inline-flex items-center gap-1 text-zinc-400 hover:text-red-400 transition-colors cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
              {legacyMediaName && (
                <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-md border border-zinc-800 bg-[#0B0D11] text-xs">
                  <span className="text-zinc-300 font-mono truncate">
                    ComfyUI input: {legacyMediaName}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      onClearReusedMedia?.();
                      onChange('');
                    }}
                    className="text-zinc-400 hover:text-red-400 transition-colors shrink-0 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
              <label
                htmlFor={`field-${field.id}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                className={`flex flex-col items-center justify-center gap-2 px-4 py-6 rounded-md border border-dashed transition-colors cursor-pointer ${
                  dragOver
                    ? 'border-blue-500 bg-blue-950/20 text-blue-300'
                    : 'border-zinc-700/80 bg-[#0B0D11] text-zinc-400 hover:border-zinc-600 hover:text-zinc-300'
                }`}
              >
                <Upload className="w-5 h-5" />
                <span className="text-xs font-medium">
                  Drop reference image or video, or click to browse
                </span>
                <span className="text-[11px] text-zinc-500">
                  PNG, JPG, WEBP, MP4, WEBM supported
                </span>
                <input
                  id={`field-${field.id}`}
                  type="file"
                  accept="image/*,video/*"
                  className="sr-only"
                  onChange={(e) => {
                    const selected = e.target.files?.[0] || null;
                    onFileChange(selected);
                  }}
                />
              </label>
            </>
          )}
        </div>
      )}

      {field.description && <p className="text-[11px] text-zinc-500">{field.description}</p>}
    </div>
  );
};

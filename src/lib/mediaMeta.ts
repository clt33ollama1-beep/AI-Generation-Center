export interface MeasuredMediaMeta {
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  fileSize?: number | null;
}

export interface RawMediaMeta {
  width?: number | null;
  height?: number | null;
  duration_seconds?: number | null;
  file_size?: number | null;
  media_type?: 'image' | 'video' | 'text';
  format?: string | null;
}

export function formatDimensions(width?: number | null, height?: number | null): string | null {
  if (
    typeof width === 'number' &&
    typeof height === 'number' &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
  ) {
    return `${Math.round(width)} × ${Math.round(height)}`;
  }
  return null;
}

export function formatVideoDuration(seconds?: number | null): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  if (seconds >= 3600) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  if (seconds >= 60) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    if (secs === 60) {
      return `${mins + 1}:00`;
    }
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }
  let secs = Math.floor(seconds);
  let tenths = Math.round((seconds - secs) * 10);
  if (tenths === 10) {
    secs += 1;
    tenths = 0;
  }
  if (secs >= 60) {
    return '1:00';
  }
  if (secs < 10 && tenths > 0) {
    return `0:0${secs}.${tenths}`;
  }
  return `0:${String(secs).padStart(2, '0')}`;
}

export function formatFileSize(bytes?: number | null): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return null;
  }
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

export function formatTextStats(text?: string | null): string | null {
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }
  const chars = text.length;
  const lines = text.split(/\r\n|\r|\n/).length;
  return lines > 1 ? `${chars.toLocaleString()} chars · ${lines.toLocaleString()} lines` : `${chars.toLocaleString()} chars`;
}

export function resolveMediaMeta(
  stored?: RawMediaMeta | null,
  measured?: MeasuredMediaMeta | null,
): {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  fileSize: number | null;
  dimensionsText: string | null;
  durationText: string | null;
  fileSizeText: string | null;
} {
  const width = stored?.width ?? measured?.width ?? null;
  const height = stored?.height ?? measured?.height ?? null;
  const durationSeconds = stored?.duration_seconds ?? measured?.durationSeconds ?? null;
  const fileSize = stored?.file_size ?? measured?.fileSize ?? null;

  return {
    width,
    height,
    durationSeconds,
    fileSize,
    dimensionsText: formatDimensions(width, height),
    durationText: formatVideoDuration(durationSeconds),
    fileSizeText: formatFileSize(fileSize),
  };
}

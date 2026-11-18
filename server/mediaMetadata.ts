import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface MediaMetadata {
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  file_size: number | null;
}

const metadataCache = new Map<string, MediaMetadata>();

function parsePngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A + 'IHDR'
  if (
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47 ||
    buf.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    return null;
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width > 0 && height > 0) return { width, height };
  return null;
}

function parseJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buf.length && buf[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= buf.length) break;
    const marker = buf[offset];
    offset += 1;

    // Standalone markers without length
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > buf.length) break;
    const segLen = buf.readUInt16BE(offset);
    if (segLen < 2) break;

    // SOF markers containing image dimensions (excluding DHT=C4, JPG=C8, DAC=CC)
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      if (offset + 7 <= buf.length) {
        const height = buf.readUInt16BE(offset + 3);
        const width = buf.readUInt16BE(offset + 5);
        if (width > 0 && height > 0) {
          return { width, height };
        }
      }
      break;
    }
    offset += segLen;
  }
  return null;
}

function parseWebpDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }
  const chunkHeader = buf.toString('ascii', 12, 16);
  if (chunkHeader === 'VP8 ' && buf.length >= 30) {
    if (buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      if (width > 0 && height > 0) return { width, height };
    }
  } else if (chunkHeader === 'VP8L' && buf.length >= 25) {
    if (buf[20] === 0x2f) {
      const b0 = buf[21];
      const b1 = buf[22];
      const b2 = buf[23];
      const b3 = buf[24];
      const bits = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >>> 14) & 0x3fff) + 1;
      if (width > 0 && height > 0) return { width, height };
    }
  } else if (chunkHeader === 'VP8X' && buf.length >= 30) {
    const width = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
    const height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
    if (width > 0 && height > 0) return { width, height };
  }
  return null;
}

function parseGifMetadata(
  buf: Buffer,
): { width: number; height: number; duration_seconds: number | null } | null {
  if (buf.length < 14) return null;
  const header = buf.toString('ascii', 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') return null;

  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  let offset = 13;

  if (packed & 0x80) {
    const gctSize = 3 * (1 << ((packed & 0x07) + 1));
    offset += gctSize;
  }

  let frameCount = 0;
  let totalCs = 0;
  let nextDelayCs = 0;

  while (offset < buf.length) {
    const blockId = buf[offset];
    offset += 1;

    if (blockId === 0x3b) {
      // Trailer
      break;
    } else if (blockId === 0x21) {
      // Extension block
      if (offset >= buf.length) break;
      const label = buf[offset];
      offset += 1;

      if (label === 0xf9 && offset + 5 <= buf.length) {
        const blockSize = buf[offset];
        if (blockSize === 4 && offset + 5 < buf.length) {
          nextDelayCs = buf.readUInt16LE(offset + 2);
        }
        offset += 1 + blockSize;
        while (offset < buf.length && buf[offset] !== 0) {
          offset += 1 + buf[offset];
        }
        offset += 1;
      } else {
        while (offset < buf.length && buf[offset] !== 0) {
          offset += 1 + buf[offset];
        }
        offset += 1;
      }
    } else if (blockId === 0x2c) {
      // Image descriptor
      if (offset + 9 > buf.length) break;
      const imgPacked = buf[offset + 8];
      offset += 9;
      if (imgPacked & 0x80) {
        offset += 3 * (1 << ((imgPacked & 0x07) + 1));
      }
      if (offset >= buf.length) break;
      offset += 1; // LZW minimum code size
      while (offset < buf.length && buf[offset] !== 0) {
        offset += 1 + buf[offset];
      }
      offset += 1;
      frameCount += 1;
      totalCs += nextDelayCs >= 2 ? nextDelayCs : 10;
      nextDelayCs = 0;
    } else {
      break;
    }
  }

  const duration_seconds =
    frameCount > 1 && totalCs > 0 ? Math.round((totalCs / 100) * 100) / 100 : null;
  if (width > 0 && height > 0) {
    return { width, height, duration_seconds };
  }
  return null;
}

function parseBmpDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 26 || buf.toString('ascii', 0, 2) !== 'BM') return null;
  const width = Math.abs(buf.readInt32LE(18));
  const height = Math.abs(buf.readInt32LE(22));
  if (width > 0 && height > 0) return { width, height };
  return null;
}

function parseMp4Metadata(buf: Buffer): {
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
} {
  let width: number | null = null;
  let height: number | null = null;
  let durationSeconds: number | null = null;

  const containerBoxes = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts']);

  function walkBoxes(start: number, end: number) {
    let offset = start;
    while (offset + 8 <= end) {
      let size = buf.readUInt32BE(offset);
      const boxType = buf.toString('ascii', offset + 4, offset + 8);
      let headerSize = 8;

      if (size === 1) {
        if (offset + 16 > end) break;
        const hi = buf.readUInt32BE(offset + 8);
        const lo = buf.readUInt32BE(offset + 12);
        size = hi * 0x100000000 + lo;
        headerSize = 16;
      } else if (size === 0) {
        size = end - offset;
      }

      if (size < headerSize || offset + size > end) break;
      const payloadStart = offset + headerSize;
      const boxEnd = offset + size;

      if (boxType === 'mvhd') {
        if (payloadStart + 20 <= boxEnd) {
          const version = buf[payloadStart];
          if (version === 0 && payloadStart + 20 <= boxEnd) {
            const timescale = buf.readUInt32BE(payloadStart + 12);
            const duration = buf.readUInt32BE(payloadStart + 16);
            if (timescale > 0 && duration > 0) {
              durationSeconds = Math.round((duration / timescale) * 100) / 100;
            }
          } else if (version === 1 && payloadStart + 32 <= boxEnd) {
            const timescale = buf.readUInt32BE(payloadStart + 20);
            const hi = buf.readUInt32BE(payloadStart + 24);
            const lo = buf.readUInt32BE(payloadStart + 28);
            const duration = hi * 0x100000000 + lo;
            if (timescale > 0 && duration > 0) {
              durationSeconds = Math.round((duration / timescale) * 100) / 100;
            }
          }
        }
      } else if (boxType === 'tkhd') {
        const version = buf[payloadStart];
        const minLen = version === 1 ? 96 : 84;
        if (payloadStart + minLen <= boxEnd) {
          const wRaw = buf.readUInt32BE(payloadStart + minLen - 8);
          const hRaw = buf.readUInt32BE(payloadStart + minLen - 4);
          const w = Math.round(wRaw / 65536);
          const h = Math.round(hRaw / 65536);
          if (w > 0 && h > 0 && width === null && height === null) {
            width = w;
            height = h;
          }
        }
      } else if (containerBoxes.has(boxType)) {
        walkBoxes(payloadStart, boxEnd);
      }

      offset = boxEnd;
    }
  }

  walkBoxes(0, buf.length);
  return { width, height, duration_seconds: durationSeconds };
}

function readEbmlVint(buf: Buffer, offset: number): { value: number; length: number } | null {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first === 0) return null;
  let mask = 0x80;
  let length = 1;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > buf.length) return null;
  let value = first & ~mask;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[offset + i];
  }
  return { value, length };
}

function readEbmlId(buf: Buffer, offset: number): { id: number; length: number } | null {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first === 0) return null;
  let mask = 0x80;
  let length = 1;
  while (length <= 4 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 4 || offset + length > buf.length) return null;
  let id = 0;
  for (let i = 0; i < length; i++) {
    id = id * 256 + buf[offset + i];
  }
  return { id, length };
}

function parseMkvWebmMetadata(buf: Buffer): {
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
} {
  let width: number | null = null;
  let height: number | null = null;
  let timecodeScale = 1_000_000;
  let rawDuration: number | null = null;

  if (buf.length < 4 || buf.readUInt32BE(0) !== 0x1a45dfa3) {
    return { width: null, height: null, duration_seconds: null };
  }

  const masterIds = new Set([
    0x18538067, // Segment
    0x1549a966, // Info
    0x1654ae6b, // Tracks
    0xae, // TrackEntry
    0xe0, // Video
  ]);

  function walk(start: number, end: number, depth: number) {
    if (depth > 6) return;
    let offset = start;
    while (offset < end) {
      const idInfo = readEbmlId(buf, offset);
      if (!idInfo) break;
      offset += idInfo.length;

      const sizeInfo = readEbmlVint(buf, offset);
      if (!sizeInfo) break;
      offset += sizeInfo.length;

      // Unknown / unbounded size (all 1s in VINT data bits)
      const dataEnd =
        sizeInfo.value === Math.pow(2, 7 * sizeInfo.length) - 1
          ? end
          : Math.min(end, offset + sizeInfo.value);

      if (masterIds.has(idInfo.id)) {
        walk(offset, dataEnd, depth + 1);
      } else if (idInfo.id === 0x2ad7b1 && dataEnd - offset <= 8) {
        // TimecodeScale
        let val = 0;
        for (let i = offset; i < dataEnd; i++) val = val * 256 + buf[i];
        if (val > 0) timecodeScale = val;
      } else if (idInfo.id === 0x4489) {
        // Duration float (4 or 8 bytes)
        if (dataEnd - offset === 4) {
          rawDuration = buf.readFloatBE(offset);
        } else if (dataEnd - offset === 8) {
          rawDuration = buf.readDoubleBE(offset);
        }
      } else if (idInfo.id === 0xb0 && dataEnd - offset <= 4) {
        // PixelWidth
        let val = 0;
        for (let i = offset; i < dataEnd; i++) val = val * 256 + buf[i];
        if (val > 0) width = val;
      } else if (idInfo.id === 0xba && dataEnd - offset <= 4) {
        // PixelHeight
        let val = 0;
        for (let i = offset; i < dataEnd; i++) val = val * 256 + buf[i];
        if (val > 0) height = val;
      }

      if (dataEnd <= offset) break;
      offset = dataEnd;
    }
  }

  walk(0, Math.min(buf.length, 4 * 1024 * 1024), 0);
  const duration_seconds =
    rawDuration !== null && Number.isFinite(rawDuration) && rawDuration > 0
      ? Math.round(((rawDuration * timecodeScale) / 1e9) * 100) / 100
      : null;
  return { width, height, duration_seconds };
}

function probeWithFfprobe(filePath: string): Partial<MediaMetadata> | null {
  try {
    const out = execFileSync(
      'ffprobe',
      [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const parsed = JSON.parse(out.toString('utf8')) as {
      format?: { duration?: string; size?: string };
      streams?: Array<{
        codec_type?: string;
        width?: number;
        height?: number;
        duration?: string;
      }>;
    };
    const videoStream =
      parsed.streams?.find((s) => s.codec_type === 'video') || parsed.streams?.[0];
    const width =
      typeof videoStream?.width === 'number' && videoStream.width > 0 ? videoStream.width : null;
    const height =
      typeof videoStream?.height === 'number' && videoStream.height > 0 ? videoStream.height : null;
    const rawDur = Number(videoStream?.duration ?? parsed.format?.duration);
    const duration_seconds =
      Number.isFinite(rawDur) && rawDur > 0 ? Math.round(rawDur * 100) / 100 : null;
    return { width, height, duration_seconds };
  } catch {
    return null;
  }
}

export function extractMediaMetadataFromBuffer(
  buf: Buffer,
  filename = '',
  mediaType?: 'image' | 'video',
): MediaMetadata {
  const file_size = buf.length;
  const ext = path.extname(filename).toLowerCase();

  const png = parsePngDimensions(buf);
  if (png) {
    return { ...png, duration_seconds: null, file_size };
  }

  const jpg = parseJpegDimensions(buf);
  if (jpg) {
    return { ...jpg, duration_seconds: null, file_size };
  }

  const webp = parseWebpDimensions(buf);
  if (webp) {
    return { ...webp, duration_seconds: null, file_size };
  }

  const gif = parseGifMetadata(buf);
  if (gif) {
    return {
      width: gif.width,
      height: gif.height,
      duration_seconds: gif.duration_seconds,
      file_size,
    };
  }

  const bmp = parseBmpDimensions(buf);
  if (bmp) {
    return { ...bmp, duration_seconds: null, file_size };
  }

  if (
    mediaType === 'video' ||
    ext === '.mp4' ||
    ext === '.mov' ||
    ext === '.m4v' ||
    buf.toString('ascii', 4, 8) === 'ftyp'
  ) {
    const mp4 = parseMp4Metadata(buf);
    if (mp4.width || mp4.height || mp4.duration_seconds !== null) {
      return {
        width: mp4.width,
        height: mp4.height,
        duration_seconds: mp4.duration_seconds,
        file_size,
      };
    }
  }

  if (
    mediaType === 'video' ||
    ext === '.webm' ||
    ext === '.mkv' ||
    (buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3)
  ) {
    const mkv = parseMkvWebmMetadata(buf);
    if (mkv.width || mkv.height || mkv.duration_seconds !== null) {
      return {
        width: mkv.width,
        height: mkv.height,
        duration_seconds: mkv.duration_seconds,
        file_size,
      };
    }
  }

  return { width: null, height: null, duration_seconds: null, file_size };
}

export function extractMediaMetadataFromFile(
  filePath: string,
  mediaType?: 'image' | 'video',
  cacheKey?: string,
): MediaMetadata {
  const key = cacheKey || filePath;
  const cached = metadataCache.get(key);
  if (cached) return cached;

  let statSize: number | null = null;
  try {
    const stat = fs.statSync(filePath);
    statSize = stat.size;
  } catch {
    return { width: null, height: null, duration_seconds: null, file_size: null };
  }

  let parsed: MediaMetadata = {
    width: null,
    height: null,
    duration_seconds: null,
    file_size: statSize,
  };

  try {
    // For images or moderate files (<= 32MB), read buffer directly; otherwise read first 4MB
    const maxRead = Math.min(statSize, 32 * 1024 * 1024);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.allocUnsafe(maxRead);
      const bytesRead = fs.readSync(fd, buf, 0, maxRead, 0);
      parsed = extractMediaMetadataFromBuffer(buf.subarray(0, bytesRead), filePath, mediaType);
      parsed.file_size = statSize;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // ignore read error
  }

  const needsFfprobe =
    parsed.width === null ||
    parsed.height === null ||
    (mediaType === 'video' && parsed.duration_seconds === null);

  if (needsFfprobe) {
    const ff = probeWithFfprobe(filePath);
    if (ff) {
      parsed = {
        width: parsed.width ?? ff.width ?? null,
        height: parsed.height ?? ff.height ?? null,
        duration_seconds: parsed.duration_seconds ?? ff.duration_seconds ?? null,
        file_size: statSize,
      };
    }
  }

  metadataCache.set(key, parsed);
  return parsed;
}

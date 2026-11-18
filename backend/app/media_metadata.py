from __future__ import annotations

import json
import struct
import subprocess
from pathlib import Path
from typing import Any, Optional

_metadata_cache: dict[str, dict[str, Any]] = {}


def _parse_png(data: bytes) -> Optional[tuple[int, int]]:
    if len(data) < 24:
        return None
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    width, height = struct.unpack(">II", data[16:24])
    if width > 0 and height > 0:
        return int(width), int(height)
    return None


def _parse_jpeg(data: bytes) -> Optional[tuple[int, int]]:
    if len(data) < 4 or data[:2] != b"\xff\xd8":
        return None
    offset = 2
    length = len(data)
    while offset + 4 <= length:
        if data[offset] != 0xFF:
            offset += 1
            continue
        while offset < length and data[offset] == 0xFF:
            offset += 1
        if offset >= length:
            break
        marker = data[offset]
        offset += 1

        if marker in (0xD8, 0xD9, 0x01) or 0xD0 <= marker <= 0xD7:
            continue
        if offset + 2 > length:
            break
        seg_len = struct.unpack(">H", data[offset : offset + 2])[0]
        if seg_len < 2:
            break
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            if offset + 7 <= length:
                height, width = struct.unpack(">HH", data[offset + 3 : offset + 7])
                if width > 0 and height > 0:
                    return int(width), int(height)
            break
        offset += seg_len
    return None


def _parse_webp(data: bytes) -> Optional[tuple[int, int]]:
    if len(data) < 30 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return None
    chunk = data[12:16]
    if chunk == b"VP8 " and len(data) >= 30:
        if data[23:26] == b"\x9d\x01\x2a":
            w, h = struct.unpack("<HH", data[26:30])
            w &= 0x3FFF
            h &= 0x3FFF
            if w > 0 and h > 0:
                return int(w), int(h)
    elif chunk == b"VP8L" and len(data) >= 25:
        if data[20] == 0x2F:
            bits = struct.unpack("<I", data[21:25])[0]
            w = (bits & 0x3FFF) + 1
            h = ((bits >> 14) & 0x3FFF) + 1
            if w > 0 and h > 0:
                return int(w), int(h)
    elif chunk == b"VP8X" and len(data) >= 30:
        w = (data[24] | (data[25] << 8) | (data[26] << 16)) + 1
        h = (data[27] | (data[28] << 8) | (data[29] << 16)) + 1
        if w > 0 and h > 0:
            return int(w), int(h)
    return None


def _parse_gif(data: bytes) -> Optional[tuple[int, int, Optional[float]]]:
    if len(data) < 14 or data[:6] not in (b"GIF87a", b"GIF89a"):
        return None
    width, height = struct.unpack("<HH", data[6:10])
    packed = data[10]
    offset = 13
    if packed & 0x80:
        offset += 3 * (1 << ((packed & 0x07) + 1))

    frame_count = 0
    total_cs = 0
    next_delay_cs = 0
    length = len(data)

    while offset < length:
        block_id = data[offset]
        offset += 1
        if block_id == 0x3B:
            break
        elif block_id == 0x21:
            if offset >= length:
                break
            label = data[offset]
            offset += 1
            if label == 0xF9 and offset + 5 <= length:
                block_size = data[offset]
                if block_size == 4 and offset + 5 < length:
                    next_delay_cs = struct.unpack("<H", data[offset + 2 : offset + 4])[0]
                offset += 1 + block_size
                while offset < length and data[offset] != 0:
                    offset += 1 + data[offset]
                offset += 1
            else:
                while offset < length and data[offset] != 0:
                    offset += 1 + data[offset]
                offset += 1
        elif block_id == 0x2C:
            if offset + 9 > length:
                break
            img_packed = data[offset + 8]
            offset += 9
            if img_packed & 0x80:
                offset += 3 * (1 << ((img_packed & 0x07) + 1))
            if offset >= length:
                break
            offset += 1
            while offset < length and data[offset] != 0:
                offset += 1 + data[offset]
            offset += 1
            frame_count += 1
            total_cs += next_delay_cs if next_delay_cs >= 2 else 10
            next_delay_cs = 0
        else:
            break

    duration = round(total_cs / 100.0, 2) if frame_count > 1 and total_cs > 0 else None
    if width > 0 and height > 0:
        return int(width), int(height), duration
    return None


def _parse_bmp(data: bytes) -> Optional[tuple[int, int]]:
    if len(data) < 26 or data[:2] != b"BM":
        return None
    w, h = struct.unpack("<ii", data[18:26])
    w = abs(w)
    h = abs(h)
    if w > 0 and h > 0:
        return int(w), int(h)
    return None


def _parse_mp4(data: bytes) -> tuple[Optional[int], Optional[int], Optional[float]]:
    width: Optional[int] = None
    height: Optional[int] = None
    duration_seconds: Optional[float] = None
    containers = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"udta", b"edts"}
    length = len(data)

    def walk(start: int, end: int) -> None:
        nonlocal width, height, duration_seconds
        offset = start
        while offset + 8 <= end:
            size = struct.unpack(">I", data[offset : offset + 4])[0]
            box_type = data[offset + 4 : offset + 8]
            header_size = 8
            if size == 1:
                if offset + 16 > end:
                    break
                size = struct.unpack(">Q", data[offset + 8 : offset + 16])[0]
                header_size = 16
            elif size == 0:
                size = end - offset

            if size < header_size or offset + size > end:
                break
            payload_start = offset + header_size
            box_end = offset + size

            if box_type == b"mvhd" and payload_start + 20 <= box_end:
                version = data[payload_start]
                if version == 0 and payload_start + 20 <= box_end:
                    timescale, dur = struct.unpack(">II", data[payload_start + 12 : payload_start + 20])
                    if timescale > 0 and dur > 0:
                        duration_seconds = round(dur / timescale, 2)
                elif version == 1 and payload_start + 32 <= box_end:
                    timescale = struct.unpack(">I", data[payload_start + 20 : payload_start + 24])[0]
                    dur = struct.unpack(">Q", data[payload_start + 24 : payload_start + 32])[0]
                    if timescale > 0 and dur > 0:
                        duration_seconds = round(dur / timescale, 2)
            elif box_type == b"tkhd":
                version = data[payload_start]
                min_len = 96 if version == 1 else 84
                if payload_start + min_len <= box_end:
                    w_raw, h_raw = struct.unpack(
                        ">II", data[payload_start + min_len - 8 : payload_start + min_len]
                    )
                    w = int(round(w_raw / 65536.0))
                    h = int(round(h_raw / 65536.0))
                    if w > 0 and h > 0 and width is None and height is None:
                        width = w
                        height = h
            elif box_type in containers:
                walk(payload_start, box_end)

            offset = box_end

    walk(0, length)
    return width, height, duration_seconds


def _read_ebml_id(data: bytes, offset: int) -> Optional[tuple[int, int]]:
    if offset >= len(data):
        return None
    first = data[offset]
    if first == 0:
        return None
    mask = 0x80
    length = 1
    while length <= 4 and (first & mask) == 0:
        mask >>= 1
        length += 1
    if length > 4 or offset + length > len(data):
        return None
    val = 0
    for i in range(length):
        val = (val << 8) | data[offset + i]
    return val, length


def _read_ebml_vint(data: bytes, offset: int) -> Optional[tuple[int, int]]:
    if offset >= len(data):
        return None
    first = data[offset]
    if first == 0:
        return None
    mask = 0x80
    length = 1
    while length <= 8 and (first & mask) == 0:
        mask >>= 1
        length += 1
    if length > 8 or offset + length > len(data):
        return None
    val = first & ~mask
    for i in range(1, length):
        val = (val << 8) | data[offset + i]
    return val, length


def _parse_mkv_webm(data: bytes) -> tuple[Optional[int], Optional[int], Optional[float]]:
    if len(data) < 4 or data[:4] != b"\x1a\x45\xdf\xa3":
        return None, None, None

    width: Optional[int] = None
    height: Optional[int] = None
    timecode_scale = 1_000_000
    raw_duration: Optional[float] = None
    master_ids = {0x18538067, 0x1549A966, 0x1654AE6B, 0xAE, 0xE0}

    def walk(start: int, end: int, depth: int) -> None:
        nonlocal width, height, timecode_scale, raw_duration
        if depth > 6:
            return
        offset = start
        while offset < end:
            id_res = _read_ebml_id(data, offset)
            if not id_res:
                break
            elem_id, id_len = id_res
            offset += id_len

            size_res = _read_ebml_vint(data, offset)
            if not size_res:
                break
            elem_size, size_len = size_res
            offset += size_len

            if elem_size == ((1 << (7 * size_len)) - 1):
                data_end = end
            else:
                data_end = min(end, offset + elem_size)

            if elem_id in master_ids:
                walk(offset, data_end, depth + 1)
            elif elem_id == 0x2AD7B1 and 0 < data_end - offset <= 8:
                val = int.from_bytes(data[offset:data_end], "big")
                if val > 0:
                    timecode_scale = val
            elif elem_id == 0x4489:
                if data_end - offset == 4:
                    raw_duration = struct.unpack(">f", data[offset:data_end])[0]
                elif data_end - offset == 8:
                    raw_duration = struct.unpack(">d", data[offset:data_end])[0]
            elif elem_id == 0xB0 and 0 < data_end - offset <= 4:
                val = int.from_bytes(data[offset:data_end], "big")
                if val > 0:
                    width = val
            elif elem_id == 0xBA and 0 < data_end - offset <= 4:
                val = int.from_bytes(data[offset:data_end], "big")
                if val > 0:
                    height = val

            if data_end <= offset:
                break
            offset = data_end

    walk(0, min(len(data), 4 * 1024 * 1024), 0)
    duration_seconds = (
        round((raw_duration * timecode_scale) / 1e9, 2)
        if raw_duration is not None and raw_duration > 0
        else None
    )
    return width, height, duration_seconds


def _probe_ffprobe(file_path: Path) -> dict[str, Any]:
    try:
        res = subprocess.run(
            [
                "ffprobe",
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                str(file_path),
            ],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        if res.returncode != 0 or not res.stdout:
            return {}
        parsed = json.loads(res.stdout)
        streams = parsed.get("streams") or []
        video_stream = next(
            (s for s in streams if isinstance(s, dict) and s.get("codec_type") == "video"),
            streams[0] if streams and isinstance(streams[0], dict) else {},
        )
        w = video_stream.get("width")
        h = video_stream.get("height")
        dur_raw = video_stream.get("duration") or (parsed.get("format") or {}).get("duration")
        dur: Optional[float] = None
        if dur_raw is not None:
            try:
                dur_val = float(dur_raw)
                if dur_val > 0:
                    dur = round(dur_val, 2)
            except (TypeError, ValueError):
                dur = None
        return {
            "width": int(w) if isinstance(w, (int, float)) and w > 0 else None,
            "height": int(h) if isinstance(h, (int, float)) and h > 0 else None,
            "duration_seconds": dur,
        }
    except Exception:
        return {}


def extract_media_metadata_from_bytes(
    data: bytes, filename: str = "", media_type: Optional[str] = None
) -> dict[str, Any]:
    file_size = len(data)
    ext = Path(filename).suffix.lower()

    png = _parse_png(data)
    if png:
        return {"width": png[0], "height": png[1], "duration_seconds": None, "file_size": file_size}

    jpg = _parse_jpeg(data)
    if jpg:
        return {"width": jpg[0], "height": jpg[1], "duration_seconds": None, "file_size": file_size}

    webp = _parse_webp(data)
    if webp:
        return {"width": webp[0], "height": webp[1], "duration_seconds": None, "file_size": file_size}

    gif = _parse_gif(data)
    if gif:
        return {"width": gif[0], "height": gif[1], "duration_seconds": gif[2], "file_size": file_size}

    bmp = _parse_bmp(data)
    if bmp:
        return {"width": bmp[0], "height": bmp[1], "duration_seconds": None, "file_size": file_size}

    if media_type == "video" or ext in {".mp4", ".mov", ".m4v"} or data[4:8] == b"ftyp":
        w, h, dur = _parse_mp4(data)
        if w or h or dur is not None:
            return {"width": w, "height": h, "duration_seconds": dur, "file_size": file_size}

    if media_type == "video" or ext in {".webm", ".mkv"} or data[:4] == b"\x1a\x45\xdf\xa3":
        w, h, dur = _parse_mkv_webm(data)
        if w or h or dur is not None:
            return {"width": w, "height": h, "duration_seconds": dur, "file_size": file_size}

    return {"width": None, "height": None, "duration_seconds": None, "file_size": file_size}


def extract_media_metadata_from_file(
    file_path: Path, media_type: Optional[str] = None, cache_key: Optional[str] = None
) -> dict[str, Any]:
    key = cache_key or str(file_path)
    if key in _metadata_cache:
        return _metadata_cache[key]

    if not file_path.exists() or not file_path.is_file():
        return {"width": None, "height": None, "duration_seconds": None, "file_size": None}

    stat_size = file_path.stat().st_size
    with file_path.open("rb") as fh:
        sample = fh.read(min(stat_size, 32 * 1024 * 1024))

    parsed = extract_media_metadata_from_bytes(sample, file_path.name, media_type)
    parsed["file_size"] = stat_size

    if parsed["width"] is None or parsed["height"] is None or (
        media_type == "video" and parsed["duration_seconds"] is None
    ):
        ff = _probe_ffprobe(file_path)
        if ff:
            parsed["width"] = parsed["width"] or ff.get("width")
            parsed["height"] = parsed["height"] or ff.get("height")
            if parsed["duration_seconds"] is None:
                parsed["duration_seconds"] = ff.get("duration_seconds")

    _metadata_cache[key] = parsed
    return parsed

"""Parse Google Takeout exports for Watch Later video IDs.

Google Takeout (https://takeout.google.com/) can export your YouTube data,
including the Watch Later playlist.  The format has changed over the years:

* **Current format** — a directory ``YouTube and YouTube Music/playlists/``
  containing one CSV file per playlist, e.g. ``Watch later videos.csv``.
  Each row (after the header) contains a video ID in the first column.

* **Older HTML format** — an HTML file with ``<a>`` links that include the
  video URL (``https://www.youtube.com/watch?v=VIDEO_ID``).

This module supports both.
"""

import csv
import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)

# Regex that matches the 11-character YouTube video ID in a watch URL
_VIDEO_ID_RE = re.compile(r"(?:v=|youtu\.be/)([A-Za-z0-9_-]{11})")


def parse_takeout_file(path: str | Path) -> list[str]:
    """Extract video IDs from a Google Takeout export file.

    Supports:
    - CSV files (current Takeout format)
    - HTML files (older Takeout format)

    Returns a list of unique video IDs in the order they appear.
    """
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"Takeout file not found: {path}")

    suffix = path.suffix.lower()
    if suffix == ".csv":
        ids = _parse_csv(path)
    elif suffix in {".html", ".htm"}:
        ids = _parse_html(path)
    else:
        # Try CSV first, fall back to generic URL extraction
        logger.warning(
            "Unrecognised file extension '%s'; attempting CSV then URL extraction.", suffix
        )
        try:
            ids = _parse_csv(path)
        except Exception:  # noqa: BLE001
            ids = _parse_generic(path)

    # De-duplicate while preserving order
    seen: set[str] = set()
    unique: list[str] = []
    for vid in ids:
        if vid not in seen:
            seen.add(vid)
            unique.append(vid)

    logger.info("Found %d unique video IDs in '%s'.", len(unique), path.name)
    return unique


# ---------------------------------------------------------------------------
# Format-specific parsers
# ---------------------------------------------------------------------------

def _parse_csv(path: Path) -> list[str]:
    """Parse the current Takeout CSV format.

    The file typically looks like::

        Video ID,Time Added,Description,...
        dQw4w9WgXcQ,2023-01-01T00:00:00+00:00,...
        ...

    Video IDs are in the first column.  Rows that look like a URL are also
    handled (older variant where the column contained the full watch URL).
    """
    ids: list[str] = []

    with path.open(newline="", encoding="utf-8-sig") as fh:
        # Peek at the first few lines to detect the header
        sample = fh.read(4096)
        fh.seek(0)

        # Count header rows to skip (Takeout CSV has some metadata rows before
        # the actual table).  We skip lines until we hit the header that starts
        # with "Video ID" or a recognised variant.
        reader = csv.reader(fh)
        header_found = False
        video_id_col = 0

        for row in reader:
            if not row:
                continue

            # Detect header row
            if not header_found:
                first_cell = row[0].strip().lower()
                if first_cell in {"video id", "videoid", "video_id"}:
                    header_found = True
                    video_id_col = 0
                    continue
                # Some exports use a URL column instead
                if first_cell in {"video url", "url"}:
                    header_found = True
                    video_id_col = 0
                    continue
                # Skip metadata / comment rows (lines that start with '#' or
                # are clearly not data rows)
                if row[0].startswith("#") or len(row[0]) > 50:
                    continue
                # If still not found assume first column is video IDs
                # (handles files without a header)

            value = row[video_id_col].strip() if row else ""
            if not value:
                continue

            # Might be a raw ID or a full URL
            m = _VIDEO_ID_RE.search(value)
            if m:
                ids.append(m.group(1))
            elif re.match(r"^[A-Za-z0-9_-]{11}$", value):
                ids.append(value)
            else:
                logger.debug("Skipping unrecognised CSV value: %r", value)

    return ids


def _parse_html(path: Path) -> list[str]:
    """Parse an older Takeout HTML export for video URLs."""
    ids: list[str] = []
    text = path.read_text(encoding="utf-8", errors="replace")
    for m in _VIDEO_ID_RE.finditer(text):
        ids.append(m.group(1))
    return ids


def _parse_generic(path: Path) -> list[str]:
    """Fallback: scan any text file for YouTube video IDs / URLs."""
    ids: list[str] = []
    text = path.read_text(encoding="utf-8", errors="replace")
    for m in _VIDEO_ID_RE.finditer(text):
        ids.append(m.group(1))
    return ids

"""YouTube Data API v3 operations with pagination, error handling, and rate limiting."""

import json
import logging
import time
from typing import Iterator

from googleapiclient.errors import HttpError

from . import config

logger = logging.getLogger(__name__)

_MAX_PAGE_SIZE = 50


# ---------------------------------------------------------------------------
# Playlist listing
# ---------------------------------------------------------------------------

def list_playlists(service) -> list[dict]:
    """Return all playlists owned by the authenticated user."""
    playlists = []
    page_token = None

    while True:
        request = service.playlists().list(
            part="snippet,contentDetails",
            mine=True,
            maxResults=_MAX_PAGE_SIZE,
            pageToken=page_token,
        )
        response = _execute(request)
        playlists.extend(response.get("items", []))
        page_token = response.get("nextPageToken")
        if not page_token:
            break

    return playlists


# ---------------------------------------------------------------------------
# Playlist creation
# ---------------------------------------------------------------------------

def create_playlist(service, title: str, description: str = "", private: bool = True) -> dict:
    """Create a new playlist and return the API resource."""
    privacy = "private" if private else "public"
    request = service.playlists().insert(
        part="snippet,status",
        body={
            "snippet": {"title": title, "description": description},
            "status": {"privacyStatus": privacy},
        },
    )
    result = _execute(request)
    logger.info("Created playlist '%s' (id=%s)", title, result["id"])
    return result


# ---------------------------------------------------------------------------
# Reading playlist items
# ---------------------------------------------------------------------------

def get_playlist_video_ids(service, playlist_id: str) -> list[str]:
    """Return all video IDs in a playlist (handles pagination automatically).

    .. note::
        The YouTube Data API **cannot** read the Watch Later playlist (``WL``).
        If you pass ``playlist_id="WL"`` the API will always return 0 results.
        Use Google Takeout to export Watch Later videos instead.
    """
    if playlist_id == "WL":
        logger.warning(
            "The Watch Later playlist (WL) cannot be read via the YouTube Data API — "
            "Google deprecated this access. Use 'transfer-takeout' with a Google Takeout "
            "export instead."
        )
        return []

    video_ids: list[str] = []
    page_token = None

    while True:
        request = service.playlistItems().list(
            part="contentDetails",
            playlistId=playlist_id,
            maxResults=_MAX_PAGE_SIZE,
            pageToken=page_token,
        )
        try:
            response = _execute(request)
        except HttpError as exc:
            if exc.resp.status == 404:
                logger.error("Playlist '%s' not found.", playlist_id)
                return []
            raise

        for item in response.get("items", []):
            vid = item.get("contentDetails", {}).get("videoId")
            if vid:
                video_ids.append(vid)

        page_token = response.get("nextPageToken")
        if not page_token:
            break

    return video_ids


# ---------------------------------------------------------------------------
# Adding videos to a playlist
# ---------------------------------------------------------------------------

def add_video_to_playlist(
    service,
    playlist_id: str,
    video_id: str,
    position: int | None = None,
) -> dict | None:
    """Add a single video to a playlist.

    Returns the created playlistItem resource, or None if the video was skipped
    (duplicate, not found, or unavailable).
    """
    body: dict = {
        "snippet": {
            "playlistId": playlist_id,
            "resourceId": {
                "kind": "youtube#video",
                "videoId": video_id,
            },
        }
    }
    if position is not None:
        body["snippet"]["position"] = position

    try:
        result = _execute(service.playlistItems().insert(part="snippet", body=body))
        logger.debug("Added video %s to playlist %s.", video_id, playlist_id)
        return result
    except HttpError as exc:
        status = exc.resp.status
        reason = _parse_reason(exc)

        if status == 403:
            if reason == "playlistContainsDuplicates" or "duplicate" in reason.lower():
                logger.info("Skipped duplicate video: %s", video_id)
            elif reason == "quotaExceeded":
                logger.error(
                    "YouTube API quota exceeded. Wait until midnight Pacific Time "
                    "for quota to reset, then retry."
                )
                raise
            else:
                logger.warning("Skipped video %s (403 %s).", video_id, reason)
        elif status == 404:
            logger.info("Skipped video %s — not found or unavailable.", video_id)
        else:
            logger.warning("Skipped video %s (HTTP %d: %s).", video_id, status, reason)

        return None


def add_videos_to_playlist(
    service,
    playlist_id: str,
    video_ids: list[str],
    delay: float = config.API_CALL_DELAY,
) -> tuple[int, int]:
    """Add multiple videos to a playlist with rate limiting.

    Returns ``(added, skipped)`` counts.
    """
    added = 0
    skipped = 0

    for video_id in video_ids:
        result = add_video_to_playlist(service, playlist_id, video_id)
        if result is not None:
            added += 1
        else:
            skipped += 1
        if delay > 0:
            time.sleep(delay)

    return added, skipped


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _execute(request, retries: int = 3):
    """Execute an API request with simple exponential-backoff retry on 5xx errors."""
    for attempt in range(retries):
        try:
            return request.execute()
        except HttpError as exc:
            if exc.resp.status >= 500 and attempt < retries - 1:
                wait = 2 ** attempt
                logger.warning(
                    "Server error %d; retrying in %ds (attempt %d/%d)…",
                    exc.resp.status,
                    wait,
                    attempt + 1,
                    retries,
                )
                time.sleep(wait)
                continue
            raise


def _parse_reason(exc: HttpError) -> str:
    """Extract the first error reason string from an HttpError."""
    try:
        content = json.loads(exc.content)
        return content["error"]["errors"][0].get("reason", "unknown")
    except Exception:  # noqa: BLE001
        return "unknown"

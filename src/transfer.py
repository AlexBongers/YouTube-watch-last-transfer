"""Transfer orchestration — ties together the parser and the API."""

import logging
import time

from tqdm import tqdm

from . import youtube_api, takeout_parser

logger = logging.getLogger(__name__)


def transfer_from_takeout(
    service,
    takeout_file: str,
    target_playlist_id: str,
    delay: float | None = None,
) -> tuple[int, int]:
    """Transfer videos from a Google Takeout export to a YouTube playlist.

    Parameters
    ----------
    service:
        Authenticated YouTube API service object.
    takeout_file:
        Path to the Google Takeout CSV or HTML export file.
    target_playlist_id:
        ID of the destination playlist.
    delay:
        Seconds to wait between API calls (uses config default if None).

    Returns
    -------
    (added, skipped): counts of successfully added and skipped videos.
    """
    from . import config

    if delay is None:
        delay = config.API_CALL_DELAY

    logger.info("Parsing Takeout file: %s", takeout_file)
    video_ids = takeout_parser.parse_takeout_file(takeout_file)

    if not video_ids:
        logger.warning("No video IDs found in the Takeout file.")
        return 0, 0

    logger.info(
        "Found %d video(s) in Takeout file. Adding to playlist %s…",
        len(video_ids),
        target_playlist_id,
    )

    added = 0
    skipped = 0

    for video_id in tqdm(video_ids, desc="Transferring", unit="video"):
        result = youtube_api.add_video_to_playlist(service, target_playlist_id, video_id)
        if result is not None:
            added += 1
        else:
            skipped += 1

        if delay > 0:
            time.sleep(delay)

    logger.info("Done. Added: %d, Skipped: %d.", added, skipped)
    return added, skipped


def transfer_between_playlists(
    service,
    source_playlist_id: str,
    target_playlist_id: str,
    delay: float | None = None,
) -> tuple[int, int]:
    """Transfer all videos from one regular playlist to another.

    .. warning::
        This does **not** work for the Watch Later playlist (``WL``).
        The YouTube Data API cannot read Watch Later videos.  Use
        :func:`transfer_from_takeout` instead.

    Parameters
    ----------
    service:
        Authenticated YouTube API service object.
    source_playlist_id:
        ID of the source playlist (must be API-readable; not ``WL``).
    target_playlist_id:
        ID of the destination playlist.
    delay:
        Seconds to wait between API calls.

    Returns
    -------
    (added, skipped): counts of successfully added and skipped videos.
    """
    from . import config

    if delay is None:
        delay = config.API_CALL_DELAY

    if source_playlist_id == "WL":
        raise ValueError(
            "The Watch Later playlist ('WL') cannot be read via the YouTube Data API. "
            "Export your Watch Later playlist via Google Takeout and use "
            "'transfer-takeout' instead."
        )

    logger.info("Reading source playlist %s…", source_playlist_id)
    video_ids = youtube_api.get_playlist_video_ids(service, source_playlist_id)

    if not video_ids:
        logger.warning("Source playlist '%s' contains no videos.", source_playlist_id)
        return 0, 0

    logger.info(
        "Found %d video(s). Adding to playlist %s…",
        len(video_ids),
        target_playlist_id,
    )

    added = 0
    skipped = 0

    for video_id in tqdm(video_ids, desc="Transferring", unit="video"):
        result = youtube_api.add_video_to_playlist(service, target_playlist_id, video_id)
        if result is not None:
            added += 1
        else:
            skipped += 1

        if delay > 0:
            time.sleep(delay)

    logger.info("Done. Added: %d, Skipped: %d.", added, skipped)
    return added, skipped

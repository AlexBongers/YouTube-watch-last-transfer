"""Tests for the transfer orchestration layer.

The YouTube API service is mocked throughout so no real credentials are needed.
"""

import time
from unittest.mock import MagicMock, patch, call
from pathlib import Path
import csv

import pytest

from src import transfer


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_service():
    """Return a minimal mock YouTube service."""
    return MagicMock()


def _playlist_insert_response(video_id: str) -> dict:
    return {
        "kind": "youtube#playlistItem",
        "id": f"fake-item-{video_id}",
        "snippet": {
            "playlistId": "TARGET123",
            "resourceId": {"kind": "youtube#video", "videoId": video_id},
        },
    }


def write_csv(tmp_path: Path, rows: list[list[str]]) -> Path:
    p = tmp_path / "takeout.csv"
    with p.open("w", newline="", encoding="utf-8") as fh:
        csv.writer(fh).writerows(rows)
    return p


# ---------------------------------------------------------------------------
# transfer_from_takeout
# ---------------------------------------------------------------------------

class TestTransferFromTakeout:
    def test_adds_all_videos(self, tmp_path):
        p = write_csv(tmp_path, [
            ["Video ID", "Time Added"],
            ["dQw4w9WgXcQ", "2023-01-01"],
            ["9bZkp7q19f0", "2023-01-02"],
        ])
        service = _make_service()

        with patch("src.youtube_api.add_video_to_playlist") as mock_add:
            mock_add.side_effect = [
                _playlist_insert_response("dQw4w9WgXcQ"),
                _playlist_insert_response("9bZkp7q19f0"),
            ]
            added, skipped = transfer.transfer_from_takeout(
                service, str(p), "TARGET123", delay=0
            )

        assert added == 2
        assert skipped == 0

    def test_counts_skipped_on_none(self, tmp_path):
        p = write_csv(tmp_path, [
            ["Video ID", "Time Added"],
            ["dQw4w9WgXcQ", "2023-01-01"],
            ["9bZkp7q19f0", "2023-01-02"],
        ])
        service = _make_service()

        with patch("src.youtube_api.add_video_to_playlist") as mock_add:
            # First video skipped (duplicate), second added
            mock_add.side_effect = [None, _playlist_insert_response("9bZkp7q19f0")]
            added, skipped = transfer.transfer_from_takeout(
                service, str(p), "TARGET123", delay=0
            )

        assert added == 1
        assert skipped == 1

    def test_empty_takeout_returns_zero(self, tmp_path):
        p = write_csv(tmp_path, [["Video ID", "Time Added"]])
        service = _make_service()

        added, skipped = transfer.transfer_from_takeout(
            service, str(p), "TARGET123", delay=0
        )
        assert added == 0
        assert skipped == 0

    def test_file_not_found_raises(self, tmp_path):
        service = _make_service()
        with pytest.raises(FileNotFoundError):
            transfer.transfer_from_takeout(
                service, str(tmp_path / "missing.csv"), "TARGET123", delay=0
            )


# ---------------------------------------------------------------------------
# transfer_between_playlists
# ---------------------------------------------------------------------------

class TestTransferBetweenPlaylists:
    def test_raises_for_wl(self):
        service = _make_service()
        with pytest.raises(ValueError, match="Watch Later"):
            transfer.transfer_between_playlists(service, "WL", "TARGET123", delay=0)

    def test_transfers_videos(self):
        service = _make_service()

        with (
            patch("src.youtube_api.get_playlist_video_ids") as mock_get,
            patch("src.youtube_api.add_video_to_playlist") as mock_add,
        ):
            mock_get.return_value = ["vid1", "vid2", "vid3"]
            mock_add.side_effect = [
                _playlist_insert_response("vid1"),
                _playlist_insert_response("vid2"),
                None,  # vid3 skipped
            ]
            added, skipped = transfer.transfer_between_playlists(
                service, "SOURCE123", "TARGET123", delay=0
            )

        assert added == 2
        assert skipped == 1

    def test_empty_source_returns_zero(self):
        service = _make_service()

        with patch("src.youtube_api.get_playlist_video_ids") as mock_get:
            mock_get.return_value = []
            added, skipped = transfer.transfer_between_playlists(
                service, "SOURCE123", "TARGET123", delay=0
            )

        assert added == 0
        assert skipped == 0

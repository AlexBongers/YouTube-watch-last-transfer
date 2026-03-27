"""Tests for the Google Takeout parser."""

import csv
import textwrap
from pathlib import Path

import pytest

from src.takeout_parser import parse_takeout_file


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def write_csv(tmp_path: Path, rows: list[list[str]], filename: str = "takeout.csv") -> Path:
    p = tmp_path / filename
    with p.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerows(rows)
    return p


def write_text(tmp_path: Path, content: str, filename: str) -> Path:
    p = tmp_path / filename
    p.write_text(content, encoding="utf-8")
    return p


# ---------------------------------------------------------------------------
# CSV tests
# ---------------------------------------------------------------------------

class TestParseCsv:
    def test_standard_header_and_ids(self, tmp_path):
        p = write_csv(tmp_path, [
            ["Video ID", "Time Added"],
            ["dQw4w9WgXcQ", "2023-01-01T00:00:00+00:00"],
            ["9bZkp7q19f0", "2023-02-01T00:00:00+00:00"],
        ])
        ids = parse_takeout_file(p)
        assert ids == ["dQw4w9WgXcQ", "9bZkp7q19f0"]

    def test_deduplication(self, tmp_path):
        p = write_csv(tmp_path, [
            ["Video ID", "Time Added"],
            ["dQw4w9WgXcQ", "2023-01-01"],
            ["dQw4w9WgXcQ", "2023-01-02"],
            ["9bZkp7q19f0", "2023-02-01"],
        ])
        ids = parse_takeout_file(p)
        assert ids == ["dQw4w9WgXcQ", "9bZkp7q19f0"]

    def test_url_values_extracted(self, tmp_path):
        p = write_csv(tmp_path, [
            ["Video ID", "Time Added"],
            ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "2023-01-01"],
        ])
        ids = parse_takeout_file(p)
        assert ids == ["dQw4w9WgXcQ"]

    def test_empty_rows_skipped(self, tmp_path):
        p = write_csv(tmp_path, [
            ["Video ID", "Time Added"],
            ["", ""],
            ["dQw4w9WgXcQ", "2023-01-01"],
        ])
        ids = parse_takeout_file(p)
        assert ids == ["dQw4w9WgXcQ"]

    def test_bom_header(self, tmp_path):
        # Takeout sometimes includes a UTF-8 BOM
        p = tmp_path / "takeout.csv"
        p.write_bytes(
            "\ufeffVideo ID,Time Added\ndQw4w9WgXcQ,2023-01-01\n".encode("utf-8-sig")
        )
        ids = parse_takeout_file(p)
        assert ids == ["dQw4w9WgXcQ"]

    def test_no_header_plain_ids(self, tmp_path):
        # Some exports have no header — just IDs
        p = write_csv(tmp_path, [
            ["dQw4w9WgXcQ"],
            ["9bZkp7q19f0"],
        ])
        ids = parse_takeout_file(p)
        assert "dQw4w9WgXcQ" in ids
        assert "9bZkp7q19f0" in ids


# ---------------------------------------------------------------------------
# HTML tests
# ---------------------------------------------------------------------------

class TestParseHtml:
    def test_links_extracted(self, tmp_path):
        html = textwrap.dedent("""\
            <html><body>
            <a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">Rick</a>
            <a href="https://www.youtube.com/watch?v=9bZkp7q19f0">Gangnam</a>
            </body></html>
        """)
        p = write_text(tmp_path, html, "watch_later.html")
        ids = parse_takeout_file(p)
        assert ids == ["dQw4w9WgXcQ", "9bZkp7q19f0"]

    def test_deduplication_html(self, tmp_path):
        html = (
            '<a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">1</a>'
            '<a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">2</a>'
        )
        p = write_text(tmp_path, html, "takeout.html")
        ids = parse_takeout_file(p)
        assert ids == ["dQw4w9WgXcQ"]

    def test_youtu_be_links(self, tmp_path):
        html = '<a href="https://youtu.be/dQw4w9WgXcQ">short link</a>'
        p = write_text(tmp_path, html, "takeout.html")
        ids = parse_takeout_file(p)
        assert ids == ["dQw4w9WgXcQ"]


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------

class TestErrors:
    def test_file_not_found(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            parse_takeout_file(tmp_path / "nonexistent.csv")

    def test_empty_csv_returns_empty(self, tmp_path):
        p = write_csv(tmp_path, [["Video ID", "Time Added"]])
        ids = parse_takeout_file(p)
        assert ids == []

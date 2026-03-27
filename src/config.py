"""Configuration management — reads .env and environment variables."""

import os
import logging
from pathlib import Path

from dotenv import load_dotenv

# Load .env from the project root (two levels up from this file)
_ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=_ENV_PATH, override=False)


def _get(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


CLIENT_SECRETS_FILE: str = _get("CLIENT_SECRETS_FILE", "client_secrets.json")
TOKEN_FILE: str = _get("TOKEN_FILE", "token.json")
DEFAULT_TARGET_PLAYLIST_ID: str = _get("DEFAULT_TARGET_PLAYLIST_ID", "")
API_CALL_DELAY: float = float(_get("API_CALL_DELAY", "0.5"))
LOG_LEVEL: str = _get("LOG_LEVEL", "INFO").upper()

# YouTube OAuth scopes
SCOPES = [
    "https://www.googleapis.com/auth/youtube.force-ssl",
]


def configure_logging(level: str = LOG_LEVEL) -> None:
    """Set up root-logger with a human-friendly format."""
    numeric = getattr(logging, level, logging.INFO)
    logging.basicConfig(
        level=numeric,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

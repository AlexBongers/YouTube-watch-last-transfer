"""OAuth 2.0 authentication helpers using google-auth-oauthlib."""

import json
import logging
import os
from pathlib import Path

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

from . import config

logger = logging.getLogger(__name__)

_API_SERVICE_NAME = "youtube"
_API_VERSION = "v3"


def _load_cached_token(token_file: str) -> Credentials | None:
    """Load a previously saved token from disk, or return None."""
    path = Path(token_file)
    if path.is_file():
        try:
            creds = Credentials.from_authorized_user_file(str(path), config.SCOPES)
            logger.debug("Loaded cached token from %s", path)
            return creds
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not load cached token (%s); will re-authenticate.", exc)
    return None


def _save_token(creds: Credentials, token_file: str) -> None:
    """Persist credentials to *token_file* so we don't have to re-auth every run."""
    path = Path(token_file)
    path.write_text(creds.to_json())
    logger.debug("Token saved to %s", path)


def get_credentials(
    client_secrets_file: str = config.CLIENT_SECRETS_FILE,
    token_file: str = config.TOKEN_FILE,
) -> Credentials:
    """Return valid OAuth 2.0 credentials, refreshing or re-authenticating as needed."""
    creds = _load_cached_token(token_file)

    if creds and creds.valid:
        return creds

    if creds and creds.expired and creds.refresh_token:
        logger.info("Refreshing expired access token…")
        creds.refresh(Request())
        _save_token(creds, token_file)
        return creds

    # Full OAuth flow
    secrets_path = Path(client_secrets_file)
    if not secrets_path.is_file():
        raise FileNotFoundError(
            f"OAuth client secrets file not found: {secrets_path}\n"
            "Download it from Google Cloud Console → APIs & Services → Credentials."
        )

    logger.info("Starting OAuth 2.0 flow — a browser window will open.")
    flow = InstalledAppFlow.from_client_secrets_file(str(secrets_path), config.SCOPES)
    creds = flow.run_local_server(port=0)
    _save_token(creds, token_file)
    return creds


def get_youtube_service(
    client_secrets_file: str = config.CLIENT_SECRETS_FILE,
    token_file: str = config.TOKEN_FILE,
):
    """Return an authenticated YouTube Data API v3 service object."""
    creds = get_credentials(client_secrets_file, token_file)
    service = build(_API_SERVICE_NAME, _API_VERSION, credentials=creds)
    logger.debug("YouTube API service created.")
    return service

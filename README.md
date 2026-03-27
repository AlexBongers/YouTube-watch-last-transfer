# YouTube Watch Later Transfer

A Python command-line tool to transfer your YouTube **Watch Later** (Dutch: *Later Bekijken*) playlist — and any other playlist — to a different playlist.

---

## ⚠️ The Watch Later API Limitation

The YouTube Data API **cannot read the Watch Later playlist**.  
Google deprecated API access to the `WL` playlist around 2016. Even with full OAuth scopes, the API always returns **0 items** for Watch Later — this is a hard server-side restriction imposed by Google, not a bug in the code.

**The fix:** export your Watch Later playlist via **Google Takeout** and use this tool's `transfer-takeout` command to import the videos into a target playlist.

---

## Features

- **`transfer-takeout`** — Parse a Google Takeout CSV/HTML export and add videos to a target playlist (the primary method for Watch Later)
- **`transfer-playlist`** — Transfer videos between two regular API-accessible playlists
- **`list-playlists`** — List your playlists and their IDs
- **`create-playlist`** — Create a new empty playlist
- Handles API pagination, quota limits, duplicate videos, and rate limiting
- Progress bar while transferring
- Configurable via `.env` file

---

## Setup

### 1. Python 3.8+

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 2. Google Cloud Project & OAuth Credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or select an existing one).
3. Enable the **YouTube Data API v3**:
   - *APIs & Services → Library → search "YouTube Data API v3" → Enable*
4. Create OAuth 2.0 credentials:
   - *APIs & Services → Credentials → Create Credentials → OAuth client ID*
   - Application type: **Desktop app**
   - Download the JSON file and save it as `client_secrets.json` in the project root.
5. Add your Google account as a test user:
   - *APIs & Services → OAuth consent screen → Test users → Add Users*

### 3. Configuration (optional)

Copy `.env.example` to `.env` and edit as needed:

```bash
cp .env.example .env
```

Key settings:

| Variable | Default | Description |
|---|---|---|
| `CLIENT_SECRETS_FILE` | `client_secrets.json` | Path to OAuth credentials |
| `TOKEN_FILE` | `token.json` | Where the access token is cached |
| `API_CALL_DELAY` | `0.5` | Seconds between API calls |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, or `ERROR` |

---

## Usage

All commands follow the pattern:

```
python -m src.main [--secrets FILE] [--token FILE] [--log-level LEVEL] COMMAND [args]
```

### Export your Watch Later playlist via Google Takeout

1. Go to <https://takeout.google.com/>.
2. Click **Deselect all**, then scroll down and check **YouTube and YouTube Music**.
3. Click **All YouTube data included**, then click **Deselect all** in that dialog.
4. Check **playlists** only, then confirm.
5. Choose your export format (CSV is recommended) and download.
6. Extract the archive and find the CSV file at:
   ```
   Takeout/YouTube and YouTube Music/playlists/Watch later videos.csv
   ```

### Transfer Watch Later to a new playlist

```bash
# Step 1 — create a destination playlist
python -m src.main create-playlist "My Watch Later Backup"
# Note the playlist ID printed, e.g. PLxxxxxxxxxxxxxxxxxxxxxxxx

# Step 2 — transfer from Takeout export
python -m src.main transfer-takeout \
    "Takeout/YouTube and YouTube Music/playlists/Watch later videos.csv" \
    PLxxxxxxxxxxxxxxxxxxxxxxxx
```

### Transfer between regular playlists

```bash
python -m src.main transfer-playlist SOURCE_PLAYLIST_ID TARGET_PLAYLIST_ID
```

### List your playlists

```bash
python -m src.main list-playlists
```

### Create a new playlist

```bash
python -m src.main create-playlist "My New Playlist" --description "Created by yt-transfer" --public
```

---

## API Quota

The YouTube Data API has a default quota of **10,000 units per day**.  
Each `playlistItems.insert` call costs **50 units**, so you can add ~200 videos per day on the free tier.

If you hit the quota limit you will see a `quotaExceeded` error. Wait until midnight Pacific Time for the quota to reset.

Tip: increase `API_CALL_DELAY` in `.env` to slow down the transfer and reduce the risk of quota issues.

---

## Project Structure

```
YouTube-watch-last-transfer/
├── README.md
├── requirements.txt
├── .gitignore
├── .env.example
├── src/
│   ├── __init__.py
│   ├── main.py            # CLI entry point
│   ├── auth.py            # OAuth 2.0 authentication
│   ├── youtube_api.py     # YouTube Data API operations
│   ├── takeout_parser.py  # Google Takeout CSV/HTML parser
│   ├── transfer.py        # Transfer orchestration
│   └── config.py          # Configuration management
└── tests/
    ├── __init__.py
    ├── test_takeout_parser.py
    └── test_transfer.py
```

---

## Running Tests

```bash
pip install -r requirements.txt
pytest tests/ -v
```

---

## License

MIT
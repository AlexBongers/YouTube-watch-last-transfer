# YouTube Watch Later Transfer

A command-line tool that transfers all videos from the **Watch Later** playlist of one YouTube account to another.

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- A [Google Cloud project](https://console.cloud.google.com/) with the **YouTube Data API v3** enabled
- An OAuth 2.0 **Web application** client ID and client secret

## Setup

### 1. Create Google OAuth2 credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. Enable the **YouTube Data API v3** (APIs & Services → Library).
4. Go to APIs & Services → Credentials → **Create Credentials** → **OAuth client ID**.
5. Choose **Web application** as the application type.
6. Add `http://localhost:3000/oauth2callback` to **Authorized redirect URIs**.
7. Copy the generated **Client ID** and **Client Secret**.

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in your credentials:

```
GOOGLE_CLIENT_ID=your_client_id_here
GOOGLE_CLIENT_SECRET=your_client_secret_here
```

### 3. Install dependencies

```bash
npm install
```

## Usage

```bash
npm start
```

The tool will guide you through two browser-based sign-in steps:

1. **Source account** – Sign in with the YouTube account whose Watch Later playlist you want to copy.
2. **Destination account** – Sign in with the YouTube account where the videos should be added.

After both authentications, the tool fetches the source Watch Later playlist and adds each video to the destination account's Watch Later playlist, printing progress as it goes.

### Example output

```
=== YouTube Watch Later Transfer ===

Step 1: Sign in to your SOURCE account ...
  Opening browser for source account authentication...
Source account authenticated.

Fetching Watch Later playlist from source account... 42 video(s) found.

Step 2: Sign in to your DESTINATION account ...
  Opening browser for destination account authentication...
Destination account authenticated.

Adding 42 video(s) to destination Watch Later playlist...

  [1/42] ✓ My Favourite Video
  [2/42] ✓ Another Great Video
  ...

=== Transfer Complete ===
  Successfully added : 42
```

## Notes

- The YouTube Data API has a daily quota limit. Transfers of very large playlists (hundreds of videos) may require spreading the transfer across multiple days.
- Videos that are private, deleted, or region-restricted on the destination account will show a `✗` status and are listed in the summary at the end.
- The tool inserts a short delay between requests to reduce the risk of hitting quota limits.

## Development

Run the test suite:

```bash
npm test
```

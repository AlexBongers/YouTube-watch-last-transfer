# YouTube Watch Later Transfer

A web application that transfers all videos from the **Watch Later** playlist of one YouTube account to another. Deploy to [Render.com](https://render.com) in minutes, or run locally.

![App screenshot](https://github.com/user-attachments/assets/0f10a762-bac2-426e-ac74-cb58f4311ab5)

## How it works

1. **Step 1** — Click **Connect Source Account** and sign in with the YouTube account you want to copy *from*.
2. **Step 2** — Click **Connect Destination Account** and sign in with the YouTube account you want to copy *to*.
3. **Step 3** — Click **▶ Start Transfer**. The app fetches your Watch Later playlist and adds each video to the destination account, showing live progress.

## Prerequisites

- A [Google Cloud project](https://console.cloud.google.com/) with the **YouTube Data API v3** enabled
- An OAuth 2.0 **Web application** client ID and client secret

### Create Google OAuth2 credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. Enable the **YouTube Data API v3** (APIs & Services → Library).
4. Go to APIs & Services → Credentials → **Create Credentials** → **OAuth client ID**.
5. Choose **Web application** as the application type.
6. Add your redirect URI to **Authorized redirect URIs** (see below for the correct value).
7. Copy the generated **Client ID** and **Client Secret**.

---

## Deploy to Render.com

> **Easiest option** — no local Node.js required.

1. Fork this repository.
2. Go to [render.com](https://render.com), create a free account, and click **New → Blueprint**.
3. Connect your forked repository. Render will detect `render.yaml` automatically.
4. Set the following environment variables in the Render dashboard:

   | Variable | Value |
   |---|---|
   | `GOOGLE_CLIENT_ID` | Your Google OAuth2 client ID |
   | `GOOGLE_CLIENT_SECRET` | Your Google OAuth2 client secret |
   | `APP_URL` | `https://<your-service-name>.onrender.com` *(no trailing slash)* |

   `SESSION_SECRET` is generated automatically by Render.

5. In Google Cloud Console → Credentials → your OAuth client, add this **Authorized redirect URI**:
   ```
   https://<your-service-name>.onrender.com/oauth2callback
   ```
6. Click **Apply** — Render will build and deploy the app. Visit the URL shown in the dashboard.

---

## Run locally

### 1. Install dependencies

Requires [Node.js](https://nodejs.org/) 18 or later.

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```
GOOGLE_CLIENT_ID=your_client_id_here
GOOGLE_CLIENT_SECRET=your_client_secret_here
APP_URL=http://localhost:3000
SESSION_SECRET=any-long-random-string
```

In Google Cloud Console → Credentials → your OAuth client, add:
```
http://localhost:3000/oauth2callback
```
as an **Authorized redirect URI**.

### 3. Start the server

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Notes

- **Quota**: The YouTube Data API has a daily quota limit. Transfers of very large playlists (hundreds of videos) may need to be spread across multiple days.
- **Private/deleted videos**: Videos that are private, deleted, or region-restricted will show a `✗` status in the progress log and are listed in the summary.
- **Session storage**: Session state (connected accounts, transfer progress) is stored in memory. Restarting the server will require you to reconnect your accounts.

## Development

Run the test suite:

```bash
npm test
```

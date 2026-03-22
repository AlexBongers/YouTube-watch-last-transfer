# YouTube Watch Later Transfer

A web application that transfers all videos from the **Watch Later** playlist of one YouTube account to another. Deploy to [Render.com](https://render.com) in minutes — no command line needed.

## How it works

1. **Step 1** — Click **Connect Source Account** and sign in with the YouTube account you want to copy *from*.
2. **Step 2** — Click **Connect Destination Account** and sign in with the YouTube account you want to copy *to*.
3. **Step 3** — Click **▶ Start Transfer**. The app fetches your Watch Later playlist and adds each video to the destination account, showing live progress.

---

## Deploy to Render.com (easiest)

> No local Node.js or command line required.

1. **Fork** this repository on GitHub.
2. Go to [render.com](https://render.com), create a free account, and click **New → Blueprint**.
3. Connect your forked repository. Render will detect `render.yaml` automatically and deploy the app.
4. Once deployed, open the app URL — it will redirect you to the **First-time Setup** wizard automatically.

### First-time Setup wizard

When you open the app for the first time (or before credentials are configured), you will see a step-by-step guided setup:

![Setup wizard — steps 1–3](https://github.com/user-attachments/assets/4d2e13f7-e354-43b0-bc74-c7d916c63dca)

![Setup wizard — step 4–5, credential form](https://github.com/user-attachments/assets/1b5b2f9b-c44b-49d0-9f4f-f05307fc4f5b)

The wizard walks you through:

1. **Create a Google Cloud project** — free, takes ~1 minute.
2. **Enable the YouTube Data API v3** — one click in the API Library.
3. **Configure the OAuth consent screen** — choose External, add both YouTube account emails as test users.
4. **Create OAuth credentials** — choose *Web application*, and paste the **redirect URI** shown on the page (it is auto-detected and includes a Copy button).
5. **Enter your Client ID and Client Secret** — paste them into the form and click **Save & Continue**.

After completing setup you are taken straight to the transfer page.

> **Persistence on Render.com free tier**: Credentials entered through the setup wizard are saved to the server's filesystem for the current session. They may be lost if Render restarts the container. To make them permanent, copy the values into **Render dashboard → your service → Environment → Add environment variable** as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

---

## Run locally

Requires [Node.js](https://nodejs.org/) 18 or later.

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) — the setup wizard will guide you through the rest.

Alternatively, copy `.env.example` to `.env` and fill in your credentials to skip the setup wizard:

```bash
cp .env.example .env
# Edit .env and fill in GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
npm start
```

---

## Notes

- **Quota**: The YouTube Data API has a daily quota limit. Transfers of very large playlists (hundreds of videos) may need to be spread across multiple days.
- **Private/deleted videos**: Videos that are private, deleted, or region-restricted will show a `✗` status in the progress log and are listed in the summary.
- **Session storage**: Connected account tokens are stored in memory. Restarting the server will require you to reconnect your accounts (but not re-run the credential setup if credentials are saved in env vars or `credentials.json`).
- **Test users**: While your Google OAuth app is in *Testing* mode, only email addresses added as test users can sign in. Add both YouTube account email addresses in the OAuth consent screen.

## Development

Run the test suite:

```bash
npm test
```

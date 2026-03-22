'use strict';

const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const { google } = require('googleapis');
const { getWatchLaterVideos, addToWatchLater } = require('./transfer');
const { saveCredentials } = require('./config');

const SCOPES = ['https://www.googleapis.com/auth/youtube'];
/** Polling interval (ms) for flushing new SSE events to connected clients. */
const SSE_POLL_MS = 300;

/**
 * In-memory transfer state, keyed by session ID.
 * Each entry: { status: 'idle'|'running'|'done'|'error', events: Array, result: object|null }
 */
const transferState = new Map();

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------
/** Limits how often a single IP can initiate an OAuth flow or handle a callback. */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many authentication requests. Please try again later.',
});

/** Limits how often a single IP can start a transfer. */
const transferLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many transfer requests. Please try again later.',
});

// ---------------------------------------------------------------------------
// CSRF helpers (Synchronizer Token Pattern using express-session)
// ---------------------------------------------------------------------------

/** Generates a CSRF token and stores it in the session if one doesn't exist yet. */
function ensureCsrfToken(req, _res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  next();
}

/**
 * Verifies that the `_csrf` field in the request body matches the session token.
 * Returns 403 if the token is missing or invalid.
 */
function verifyCsrfToken(req, res, next) {
  const token = req.body && req.body._csrf;
  if (!token || token !== req.session.csrfToken) {
    return res.status(403).send(htmlError('Invalid CSRF token. Please go back and try again.'));
  }
  next();
}

/**
 * Creates and configures the Express application.
 *
 * @param {{ clientId: string|null, clientSecret: string|null, appUrl: string|null, sessionSecret: string }} config
 * @returns {import('express').Application}
 */
function createApp(config) {
  // Mutable credentials — can be updated via the /setup wizard.
  const appConfig = {
    clientId: config.clientId || null,
    clientSecret: config.clientSecret || null,
    // null = auto-detect from request (locked in after first auth attempt)
    appUrl: config.appUrl || null,
  };
  const { sessionSecret } = config;

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: false }));
  app.use(
    session({
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        // Secure only when we know we're on HTTPS (either configured URL or forwarded proto)
        get secure() {
          const url = appConfig.appUrl || '';
          return url.startsWith('https');
        },
        sameSite: 'lax',
      },
    })
  );

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns the base URL of the app. Uses the configured appUrl if available;
   * otherwise derives it from the request (and locks it in for consistency).
   */
  function getBaseUrl(req) {
    if (appConfig.appUrl) return appConfig.appUrl;
    const proto = req.get('x-forwarded-proto') || req.protocol;
    const detected = `${proto}://${req.get('host')}`;
    appConfig.appUrl = detected;
    return detected;
  }

  /** Create an OAuth2 client, optionally pre-loaded with tokens. */
  function makeOAuth2Client(tokens, baseUrl) {
    const redirectUri = `${baseUrl}/oauth2callback`;
    const client = new google.auth.OAuth2(appConfig.clientId, appConfig.clientSecret, redirectUri);
    if (tokens) client.setCredentials(tokens);
    return client;
  }

  /**
   * Middleware: if Google credentials are not yet configured, redirect to /setup.
   * Allows /setup itself and /oauth2callback (Google's redirect target) through.
   */
  function requireCredentials(req, res, next) {
    if (!appConfig.clientId || !appConfig.clientSecret) {
      return res.redirect('/setup');
    }
    next();
  }

  // -------------------------------------------------------------------------
  // GET /setup — First-time credential setup wizard
  // -------------------------------------------------------------------------
  app.get('/setup', ensureCsrfToken, (req, res) => {
    // Already configured → go to main app
    if (appConfig.clientId && appConfig.clientSecret) {
      return res.redirect('/');
    }
    const baseUrl = getBaseUrl(req);
    res.send(renderSetupPage({ csrfToken: req.session.csrfToken, baseUrl, error: null }));
  });

  // -------------------------------------------------------------------------
  // POST /setup — Save credentials entered through the wizard
  // -------------------------------------------------------------------------
  app.post('/setup', authLimiter, verifyCsrfToken, (req, res) => {
    const clientId = (req.body.clientId || '').trim();
    const clientSecret = (req.body.clientSecret || '').trim();
    const baseUrl = getBaseUrl(req);

    if (!clientId || !clientSecret) {
      return res.send(
        renderSetupPage({
          csrfToken: req.session.csrfToken,
          baseUrl,
          error: 'Both Client ID and Client Secret are required.',
          prefill: { clientId, clientSecret },
        })
      );
    }

    // Update in-memory config immediately
    appConfig.clientId = clientId;
    appConfig.clientSecret = clientSecret;

    // Attempt to persist to disk (best-effort; may fail on read-only filesystems)
    saveCredentials(clientId, clientSecret);

    res.redirect('/');
  });

  // -------------------------------------------------------------------------
  // GET / — Main page
  // -------------------------------------------------------------------------
  app.get('/', requireCredentials, ensureCsrfToken, (req, res) => {
    const hasSource = !!req.session.sourceTokens;
    const hasDestination = !!req.session.destinationTokens;
    const state = transferState.get(req.session.id) || { status: 'idle', events: [] };
    res.send(renderPage({ hasSource, hasDestination, state, csrfToken: req.session.csrfToken }));
  });

  // -------------------------------------------------------------------------
  // GET /auth/:account — Start OAuth2 flow (account = "source" | "destination")
  // -------------------------------------------------------------------------
  app.get('/auth/:account', requireCredentials, authLimiter, (req, res) => {
    const { account } = req.params;
    if (account !== 'source' && account !== 'destination') {
      return res.status(400).send('Invalid account type.');
    }
    const baseUrl = getBaseUrl(req);
    const authUrl = makeOAuth2Client(null, baseUrl).generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'select_account',
      state: account,
    });
    res.redirect(authUrl);
  });

  // -------------------------------------------------------------------------
  // GET /oauth2callback — Google redirects here after user consents
  // -------------------------------------------------------------------------
  app.get('/oauth2callback', authLimiter, async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).send(htmlError(`Google returned an error: ${error}`));
    }
    if (!code || (state !== 'source' && state !== 'destination')) {
      return res.status(400).send(htmlError('Invalid OAuth2 callback parameters.'));
    }

    try {
      const baseUrl = getBaseUrl(req);
      const { tokens } = await makeOAuth2Client(null, baseUrl).getToken(String(code));
      if (state === 'source') {
        req.session.sourceTokens = tokens;
        // Reset destination and any prior transfer when the source account changes
        delete req.session.destinationTokens;
        transferState.delete(req.session.id);
      } else {
        req.session.destinationTokens = tokens;
      }
      res.redirect('/');
    } catch (err) {
      res.status(500).send(htmlError(`Failed to exchange authorization code: ${err.message}`));
    }
  });

  // -------------------------------------------------------------------------
  // POST /disconnect/:account — Remove one account from session
  // -------------------------------------------------------------------------
  app.post('/disconnect/:account', requireCredentials, verifyCsrfToken, (req, res) => {
    const { account } = req.params;
    if (account === 'source') {
      delete req.session.sourceTokens;
      delete req.session.destinationTokens;
      transferState.delete(req.session.id);
    } else if (account === 'destination') {
      delete req.session.destinationTokens;
    }
    res.redirect('/');
  });

  // -------------------------------------------------------------------------
  // POST /transfer — Kick off background transfer
  // -------------------------------------------------------------------------
  app.post('/transfer', requireCredentials, transferLimiter, verifyCsrfToken, (req, res) => {
    if (!req.session.sourceTokens || !req.session.destinationTokens) {
      return res.redirect('/');
    }
    const sid = req.session.id;
    const current = transferState.get(sid);
    if (current && current.status === 'running') {
      return res.redirect('/');
    }

    const state = { status: 'running', events: [], result: null };
    transferState.set(sid, state);

    const baseUrl = getBaseUrl(req);
    const sourceAuth = makeOAuth2Client(req.session.sourceTokens, baseUrl);
    const destAuth = makeOAuth2Client(req.session.destinationTokens, baseUrl);

    runTransfer(sourceAuth, destAuth, state).catch((err) => {
      state.status = 'error';
      state.events.push({ type: 'error', message: err.message });
    });

    res.redirect('/');
  });

  // -------------------------------------------------------------------------
  // GET /transfer/events — Server-Sent Events stream for transfer progress
  // -------------------------------------------------------------------------
  app.get('/transfer/events', requireCredentials, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sid = req.session.id;
    let lastSent = 0;

    const send = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const interval = setInterval(() => {
      const state = transferState.get(sid);
      if (!state) {
        clearInterval(interval);
        res.end();
        return;
      }
      while (lastSent < state.events.length) {
        send(state.events[lastSent]);
        lastSent++;
      }
      if (state.status === 'done' || state.status === 'error') {
        clearInterval(interval);
        res.end();
      }
    }, SSE_POLL_MS);

    req.on('close', () => clearInterval(interval));
  });

  return app;
}

/**
 * Runs the full Watch Later transfer, appending structured events to `state`.
 *
 * @param {import('google-auth-library').OAuth2Client} sourceAuth
 * @param {import('google-auth-library').OAuth2Client} destAuth
 * @param {{ status: string, events: Array, result: object|null }} state
 */
async function runTransfer(sourceAuth, destAuth, state) {
  state.events.push({ type: 'log', message: 'Fetching Watch Later playlist from source account...' });

  const videos = await getWatchLaterVideos(sourceAuth);
  state.events.push({ type: 'log', message: `Found ${videos.length} video(s).` });

  if (videos.length === 0) {
    state.status = 'done';
    state.result = { added: 0, failed: 0, errors: [] };
    state.events.push({ type: 'done', added: 0, failed: 0, errors: [] });
    return;
  }

  state.events.push({ type: 'total', count: videos.length });

  const result = await addToWatchLater(destAuth, videos, (current, total, title, success) => {
    state.events.push({ type: 'progress', current, total, title, success });
  });

  state.status = 'done';
  state.result = result;
  state.events.push({ type: 'done', added: result.added, failed: result.failed, errors: result.errors });
}

// =============================================================================
// HTML rendering helpers
// =============================================================================

function htmlError(message) {
  return `<!DOCTYPE html><html><head><title>Error</title></head><body>
  <h2>Error</h2><p>${escapeHtml(message)}</p><a href="/">← Back</a></body></html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Shared CSS used by both the main page and the setup page. */
function sharedStyles() {
  return `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #1a1a1a; }
    header { background: #ff0000; color: #fff; padding: 1rem 2rem; }
    header h1 { font-size: 1.4rem; font-weight: 700; }
    main { max-width: 700px; margin: 2rem auto; padding: 0 1rem; }
    .card { background: #fff; border-radius: 8px; padding: 1.25rem 1.5rem;
            margin-bottom: 1.25rem; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
    .card h2 { font-size: 1rem; font-weight: 600; margin-bottom: .75rem; color: #555;
               text-transform: uppercase; letter-spacing: .04em; }
    .btn { display: inline-block; padding: .45rem 1rem; border-radius: 6px; font-size: .9rem;
           font-weight: 500; cursor: pointer; border: none; text-decoration: none; white-space: nowrap; }
    .btn-primary  { background: #1a73e8; color: #fff; }
    .btn-primary:hover  { background: #1558b0; }
    .btn-secondary { background: #e8eaed; color: #3c4043; }
    .btn-secondary:hover { background: #d2d5d9; }
    .btn-success  { background: #1a7a3a; color: #fff; }
    .btn-success:hover  { background: #135c2b; }
    .btn-disabled { opacity: .45; cursor: not-allowed; pointer-events: none; }
    a { color: #1a73e8; }`;
}

// ---------------------------------------------------------------------------
// Setup page
// ---------------------------------------------------------------------------

function renderSetupPage({ csrfToken, baseUrl, error, prefill }) {
  const redirectUri = `${baseUrl}/oauth2callback`;
  const csrf = `<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken || '')}">`;
  const errorHtml = error
    ? `<div class="alert-error" role="alert">${escapeHtml(error)}</div>`
    : '';
  const prefillId = escapeHtml((prefill && prefill.clientId) || '');
  const prefillSecret = escapeHtml((prefill && prefill.clientSecret) || '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="csrf-token" content="${escapeHtml(csrfToken || '')}">
  <title>Setup — YouTube Watch Later Transfer</title>
  <style>
    ${sharedStyles()}
    ol, ul { padding-left: 1.4rem; }
    ol li, ul li { margin-bottom: .4rem; line-height: 1.6; }
    .step-num { display: inline-flex; align-items: center; justify-content: center;
                width: 1.6rem; height: 1.6rem; border-radius: 50%; background: #ff0000;
                color: #fff; font-weight: 700; font-size: .8rem; margin-right: .5rem;
                flex-shrink: 0; }
    .step-header { display: flex; align-items: center; margin-bottom: .75rem; }
    .step-header h2 { margin: 0; }
    .redirect-box { display: flex; align-items: center; gap: .5rem; margin: .6rem 0;
                    background: #f0f4ff; border: 1px solid #c5d3f7; border-radius: 6px;
                    padding: .5rem .75rem; flex-wrap: wrap; }
    .redirect-box code { font-family: monospace; font-size: .875rem; color: #1a1a1a;
                         word-break: break-all; flex: 1; }
    .field { margin-bottom: 1rem; }
    .field label { display: block; font-weight: 500; margin-bottom: .3rem; font-size: .9rem; }
    .field input { width: 100%; padding: .5rem .75rem; border: 1px solid #ccc; border-radius: 6px;
                   font-size: .9rem; font-family: monospace; }
    .field input:focus { outline: none; border-color: #1a73e8; box-shadow: 0 0 0 2px rgba(26,115,232,.2); }
    .alert-error { background: #fdf0f0; color: #a12323; border: 1px solid #f5c0c0;
                   border-radius: 6px; padding: .6rem .9rem; margin-bottom: .9rem; font-size: .9rem; }
    .note { font-size: .85rem; color: #666; margin-top: .5rem; line-height: 1.5; }
    .badge-info { display: inline-block; background: #e8f0fe; color: #1a55b5;
                  border-radius: 4px; padding: .15rem .5rem; font-size: .8rem; font-weight: 600; }
  </style>
</head>
<body>
<header><h1>🔧 First-time Setup</h1></header>
<main>

  <div class="card" style="background:#fffbea;border-left:4px solid #f4b400;">
    <p style="font-size:.95rem">
      This app uses Google's YouTube API to move your Watch Later playlist.
      You need to create <strong>free</strong> Google OAuth credentials — a one-time setup that takes
      about 5&nbsp;minutes. Follow the steps below.
    </p>
  </div>

  <!-- Step 1 -->
  <div class="card">
    <div class="step-header">
      <span class="step-num">1</span>
      <h2>Create a Google Cloud project</h2>
    </div>
    <ol>
      <li>Go to <a href="https://console.cloud.google.com" target="_blank" rel="noopener">console.cloud.google.com</a>
          and sign in with any Google account.</li>
      <li>Click the project selector at the top &rarr; <strong>New Project</strong>.</li>
      <li>Give it any name (e.g. <em>Watch Later Transfer</em>) and click <strong>Create</strong>.</li>
    </ol>
  </div>

  <!-- Step 2 -->
  <div class="card">
    <div class="step-header">
      <span class="step-num">2</span>
      <h2>Enable the YouTube Data API</h2>
    </div>
    <ol>
      <li>In the left sidebar &rarr; <strong>APIs &amp; Services &rarr; Library</strong>.</li>
      <li>Search for <strong>YouTube Data API v3</strong>.</li>
      <li>Click on it, then click <strong>Enable</strong>.</li>
    </ol>
  </div>

  <!-- Step 3 -->
  <div class="card">
    <div class="step-header">
      <span class="step-num">3</span>
      <h2>Configure the OAuth consent screen</h2>
    </div>
    <ol>
      <li>In the left sidebar &rarr; <strong>APIs &amp; Services &rarr; OAuth consent screen</strong>.</li>
      <li>Choose <strong>External</strong> and click <strong>Create</strong>.</li>
      <li>Fill in <em>App name</em> (anything) and your email address, then click <strong>Save and Continue</strong>
          through all the remaining screens.</li>
      <li>On the <strong>Test users</strong> step, click <strong>+ Add Users</strong> and add the email
          addresses of <em>both</em> YouTube accounts you want to transfer between. Click <strong>Save and Continue</strong>.</li>
    </ol>
    <p class="note">⚠ While the app is in <em>Testing</em> mode only the emails you add here can sign in.</p>
  </div>

  <!-- Step 4 -->
  <div class="card">
    <div class="step-header">
      <span class="step-num">4</span>
      <h2>Create OAuth credentials</h2>
    </div>
    <ol>
      <li>In the left sidebar &rarr; <strong>APIs &amp; Services &rarr; Credentials</strong>.</li>
      <li>Click <strong>+ Create Credentials &rarr; OAuth client ID</strong>.</li>
      <li>Application type: <strong>Web application</strong>.</li>
      <li>Under <strong>Authorized redirect URIs</strong>, click <strong>+ Add URI</strong> and paste
          this exact value:
        <div class="redirect-box">
          <code id="redirect-uri">${escapeHtml(redirectUri)}</code>
          <button type="button" class="btn btn-secondary"
                  onclick="navigator.clipboard.writeText(document.getElementById('redirect-uri').textContent)
                           .then(() => this.textContent = 'Copied!')
                           .catch(() => {})"
                  style="font-size:.8rem;padding:.25rem .6rem">Copy</button>
        </div>
      </li>
      <li>Click <strong>Create</strong>. A dialog shows your
          <span class="badge-info">Client ID</span> and
          <span class="badge-info">Client Secret</span> — copy both.</li>
    </ol>
  </div>

  <!-- Step 5 — enter credentials -->
  <div class="card">
    <div class="step-header">
      <span class="step-num">5</span>
      <h2>Enter your credentials below</h2>
    </div>
    ${errorHtml}
    <form method="POST" action="/setup">
      ${csrf}
      <div class="field">
        <label for="clientId">Client ID</label>
        <input type="text" id="clientId" name="clientId" required
               autocomplete="off" spellcheck="false"
               placeholder="123456789-abc.apps.googleusercontent.com"
               value="${prefillId}">
      </div>
      <div class="field">
        <label for="clientSecret">Client Secret</label>
        <input type="password" id="clientSecret" name="clientSecret" required
               autocomplete="off" spellcheck="false"
               placeholder="GOCSPX-…"
               value="${prefillSecret}">
      </div>
      <button type="submit" class="btn btn-success">Save &amp; Continue &rarr;</button>
    </form>
    <p class="note" style="margin-top:.9rem">
      Your credentials are stored locally on this server and never sent anywhere else.
      On Render.com free tier they may be lost on restart — to make them permanent, copy them
      into your <strong>Render dashboard &rarr; Environment Variables</strong> as
      <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>.
    </p>
  </div>

</main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main app page
// ---------------------------------------------------------------------------

function renderPage({ hasSource, hasDestination, state, csrfToken }) {
  const canTransfer = hasSource && hasDestination;
  const isRunning = state.status === 'running';
  const isDone = state.status === 'done';
  const isError = state.status === 'error';
  const hasResult = isDone && state.result;
  const csrf = `<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken || '')}">`;

  const sourceBtn = hasSource
    ? `<form method="POST" action="/disconnect/source" style="display:inline">
         ${csrf}
         <button type="submit" class="btn btn-secondary">Disconnect</button>
       </form>`
    : `<a href="/auth/source" class="btn btn-primary">Connect Source Account</a>`;

  const destBtn = hasDestination
    ? `<form method="POST" action="/disconnect/destination" style="display:inline">
         ${csrf}
         <button type="submit" class="btn btn-secondary">Disconnect</button>
       </form>`
    : `<a href="/auth/destination" class="btn btn-primary${hasSource ? '' : ' btn-disabled'}"
         ${hasSource ? '' : 'aria-disabled="true" tabindex="-1"'}>Connect Destination Account</a>`;

  const transferBtn = canTransfer && !isRunning
    ? `<form method="POST" action="/transfer">
         ${csrf}
         <button type="submit" class="btn btn-success">▶ Start Transfer</button>
       </form>`
    : `<button class="btn btn-success btn-disabled" disabled>▶ Start Transfer</button>`;

  const progressSection = (isRunning || isDone || isError)
    ? `<section class="progress-box" id="progress-box">
         <h2>Transfer Progress</h2>
         <div id="log"></div>
         ${hasResult ? summaryHtml(state.result) : ''}
       </section>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="csrf-token" content="${escapeHtml(csrfToken || '')}">
  <title>YouTube Watch Later Transfer</title>
  <style>
    ${sharedStyles()}
    .account-row { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
    .badge { display: inline-flex; align-items: center; gap: .4rem; font-size: .875rem;
             border-radius: 20px; padding: .25rem .75rem; font-weight: 500; }
    .badge-ok  { background: #e6f9ee; color: #1a7a3a; }
    .badge-no  { background: #fdf0f0; color: #a12323; }
    .progress-box { background: #fff; border-radius: 8px; padding: 1.25rem 1.5rem;
                    box-shadow: 0 1px 4px rgba(0,0,0,.08); }
    .progress-box h2 { font-size: 1rem; font-weight: 600; margin-bottom: .75rem; color: #555;
                       text-transform: uppercase; letter-spacing: .04em; }
    #log { font-family: monospace; font-size: .85rem; line-height: 1.6; white-space: pre-wrap;
           max-height: 400px; overflow-y: auto; }
    .ok  { color: #1a7a3a; }
    .err { color: #a12323; }
    .summary { margin-top: 1rem; padding: .75rem 1rem; border-radius: 6px; font-size: .9rem; }
    .summary-ok  { background: #e6f9ee; color: #1a7a3a; }
    .summary-warn { background: #fff8e1; color: #7a5f00; }
  </style>
</head>
<body>
<header><h1>▶ YouTube Watch Later Transfer</h1></header>
<main>
  <div class="card">
    <h2>Step 1 — Source Account</h2>
    <div class="account-row">
      <span class="badge ${hasSource ? 'badge-ok' : 'badge-no'}">${hasSource ? '✓ Connected' : '✗ Not connected'}</span>
      ${sourceBtn}
    </div>
  </div>

  <div class="card">
    <h2>Step 2 — Destination Account</h2>
    <div class="account-row">
      <span class="badge ${hasDestination ? 'badge-ok' : 'badge-no'}">${hasDestination ? '✓ Connected' : '✗ Not connected'}</span>
      ${destBtn}
    </div>
  </div>

  <div class="card">
    <h2>Step 3 — Transfer</h2>
    ${canTransfer && !isRunning && !isDone
      ? '<p style="font-size:.9rem;color:#555;margin-bottom:.75rem">Both accounts connected. Click the button below to start copying your Watch Later playlist.</p>'
      : !canTransfer
        ? '<p style="font-size:.9rem;color:#888;">Connect both accounts above to enable the transfer.</p>'
        : ''}
    ${isRunning ? '<p style="font-size:.9rem;color:#1a73e8;margin-bottom:.75rem">⏳ Transfer in progress…</p>' : ''}
    ${transferBtn}
  </div>

  ${progressSection}
</main>
<script>
(function () {
  const isRunning = ${JSON.stringify(isRunning)};
  const hasDoneResult = ${JSON.stringify(isDone && !isError)};

  if (!isRunning && !hasDoneResult) return;

  const log = document.getElementById('log');
  if (!log) return;

  // Render any events that were already stored (page reload after transfer started)
  const existingEvents = ${JSON.stringify(state.events || [])};
  let total = 0;
  existingEvents.forEach(applyEvent);

  if (isRunning) {
    const src = new EventSource('/transfer/events');
    src.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        applyEvent(event);
        if (event.type === 'done' || event.type === 'error') src.close();
      } catch (_) {}
    };
    src.onerror = () => src.close();
  }

  function applyEvent(event) {
    if (event.type === 'log') {
      appendLog(event.message);
    } else if (event.type === 'total') {
      total = event.count;
    } else if (event.type === 'progress') {
      const icon = event.success ? '<span class="ok">✓</span>' : '<span class="err">✗</span>';
      appendLogHtml(\`  [\${event.current}/\${event.total}] \${icon} \${escHtml(event.title)}\n\`);
    } else if (event.type === 'done') {
      const box = document.getElementById('progress-box');
      if (box && !box.querySelector('.summary')) {
        const div = document.createElement('div');
        const cls = event.failed > 0 ? 'summary summary-warn' : 'summary summary-ok';
        div.className = cls;
        div.innerHTML = \`<strong>Transfer complete.</strong> Added: \${event.added} &nbsp;|&nbsp; Failed: \${event.failed}\`;
        if (event.errors && event.errors.length) {
          const ul = document.createElement('ul');
          ul.style.marginTop = '.5rem';
          event.errors.forEach(e => {
            const li = document.createElement('li');
            li.textContent = \`\${e.title} — \${e.error}\`;
            ul.appendChild(li);
          });
          div.appendChild(ul);
        }
        box.appendChild(div);
      }
    } else if (event.type === 'error') {
      appendLog('ERROR: ' + event.message);
    }
  }

  function appendLog(text) {
    const span = document.createElement('span');
    span.textContent = text + '\\n';
    log.appendChild(span);
    log.scrollTop = log.scrollHeight;
  }

  function appendLogHtml(html) {
    const span = document.createElement('span');
    span.innerHTML = html;
    log.appendChild(span);
    log.scrollTop = log.scrollHeight;
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
})();
</script>
</body>
</html>`;
}

function summaryHtml(result) {
  if (!result) return '';
  const cls = result.failed > 0 ? 'summary summary-warn' : 'summary summary-ok';
  let html = `<div class="${cls}"><strong>Transfer complete.</strong> Added: ${result.added} &nbsp;|&nbsp; Failed: ${result.failed}`;
  if (result.errors && result.errors.length) {
    html += '<ul style="margin-top:.5rem">';
    for (const e of result.errors) {
      html += `<li>${escapeHtml(e.title)} — ${escapeHtml(e.error)}</li>`;
    }
    html += '</ul>';
  }
  html += '</div>';
  return html;
}

module.exports = { createApp, runTransfer, transferState };

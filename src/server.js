'use strict';

const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const { getWatchLaterVideos, addToWatchLater } = require('./transfer');

const SCOPES = ['https://www.googleapis.com/auth/youtube'];
/** Polling interval (ms) for flushing new SSE events to connected clients. */
const SSE_POLL_MS = 300;

/**
 * In-memory transfer state, keyed by session ID.
 * Each entry: { status: 'idle'|'running'|'done'|'error', events: Array, result: object|null }
 */
const transferState = new Map();

/**
 * Creates and configures the Express application.
 *
 * @param {{ clientId: string, clientSecret: string, appUrl: string, sessionSecret: string }} config
 * @returns {import('express').Application}
 */
function createApp(config) {
  const { clientId, clientSecret, appUrl, sessionSecret } = config;
  const redirectUri = `${appUrl}/oauth2callback`;

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
        secure: appUrl.startsWith('https'),
        sameSite: 'lax',
      },
    })
  );

  /** Create an OAuth2 client, optionally pre-loaded with tokens. */
  function makeOAuth2Client(tokens) {
    const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    if (tokens) client.setCredentials(tokens);
    return client;
  }

  // -------------------------------------------------------------------------
  // GET / — Main page
  // -------------------------------------------------------------------------
  app.get('/', (req, res) => {
    const hasSource = !!req.session.sourceTokens;
    const hasDestination = !!req.session.destinationTokens;
    const state = transferState.get(req.session.id) || { status: 'idle', events: [] };
    res.send(renderPage({ hasSource, hasDestination, state }));
  });

  // -------------------------------------------------------------------------
  // GET /auth/:account — Start OAuth2 flow (account = "source" | "destination")
  // -------------------------------------------------------------------------
  app.get('/auth/:account', (req, res) => {
    const { account } = req.params;
    if (account !== 'source' && account !== 'destination') {
      return res.status(400).send('Invalid account type.');
    }
    const authUrl = makeOAuth2Client(null).generateAuthUrl({
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
  app.get('/oauth2callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).send(htmlError(`Google returned an error: ${error}`));
    }
    if (!code || (state !== 'source' && state !== 'destination')) {
      return res.status(400).send(htmlError('Invalid OAuth2 callback parameters.'));
    }

    try {
      const { tokens } = await makeOAuth2Client(null).getToken(String(code));
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
  app.post('/disconnect/:account', (req, res) => {
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
  app.post('/transfer', (req, res) => {
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

    const sourceAuth = makeOAuth2Client(req.session.sourceTokens);
    const destAuth = makeOAuth2Client(req.session.destinationTokens);

    runTransfer(sourceAuth, destAuth, state).catch((err) => {
      state.status = 'error';
      state.events.push({ type: 'error', message: err.message });
    });

    res.redirect('/');
  });

  // -------------------------------------------------------------------------
  // GET /transfer/events — Server-Sent Events stream for transfer progress
  // -------------------------------------------------------------------------
  app.get('/transfer/events', (req, res) => {
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

function renderPage({ hasSource, hasDestination, state }) {
  const canTransfer = hasSource && hasDestination;
  const isRunning = state.status === 'running';
  const isDone = state.status === 'done';
  const isError = state.status === 'error';
  const hasResult = isDone && state.result;

  const sourceBtn = hasSource
    ? `<form method="POST" action="/disconnect/source" style="display:inline">
         <button type="submit" class="btn btn-secondary">Disconnect</button>
       </form>`
    : `<a href="/auth/source" class="btn btn-primary">Connect Source Account</a>`;

  const destBtn = hasDestination
    ? `<form method="POST" action="/disconnect/destination" style="display:inline">
         <button type="submit" class="btn btn-secondary">Disconnect</button>
       </form>`
    : `<a href="/auth/destination" class="btn btn-primary${hasSource ? '' : ' btn-disabled'}"
         ${hasSource ? '' : 'aria-disabled="true" tabindex="-1"'}>Connect Destination Account</a>`;

  const transferBtn = canTransfer && !isRunning
    ? `<form method="POST" action="/transfer">
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
  <title>YouTube Watch Later Transfer</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #1a1a1a; }
    header { background: #ff0000; color: #fff; padding: 1rem 2rem; }
    header h1 { font-size: 1.4rem; font-weight: 700; }
    main { max-width: 700px; margin: 2rem auto; padding: 0 1rem; }
    .card { background: #fff; border-radius: 8px; padding: 1.25rem 1.5rem;
            margin-bottom: 1.25rem; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
    .card h2 { font-size: 1rem; font-weight: 600; margin-bottom: .75rem; color: #555; text-transform: uppercase; letter-spacing: .04em; }
    .account-row { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
    .badge { display: inline-flex; align-items: center; gap: .4rem; font-size: .875rem;
             border-radius: 20px; padding: .25rem .75rem; font-weight: 500; }
    .badge-ok  { background: #e6f9ee; color: #1a7a3a; }
    .badge-no  { background: #fdf0f0; color: #a12323; }
    .btn { display: inline-block; padding: .45rem 1rem; border-radius: 6px; font-size: .9rem;
           font-weight: 500; cursor: pointer; border: none; text-decoration: none; white-space: nowrap; }
    .btn-primary  { background: #1a73e8; color: #fff; }
    .btn-primary:hover  { background: #1558b0; }
    .btn-secondary { background: #e8eaed; color: #3c4043; }
    .btn-secondary:hover { background: #d2d5d9; }
    .btn-success  { background: #1a7a3a; color: #fff; }
    .btn-success:hover  { background: #135c2b; }
    .btn-disabled { opacity: .45; cursor: not-allowed; pointer-events: none; }
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

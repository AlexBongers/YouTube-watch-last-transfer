'use strict';

const request = require('supertest');
const { createApp, transferState } = require('../src/server');

// ---------------------------------------------------------------------------
// Mock googleapis so no real HTTP calls are made
// ---------------------------------------------------------------------------
jest.mock('googleapis', () => {
  const mockChannels = { list: jest.fn() };
  const mockPlaylistItems = { list: jest.fn(), insert: jest.fn() };
  const mockYoutube = { channels: mockChannels, playlistItems: mockPlaylistItems };
  return {
    google: {
      youtube: jest.fn(() => mockYoutube),
      auth: {
        OAuth2: jest.fn().mockImplementation(() => ({
          generateAuthUrl: jest.fn(
            () => 'https://accounts.google.com/o/oauth2/auth?mock=1'
          ),
          getToken: jest.fn().mockResolvedValue({ tokens: { access_token: 'tok' } }),
          setCredentials: jest.fn(),
        })),
      },
    },
  };
});

// Mock config module so tests don't write to disk
jest.mock('../src/config', () => ({
  saveCredentials: jest.fn().mockReturnValue(true),
  loadCredentials: jest.fn().mockReturnValue({ clientId: null, clientSecret: null }),
}));

const { google } = require('googleapis');

// ---------------------------------------------------------------------------
// Test app factories
// ---------------------------------------------------------------------------
function makeApp() {
  return createApp({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    appUrl: 'http://localhost:3000',
    sessionSecret: 'test-session-secret',
  });
}

function makeAppWithoutCreds() {
  return createApp({
    clientId: null,
    clientSecret: null,
    appUrl: 'http://localhost:3000',
    sessionSecret: 'test-session-secret',
  });
}

afterEach(() => {
  jest.clearAllMocks();
  transferState.clear();
});

/**
 * Fetches the home page and extracts the CSRF token from the meta tag.
 * Requires a persistent agent so the session cookie is maintained.
 */
async function getCsrfToken(agent, path = '/') {
  const home = await agent.get(path);
  const match = home.text.match(/name="csrf-token" content="([^"]+)"/);
  return match ? match[1] : '';
}

// ---------------------------------------------------------------------------
// Setup flow (no credentials configured)
// ---------------------------------------------------------------------------
describe('Setup flow — no credentials', () => {
  test('GET / redirects to /setup when credentials not configured', async () => {
    const app = makeAppWithoutCreds();
    const res = await request(app).get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/setup');
  });

  test('GET /auth/source redirects to /setup when credentials not configured', async () => {
    const app = makeAppWithoutCreds();
    const res = await request(app).get('/auth/source');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/setup');
  });

  test('GET /setup returns 200 with setup wizard content', async () => {
    const app = makeAppWithoutCreds();
    const res = await request(app).get('/setup');
    expect(res.status).toBe(200);
    expect(res.text).toContain('First-time Setup');
    expect(res.text).toContain('/oauth2callback');
    expect(res.text).toContain('Client ID');
    expect(res.text).toContain('Client Secret');
  });

  test('GET /setup shows the correct redirect URI', async () => {
    const app = makeAppWithoutCreds();
    const res = await request(app).get('/setup');
    expect(res.text).toContain('http://localhost:3000/oauth2callback');
  });

  test('POST /setup with valid credentials configures app and redirects to /', async () => {
    const { saveCredentials } = require('../src/config');
    const app = makeAppWithoutCreds();
    const agent = request.agent(app);
    const csrf = await getCsrfToken(agent, '/setup');

    const res = await agent
      .post('/setup')
      .send(`_csrf=${csrf}&clientId=my-client-id&clientSecret=my-client-secret`)
      .type('form');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(saveCredentials).toHaveBeenCalledWith('my-client-id', 'my-client-secret');
  });

  test('after POST /setup, GET / returns main app page', async () => {
    const app = makeAppWithoutCreds();
    const agent = request.agent(app);
    const csrf = await getCsrfToken(agent, '/setup');

    await agent
      .post('/setup')
      .send(`_csrf=${csrf}&clientId=my-client-id&clientSecret=my-client-secret`)
      .type('form');

    const home = await agent.get('/');
    expect(home.status).toBe(200);
    expect(home.text).toContain('Source Account');
  });

  test('POST /setup with missing clientId shows error', async () => {
    const app = makeAppWithoutCreds();
    const agent = request.agent(app);
    const csrf = await getCsrfToken(agent, '/setup');

    const res = await agent
      .post('/setup')
      .send(`_csrf=${csrf}&clientId=&clientSecret=some-secret`)
      .type('form');

    expect(res.status).toBe(200);
    expect(res.text).toContain('required');
  });

  test('POST /setup with missing clientSecret shows error', async () => {
    const app = makeAppWithoutCreds();
    const agent = request.agent(app);
    const csrf = await getCsrfToken(agent, '/setup');

    const res = await agent
      .post('/setup')
      .send(`_csrf=${csrf}&clientId=some-id&clientSecret=`)
      .type('form');

    expect(res.status).toBe(200);
    expect(res.text).toContain('required');
  });

  test('POST /setup returns 403 when CSRF token is missing', async () => {
    const app = makeAppWithoutCreds();
    const res = await request(app)
      .post('/setup')
      .send('clientId=x&clientSecret=y')
      .type('form');
    expect(res.status).toBe(403);
  });

  test('GET /setup redirects to / when credentials already configured', async () => {
    const app = makeApp(); // has credentials
    const res = await request(app).get('/setup');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });
});

// ---------------------------------------------------------------------------
// GET /
// ---------------------------------------------------------------------------
describe('GET /', () => {
  test('returns 200 with page content', async () => {
    const app = makeApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('YouTube Watch Later Transfer');
  });

  test('shows not-connected badges when no session tokens are set', async () => {
    const app = makeApp();
    const res = await request(app).get('/');
    expect(res.text).toContain('Connect Source Account');
    expect(res.text).not.toContain('Disconnect');
  });
});

// ---------------------------------------------------------------------------
// GET /auth/:account
// ---------------------------------------------------------------------------
describe('GET /auth/:account', () => {
  test('redirects to Google for source account', async () => {
    const app = makeApp();
    const res = await request(app).get('/auth/source');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/accounts\.google\.com/);
  });

  test('redirects to Google for destination account', async () => {
    const app = makeApp();
    const res = await request(app).get('/auth/destination');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/accounts\.google\.com/);
  });

  test('returns 400 for unknown account type', async () => {
    const app = makeApp();
    const res = await request(app).get('/auth/admin');
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /oauth2callback
// ---------------------------------------------------------------------------
describe('GET /oauth2callback', () => {
  test('stores source tokens in session and redirects to /', async () => {
    const app = makeApp();
    const agent = request.agent(app);

    const res = await agent.get('/oauth2callback?code=abc&state=source');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');

    // Visiting / should now show the source as connected
    const home = await agent.get('/');
    expect(home.text).toContain('Connect Destination Account');
  });

  test('stores destination tokens in session and redirects to /', async () => {
    const app = makeApp();
    const agent = request.agent(app);

    await agent.get('/oauth2callback?code=abc&state=source');
    const res = await agent.get('/oauth2callback?code=def&state=destination');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  test('returns 400 when error parameter is present', async () => {
    const app = makeApp();
    const res = await request(app).get('/oauth2callback?error=access_denied');
    expect(res.status).toBe(400);
  });

  test('returns 400 when code is missing', async () => {
    const app = makeApp();
    const res = await request(app).get('/oauth2callback?state=source');
    expect(res.status).toBe(400);
  });

  test('returns 400 when state is invalid', async () => {
    const app = makeApp();
    const res = await request(app).get('/oauth2callback?code=abc&state=evil');
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /disconnect/:account
// ---------------------------------------------------------------------------
describe('POST /disconnect/:account', () => {
  async function agentWithBothAccounts(app) {
    const agent = request.agent(app);
    await agent.get('/oauth2callback?code=s&state=source');
    await agent.get('/oauth2callback?code=d&state=destination');
    return agent;
  }

  test('disconnecting source clears both accounts', async () => {
    const app = makeApp();
    const agent = await agentWithBothAccounts(app);
    const csrf = await getCsrfToken(agent);

    await agent.post('/disconnect/source').send(`_csrf=${csrf}`).type('form');
    const home = await agent.get('/');
    expect(home.text).toContain('Connect Source Account');
    expect(home.text).toContain('btn-disabled'); // destination button disabled
  });

  test('disconnecting destination leaves source intact', async () => {
    const app = makeApp();
    const agent = await agentWithBothAccounts(app);
    const csrf = await getCsrfToken(agent);

    await agent.post('/disconnect/destination').send(`_csrf=${csrf}`).type('form');
    const home = await agent.get('/');
    // Source still connected (Disconnect button shown), destination gone
    expect(home.text).toContain('Connect Destination Account');
  });

  test('returns 403 when CSRF token is missing', async () => {
    const app = makeApp();
    const agent = await agentWithBothAccounts(app);
    const res = await agent.post('/disconnect/source');
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /transfer
// ---------------------------------------------------------------------------
describe('POST /transfer', () => {
  test('redirects to / when accounts not connected', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    const csrf = await getCsrfToken(agent);
    const res = await agent.post('/transfer').send(`_csrf=${csrf}`).type('form');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  test('returns 403 when CSRF token is missing', async () => {
    const app = makeApp();
    const res = await request(app).post('/transfer');
    expect(res.status).toBe(403);
  });

  test('starts transfer and redirects to / when both accounts connected', async () => {
    google.youtube().channels.list.mockResolvedValue({
      data: {
        items: [{ contentDetails: { relatedPlaylists: { watchLater: 'PLtest123' } } }],
      },
    });
    google.youtube().playlistItems.list.mockResolvedValue({
      data: { items: [], nextPageToken: undefined },
    });

    const app = makeApp();
    const agent = request.agent(app);
    await agent.get('/oauth2callback?code=s&state=source');
    await agent.get('/oauth2callback?code=d&state=destination');
    const csrf = await getCsrfToken(agent);

    const res = await agent.post('/transfer').send(`_csrf=${csrf}`).type('form');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });
});

// ---------------------------------------------------------------------------
// GET /transfer/events (SSE)
// ---------------------------------------------------------------------------
describe('GET /transfer/events', () => {
  test('returns event-stream content type', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await agent.get('/oauth2callback?code=s&state=source');

    // We can only check headers since SSE is a long-lived connection;
    // abort after a short time
    const res = await agent
      .get('/transfer/events')
      .timeout({ response: 500 })
      .catch((err) => err.response);

    if (res) {
      expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    }
  });
});

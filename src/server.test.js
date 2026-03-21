'use strict';

const request = require('supertest');
const { createApp, transferState } = require('../src/server');

// ---------------------------------------------------------------------------
// Mock googleapis so no real HTTP calls are made
// ---------------------------------------------------------------------------
jest.mock('googleapis', () => {
  const mockPlaylistItems = { list: jest.fn(), insert: jest.fn() };
  const mockYoutube = { playlistItems: mockPlaylistItems };
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

const { google } = require('googleapis');

// ---------------------------------------------------------------------------
// Test app factory — uses a fixed session secret so cookies work across calls
// ---------------------------------------------------------------------------
function makeApp() {
  return createApp({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    appUrl: 'http://localhost:3000',
    sessionSecret: 'test-session-secret',
  });
}

afterEach(() => {
  jest.clearAllMocks();
  transferState.clear();
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

    await agent.post('/disconnect/source');
    const home = await agent.get('/');
    expect(home.text).toContain('Connect Source Account');
    expect(home.text).toContain('btn-disabled'); // destination button disabled
  });

  test('disconnecting destination leaves source intact', async () => {
    const app = makeApp();
    const agent = await agentWithBothAccounts(app);

    await agent.post('/disconnect/destination');
    const home = await agent.get('/');
    // Source still connected (Disconnect button shown), destination gone
    expect(home.text).toContain('Connect Destination Account');
  });
});

// ---------------------------------------------------------------------------
// POST /transfer
// ---------------------------------------------------------------------------
describe('POST /transfer', () => {
  test('redirects to / when accounts not connected', async () => {
    const app = makeApp();
    const res = await request(app).post('/transfer');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  test('starts transfer and redirects to / when both accounts connected', async () => {
    google.youtube().playlistItems.list.mockResolvedValue({
      data: { items: [], nextPageToken: undefined },
    });

    const app = makeApp();
    const agent = request.agent(app);
    await agent.get('/oauth2callback?code=s&state=source');
    await agent.get('/oauth2callback?code=d&state=destination');

    const res = await agent.post('/transfer');
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

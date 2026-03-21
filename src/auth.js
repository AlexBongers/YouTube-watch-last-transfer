'use strict';

const { google } = require('googleapis');
const http = require('http');
const url = require('url');
const { exec } = require('child_process');

const SCOPES = ['https://www.googleapis.com/auth/youtube'];

/**
 * Opens a URL in the default system browser.
 * @param {string} targetUrl
 */
function openBrowser(targetUrl) {
  const platform = process.platform;
  const command =
    platform === 'win32' ? `start "" "${targetUrl}"` :
    platform === 'darwin' ? `open "${targetUrl}"` :
    `xdg-open "${targetUrl}"`;
  exec(command);
}

/**
 * Starts a temporary local HTTP server and waits for the OAuth2 authorization
 * code to be delivered to the redirect URI.
 * @param {number} port
 * @returns {Promise<string>} The authorization code.
 */
function waitForAuthCode(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const { query } = url.parse(req.url, true);
      if (query.code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body><h2>Authentication successful!</h2>' +
          '<p>You may close this tab and return to the terminal.</p></body></html>'
        );
        server.close();
        resolve(query.code);
      } else if (query.error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(
          `<html><body><h2>Authentication failed</h2><p>${query.error}</p></body></html>`
        );
        server.close();
        reject(new Error(`OAuth error: ${query.error}`));
      }
    });

    server.listen(port, () => {
      // Server is ready; caller will open the browser
    });

    server.on('error', (err) => {
      reject(new Error(`Could not start local server on port ${port}: ${err.message}`));
    });
  });
}

/**
 * Authenticates a YouTube account via OAuth2 and returns an authenticated client.
 * Opens the browser automatically; falls back to printing the URL if it cannot.
 *
 * @param {string} clientId      Google OAuth2 client ID.
 * @param {string} clientSecret  Google OAuth2 client secret.
 * @param {number} port          Local port for the OAuth redirect server.
 * @param {string} accountLabel  Human-readable label shown in console messages.
 * @returns {Promise<import('google-auth-library').OAuth2Client>}
 */
async function authenticate(clientId, clientSecret, port, accountLabel = 'account') {
  const redirectUri = `http://localhost:${port}/oauth2callback`;

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'select_account',
  });

  const codePromise = waitForAuthCode(port);

  console.log(`\nOpening browser for ${accountLabel} authentication...`);
  console.log('If the browser does not open automatically, visit:\n');
  console.log(`  ${authUrl}\n`);
  openBrowser(authUrl);

  const code = await codePromise;
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  return oauth2Client;
}

module.exports = { authenticate, waitForAuthCode, openBrowser };

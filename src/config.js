'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'credentials.json');

/**
 * Loads OAuth2 credentials. Priority order:
 *   1. GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET environment variables
 *   2. credentials.json file in the project root
 *   3. null (setup wizard will be shown)
 *
 * @returns {{ clientId: string|null, clientSecret: string|null }}
 */
function loadCredentials() {
  const envId = process.env.GOOGLE_CLIENT_ID;
  const envSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret };
  }

  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (data.clientId && data.clientSecret) {
      return { clientId: data.clientId, clientSecret: data.clientSecret };
    }
  } catch (_) {
    // File doesn't exist or can't be parsed — that's fine, setup wizard will handle it
  }

  return { clientId: null, clientSecret: null };
}

/**
 * Saves OAuth2 credentials to credentials.json in the project root.
 * Returns true on success, false if the file could not be written
 * (e.g., read-only filesystem). In that case credentials remain in memory.
 *
 * @param {string} clientId
 * @param {string} clientSecret
 * @returns {boolean}
 */
function saveCredentials(clientId, clientSecret) {
  try {
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({ clientId, clientSecret }, null, 2),
      'utf8'
    );
    return true;
  } catch (err) {
    console.warn(`Warning: Could not save credentials to file: ${err.message}`);
    return false;
  }
}

module.exports = { loadCredentials, saveCredentials, CONFIG_FILE };

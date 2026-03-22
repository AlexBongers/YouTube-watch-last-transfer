'use strict';

require('dotenv').config();

const { createApp } = require('./src/server');
const { loadCredentials } = require('./src/config');

const port = parseInt(process.env.PORT || '3000', 10);
const appUrl = process.env.APP_URL || null; // null = auto-detect from request
const sessionSecret = process.env.SESSION_SECRET || 'change-me-in-production';

const { clientId, clientSecret } = loadCredentials();

const app = createApp({ clientId, clientSecret, appUrl, sessionSecret });

app.listen(port, () => {
  const baseUrl = appUrl || `http://localhost:${port}`;
  console.log(`YouTube Watch Later Transfer running at ${baseUrl}`);
  if (!clientId || !clientSecret) {
    console.log('⚠  Google credentials not configured. Visit the app to complete setup.');
  }
});

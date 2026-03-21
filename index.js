'use strict';

require('dotenv').config();

const { createApp } = require('./src/server');

const port = parseInt(process.env.PORT || '3000', 10);
const appUrl = process.env.APP_URL || `http://localhost:${port}`;
const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const sessionSecret = process.env.SESSION_SECRET || 'change-me-in-production';

if (!clientId || !clientSecret) {
  console.error(
    'Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables are required.\n' +
    'Copy .env.example to .env and fill in your credentials.'
  );
  process.exit(1);
}

const app = createApp({ clientId, clientSecret, appUrl, sessionSecret });

app.listen(port, () => {
  console.log(`YouTube Watch Later Transfer running at ${appUrl}`);
});

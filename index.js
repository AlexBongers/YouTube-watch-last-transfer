'use strict';

require('dotenv').config();

const { authenticate } = require('./src/auth');
const { getWatchLaterVideos, addToWatchLater } = require('./src/transfer');

const OAUTH_PORT = parseInt(process.env.OAUTH_PORT || '3000', 10);

async function main() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error(
      'Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables are required.\n' +
      'Copy .env.example to .env and fill in your credentials.'
    );
    process.exit(1);
  }

  console.log('=== YouTube Watch Later Playlist Transfer ===\n');

  // --- Step 1: Authenticate with the source account ---
  console.log('Step 1: Sign in to your SOURCE account (the account whose Watch Later you want to copy).');
  const sourceAuth = await authenticate(clientId, clientSecret, OAUTH_PORT, 'source account');
  console.log('Source account authenticated.\n');

  // --- Step 2: Fetch the Watch Later playlist ---
  console.log('Step 2: Fetching Watch Later playlist from source account...');
  process.stdout.write('  Fetching...');
  const videos = await getWatchLaterVideos(sourceAuth);
  console.log(` ${videos.length} video(s) found.\n`);

  if (videos.length === 0) {
    console.log('No videos found in the Watch Later playlist. Nothing to transfer.');
    process.exit(0);
  }

  // --- Step 3: Authenticate with the destination account ---
  console.log('Step 3: Sign in to your DESTINATION account (where the videos will be added).');
  const destAuth = await authenticate(clientId, clientSecret, OAUTH_PORT, 'destination account');
  console.log('Destination account authenticated.\n');

  // --- Step 4: Add videos to destination Watch Later ---
  console.log(`Adding ${videos.length} video(s) to destination Watch Later playlist...\n`);
  const { added, failed, errors } = await addToWatchLater(destAuth, videos, (current, total, title, success) => {
    const status = success ? '✓' : '✗';
    console.log(`  [${current}/${total}] ${status} ${title}`);
  });

  // --- Summary ---
  console.log('\n=== Transfer Complete ===');
  console.log(`  Successfully added : ${added}`);
  if (failed > 0) {
    console.log(`  Failed             : ${failed}`);
    console.log('\nFailed videos:');
    for (const { title, videoId, error } of errors) {
      console.log(`  - ${title} (${videoId}): ${error}`);
    }
  }
}

main().catch((err) => {
  console.error('\nFatal error:', err.message || err);
  process.exit(1);
});

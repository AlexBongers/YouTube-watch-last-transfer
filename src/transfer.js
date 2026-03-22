'use strict';

const { google } = require('googleapis');

const WATCH_LATER_PLAYLIST_ID = 'WL';
const PAGE_SIZE = 50;
/** Milliseconds to wait between insert requests to reduce quota usage. */
const INSERT_DELAY_MS = 200;

/**
 * Retrieves all items from the authenticated user's Watch Later playlist.
 *
 * @param {import('google-auth-library').OAuth2Client} auth Authenticated OAuth2 client.
 * @returns {Promise<Array<{videoId: string, title: string}>>}
 */
async function getWatchLaterVideos(auth) {
  const youtube = google.youtube({ version: 'v3', auth });
  const videos = [];
  let pageToken;

  do {
    const response = await youtube.playlistItems.list({
      part: ['snippet'],
      playlistId: WATCH_LATER_PLAYLIST_ID,
      maxResults: PAGE_SIZE,
      pageToken,
    });

    const items = response.data.items || [];
    for (const item of items) {
      videos.push({
        videoId: item.snippet.resourceId.videoId,
        title: item.snippet.title,
      });
    }

    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return videos;
}

/**
 * Adds the given list of videos to the authenticated user's Watch Later playlist.
 *
 * @param {import('google-auth-library').OAuth2Client} auth Authenticated OAuth2 client.
 * @param {Array<{videoId: string, title: string}>} videos List of videos to add.
 * @param {(current: number, total: number, title: string, success: boolean) => void} [onProgress]
 *   Optional callback invoked after each insert attempt.
 * @returns {Promise<{added: number, failed: number, errors: Array<{videoId: string, title: string, error: string}>}>}
 */
async function addToWatchLater(auth, videos, onProgress) {
  const youtube = google.youtube({ version: 'v3', auth });
  let added = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < videos.length; i++) {
    const { videoId, title } = videos[i];
    try {
      await youtube.playlistItems.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            playlistId: WATCH_LATER_PLAYLIST_ID,
            resourceId: {
              kind: 'youtube#video',
              videoId,
            },
          },
        },
      });
      added++;
      if (onProgress) onProgress(i + 1, videos.length, title, true);
    } catch (err) {
      failed++;
      const errorMessage = err.message || String(err);
      errors.push({ videoId, title, error: errorMessage });
      if (onProgress) onProgress(i + 1, videos.length, title, false);
    }

    // Brief pause between requests to reduce risk of hitting quota limits.
    if (i < videos.length - 1) {
      await sleep(INSERT_DELAY_MS);
    }
  }

  return { added, failed, errors };
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { getWatchLaterVideos, addToWatchLater, sleep };

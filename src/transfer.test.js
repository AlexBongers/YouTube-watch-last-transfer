'use strict';

const { getWatchLaterVideos, addToWatchLater, sleep } = require('./transfer');

// Helpers to build fake YouTube API responses
function makePlaylistItemsListResponse(videoIds, nextPageToken = undefined) {
  return {
    data: {
      items: videoIds.map((id) => ({
        snippet: {
          title: `Video ${id}`,
          resourceId: { videoId: id },
        },
      })),
      nextPageToken,
    },
  };
}

function makeChannelsListResponse(watchLaterPlaylistId) {
  return {
    data: {
      items: [
        {
          contentDetails: {
            relatedPlaylists: {
              watchLater: watchLaterPlaylistId,
            },
          },
        },
      ],
    },
  };
}

const FAKE_WL_PLAYLIST_ID = 'PLxxxxxxxxxxxxxxxx';

// We need to mock the googleapis module so we control the youtube client.
jest.mock('googleapis', () => {
  const mockChannels = { list: jest.fn() };
  const mockPlaylistItems = {
    list: jest.fn(),
    insert: jest.fn(),
  };
  const mockYoutube = { channels: mockChannels, playlistItems: mockPlaylistItems };
  return {
    google: {
      youtube: jest.fn(() => mockYoutube),
    },
  };
});

const { google } = require('googleapis');

afterEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// getWatchLaterVideos
// ---------------------------------------------------------------------------
describe('getWatchLaterVideos', () => {
  test('returns all videos from a single page', async () => {
    google.youtube().channels.list.mockResolvedValueOnce(
      makeChannelsListResponse(FAKE_WL_PLAYLIST_ID)
    );
    google.youtube().playlistItems.list.mockResolvedValueOnce(
      makePlaylistItemsListResponse(['aaa', 'bbb', 'ccc'])
    );

    const videos = await getWatchLaterVideos({});

    expect(videos).toHaveLength(3);
    expect(videos[0]).toEqual({ videoId: 'aaa', title: 'Video aaa' });
    expect(videos[2]).toEqual({ videoId: 'ccc', title: 'Video ccc' });
  });

  test('follows pagination and returns all videos across pages', async () => {
    google.youtube().channels.list.mockResolvedValueOnce(
      makeChannelsListResponse(FAKE_WL_PLAYLIST_ID)
    );
    google.youtube().playlistItems.list
      .mockResolvedValueOnce(makePlaylistItemsListResponse(['v1', 'v2'], 'token1'))
      .mockResolvedValueOnce(makePlaylistItemsListResponse(['v3'], undefined));

    const videos = await getWatchLaterVideos({});

    expect(videos).toHaveLength(3);
    expect(google.youtube().playlistItems.list).toHaveBeenCalledTimes(2);
    // Second call should pass the page token
    expect(google.youtube().playlistItems.list.mock.calls[1][0]).toMatchObject({
      pageToken: 'token1',
    });
  });

  test('returns empty array when Watch Later is empty', async () => {
    google.youtube().channels.list.mockResolvedValueOnce(
      makeChannelsListResponse(FAKE_WL_PLAYLIST_ID)
    );
    google.youtube().playlistItems.list.mockResolvedValueOnce(
      makePlaylistItemsListResponse([])
    );

    const videos = await getWatchLaterVideos({});

    expect(videos).toEqual([]);
  });

  test('uses the real playlist ID from channel info, not the WL shorthand', async () => {
    google.youtube().channels.list.mockResolvedValueOnce(
      makeChannelsListResponse(FAKE_WL_PLAYLIST_ID)
    );
    google.youtube().playlistItems.list.mockResolvedValueOnce(
      makePlaylistItemsListResponse([])
    );

    await getWatchLaterVideos({});

    expect(google.youtube().channels.list).toHaveBeenCalledWith(
      expect.objectContaining({ part: ['contentDetails'], mine: true })
    );
    expect(google.youtube().playlistItems.list).toHaveBeenCalledWith(
      expect.objectContaining({ playlistId: FAKE_WL_PLAYLIST_ID, part: ['snippet'] })
    );
  });

  test('throws when channel info does not contain a Watch Later playlist ID', async () => {
    google.youtube().channels.list.mockResolvedValueOnce({ data: { items: [] } });

    await expect(getWatchLaterVideos({})).rejects.toThrow(
      'Could not retrieve Watch Later playlist ID from channel info.'
    );
  });
});

// ---------------------------------------------------------------------------
// addToWatchLater
// ---------------------------------------------------------------------------
describe('addToWatchLater', () => {
  const videos = [
    { videoId: 'v1', title: 'Video 1' },
    { videoId: 'v2', title: 'Video 2' },
    { videoId: 'v3', title: 'Video 3' },
  ];

  test('adds all videos successfully and returns correct counts', async () => {
    google.youtube().playlistItems.insert.mockResolvedValue({ data: {} });

    const result = await addToWatchLater({}, videos);

    expect(result.added).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(google.youtube().playlistItems.insert).toHaveBeenCalledTimes(3);
  });

  test('records failures without throwing and continues processing', async () => {
    google.youtube().playlistItems.insert
      .mockResolvedValueOnce({ data: {} })       // v1 success
      .mockRejectedValueOnce(new Error('quota'))  // v2 failure
      .mockResolvedValueOnce({ data: {} });        // v3 success

    const result = await addToWatchLater({}, videos);

    expect(result.added).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ videoId: 'v2', title: 'Video 2', error: 'quota' });
  });

  test('inserts videos into the Watch Later playlist (WL)', async () => {
    google.youtube().playlistItems.insert.mockResolvedValue({ data: {} });

    await addToWatchLater({}, [{ videoId: 'abc', title: 'Test' }]);

    expect(google.youtube().playlistItems.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          snippet: expect.objectContaining({ playlistId: 'WL' }),
        }),
      })
    );
  });

  test('invokes the onProgress callback for each video', async () => {
    google.youtube().playlistItems.insert
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(new Error('err'));

    const onProgress = jest.fn();
    await addToWatchLater({}, videos.slice(0, 2), onProgress);

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, 1, 2, 'Video 1', true);
    expect(onProgress).toHaveBeenNthCalledWith(2, 2, 2, 'Video 2', false);
  });

  test('returns empty result for empty video list', async () => {
    const result = await addToWatchLater({}, []);

    expect(result.added).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(google.youtube().playlistItems.insert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// sleep (utility)
// ---------------------------------------------------------------------------
describe('sleep', () => {
  test('resolves after at least the specified duration', async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40); // small tolerance
  });
});

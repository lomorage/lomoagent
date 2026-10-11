import { Router } from 'express';
import { lomoFetch } from '../http-agent';
import { fetchAssetSummaries, isFavoriteStatus } from '../lomo-assets';
import { getLomoToken } from '../session';
import { clearAlbumBucketCache } from './timeline';

// LOMO_URL is now per-session via auth.serverUrl

export const albumsRouter = Router();

// Cache for album list, keyed by session (serverUrl + userId) so a previous
// local/remote session can never leak its albums into the current one.
const albumListCache = new Map<string, { data: any[]; timestamp: number }>();
const ALBUM_LIST_CACHE_TTL = 30_000; // 30 seconds

function albumListCacheKey(serverUrl: string, userId: string): string {
  return `${serverUrl}\0${userId}`;
}

// lomod's own album list (titles only), per session too. Opening an album needs its title,
// and lomod only lists all albums, so caching it makes opening albums fast.
const lomoAlbumsCache = new Map<string, { albums: LomoAlbum[]; timestamp: number }>();
const lomoAlbumsInflight = new Map<string, Promise<LomoAlbum[]>>();
let lomoAlbumsGeneration = 0;

export function clearAlbumListCache() {
  albumListCache.clear();
  lomoAlbumsCache.clear();
  lomoAlbumsInflight.clear();
  lomoAlbumsGeneration++;
}

class LomoAlbumsError extends Error {
  constructor(readonly status: number, body: string) {
    super(`lomod album list failed: ${status} ${body.slice(0, 200)}`);
  }
}

/** lomod's album list for this session, from the cache when fresh. Throws LomoAlbumsError. */
async function getLomoAlbums(auth: LomoAuth): Promise<LomoAlbum[]> {
  const key = albumListCacheKey(auth.serverUrl, auth.userId);
  const cached = lomoAlbumsCache.get(key);
  if (cached && Date.now() - cached.timestamp < ALBUM_LIST_CACHE_TTL) {
    return cached.albums;
  }

  let inflight = lomoAlbumsInflight.get(key);
  if (!inflight) {
    const generation = lomoAlbumsGeneration;
    inflight = (async () => {
      const lomoRes = await lomoFetch(`${auth.serverUrl}/album?token=${auth.token}`);
      if (!lomoRes.ok) {
        throw new LomoAlbumsError(lomoRes.status, await lomoRes.text().catch(() => ''));
      }
      const albums = ((await lomoRes.json()) as LomoAlbumList).Albums || [];
      // A change made while this was in flight cleared the cache; don't put the old list back
      if (generation === lomoAlbumsGeneration) {
        lomoAlbumsCache.set(key, { albums, timestamp: Date.now() });
      }
      return albums;
    })().finally(() => {
      if (lomoAlbumsInflight.get(key) === inflight) {
        lomoAlbumsInflight.delete(key);
      }
    });
    lomoAlbumsInflight.set(key, inflight);
  }
  return inflight;
}

/** After a change to albums: album lists, counts, thumbnails and album timelines are stale. */
function albumsChanged() {
  clearAlbumListCache();
  clearAlbumBucketCache();
}

interface LomoAlbum {
  ID: number;
  Title: string;
  Description: string;
  Author: string;
  CreateTime: string;
  LastModifiedTime: string;
}

interface LomoAlbumList {
  Albums: LomoAlbum[];
}

function isImageExt(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'bmp', 'tiff', 'dng', 'raw'].includes(ext);
}

function buildOwner(userId: string, username: string) {
  return {
    id: userId,
    name: username,
    email: username,
    profileImagePath: '',
    avatarColor: 'primary',
  };
}

function toAlbumResponseDto(
  album: LomoAlbum,
  userId: string,
  username: string,
  assetCount: number,
  thumbnailAssetId: string | null,
  assets: any[] = [],
) {
  return {
    id: String(album.ID),
    albumName: album.Title,
    albumThumbnailAssetId: thumbnailAssetId,
    albumUsers: [],
    assetCount,
    assets,
    createdAt: album.CreateTime,
    description: album.Description || '',
    hasSharedLink: false,
    isActivityEnabled: false,
    order: 'desc',
    owner: buildOwner(userId, username),
    ownerId: userId,
    shared: false,
    startDate: undefined,
    endDate: undefined,
    updatedAt: album.LastModifiedTime,
  };
}

type LomoAuth = { token: string; userId: string; username: string; serverUrl: string };

/**
 * Build an Immich album summary (count + thumbnail) for a lomo album.
 * Shared by the full list and the per-asset ("appears in") list.
 */
async function buildAlbumSummary(album: LomoAlbum, auth: LomoAuth) {
  let assetCount = 0;
  let thumbnailAssetId: string | null = null;

  try {
    // Get asset count via HEAD
    const headRes = await lomoFetch(`${auth.serverUrl}/album/${album.ID}/assets?token=${auth.token}`, {
      method: 'HEAD',
    });
    const countHeader = headRes.headers.get('x-total-count');
    if (countHeader) {
      assetCount = parseInt(countHeader, 10);
    }

    // Get first asset for thumbnail
    if (assetCount > 0) {
      const assetsRes = await lomoFetch(
        `${auth.serverUrl}/album/${album.ID}/assets?token=${auth.token}&page=0&limit=1`,
      );
      if (assetsRes.ok) {
        const assetNames = await assetsRes.json() as string[];
        if (assetNames.length > 0) {
          thumbnailAssetId = assetNames[0];
        }
      }
    }
  } catch (e) {
    console.error(`[albums] error fetching details for album ${album.ID}:`, e);
  }

  return toAlbumResponseDto(album, auth.userId, auth.username, assetCount, thumbnailAssetId);
}

/**
 * GET /api/albums
 * List all albums
 */
albumsRouter.get('/', async (req, res) => {
  const auth = getLomoToken(req);
  if (!auth) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  // Immich frontend requests shared=true separately — lomo has no sharing
  if (req.query.shared === 'true') {
    return res.json([]);
  }

  // Immich's detail panel asks "which albums contain this asset" via ?assetId=.
  // lomo has a dedicated endpoint for that; without it we'd return every album
  // (and stale ones), so clicking a phantom album later 401s. See lomo-backend
  // GET /asset/album/{assetID}.
  const assetId = req.query.assetId as string | undefined;
  if (assetId) {
    try {
      const lomoRes = await lomoFetch(
        `${auth.serverUrl}/asset/album/${encodeURIComponent(assetId)}?token=${auth.token}`,
      );
      if (!lomoRes.ok) {
        console.error(`[albums] asset-albums failed for ${assetId}: ${lomoRes.status}`);
        return res.status(lomoRes.status).json({ message: 'Failed to fetch albums' });
      }
      const data = await lomoRes.json() as LomoAlbumList;
      const albums = data.Albums || [];
      const results = await Promise.all(
        albums.map((album) => buildAlbumSummary(album, auth)),
      );
      return res.json(results);
    } catch (error) {
      console.error(`[albums] asset-albums error for ${assetId}:`, error);
      return res.status(500).json({ message: 'Internal error' });
    }
  }

  const cacheKey = albumListCacheKey(auth.serverUrl, auth.userId);

  try {
    // Return cached list if fresh
    const cached = albumListCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < ALBUM_LIST_CACHE_TTL) {
      return res.json(cached.data);
    }

    const albums = await getLomoAlbums(auth);

    // Fetch asset count and first asset for each album in parallel
    const results = await Promise.all(
      albums.map((album) => buildAlbumSummary(album, auth)),
    );

    // Cache the result for this session
    albumListCache.set(cacheKey, { data: results, timestamp: Date.now() });

    res.json(results);
  } catch (error) {
    if (error instanceof LomoAlbumsError) {
      console.error(`[albums] ${error.message}`);
      return res.status(error.status).json({ message: 'Failed to fetch albums' });
    }
    console.error('[albums] list error:', error);
    res.status(500).json({ message: 'Internal error' });
  }
});

/**
 * GET /api/albums/:id
 * Album detail
 */
albumsRouter.get('/:id', async (req, res) => {
  const auth = getLomoToken(req);
  if (!auth) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  const albumId = req.params.id;
  console.log(`[albums] GET detail: albumId=${albumId}, withoutAssets=${req.query.withoutAssets}`);

  try {
    const withoutAssets = req.query.withoutAssets === 'true';

    // Opening an album (withoutAssets) needs just what the album list has: answer from it
    // when it's cached, e.g. right after the albums page or the sidebar loaded it.
    if (withoutAssets) {
      const cachedList = albumListCache.get(albumListCacheKey(auth.serverUrl, auth.userId));
      const cachedAlbum = cachedList && Date.now() - cachedList.timestamp < ALBUM_LIST_CACHE_TTL
        ? cachedList.data.find((a) => a.id === albumId)
        : undefined;
      if (cachedAlbum) {
        return res.json(cachedAlbum);
      }
    }

    // Get album info, the asset count and the first asset (the thumbnail) all at once
    const [albums, headRes, firstRes] = await Promise.all([
      getLomoAlbums(auth),
      lomoFetch(`${auth.serverUrl}/album/${albumId}/assets?token=${auth.token}`, { method: 'HEAD' }),
      withoutAssets
        ? lomoFetch(`${auth.serverUrl}/album/${albumId}/assets?token=${auth.token}&page=0&limit=1`)
        : undefined,
    ]);
    const album = albums.find((a) => String(a.ID) === albumId);
    if (!album) {
      return res.status(404).json({ message: 'Album not found' });
    }

    let assetCount = 0;
    const countHeader = headRes.headers.get('x-total-count');
    if (countHeader) {
      assetCount = parseInt(countHeader, 10);
    }

    // Get assets if not explicitly excluded
    let assets: any[] = [];
    let thumbnailAssetId: string | null = null;

    if (!withoutAssets && assetCount > 0) {
      const assetsRes = await lomoFetch(
        `${auth.serverUrl}/album/${albumId}/assets?token=${auth.token}&page=0&limit=10000`,
      );
      if (assetsRes.ok) {
        const assetNames = await assetsRes.json() as string[];
        const summaries = await fetchAssetSummaries(auth.serverUrl, auth.token, assetNames);
        thumbnailAssetId = summaries[0]?.name || null;
        assets = summaries.map((asset) => ({
          id: asset.name,
          deviceAssetId: asset.name,
          ownerId: auth.userId,
          deviceId: 'lomo',
          type: isImageExt(asset.name) ? 'IMAGE' : 'VIDEO',
          originalPath: asset.name,
          originalFileName: asset.name,
          originalMimeType: isImageExt(asset.name) ? 'image/jpeg' : 'video/mp4',
          thumbhash: null,
          fileCreatedAt: asset.date,
          fileModifiedAt: asset.date,
          createdAt: asset.date,
          updatedAt: asset.date,
          isFavorite: isFavoriteStatus(asset.status),
          isArchived: false,
          duration: '0:00:00.000000',
          checksum: '',
          stackCount: null,
          exifInfo: {},
        }));
      }
    } else if (assetCount > 0 && firstRes?.ok) {
      // Just the first asset, for the thumbnail
      const assetNames = await firstRes.json() as string[];
      thumbnailAssetId = assetNames[0] || null;
    }

    const result = toAlbumResponseDto(album, auth.userId, auth.username, assetCount, thumbnailAssetId, assets);
    console.log(`[albums] detail response: id=${result.id}, assetCount=${result.assetCount}, albumName=${result.albumName}`);
    res.json(result);
  } catch (error) {
    if (error instanceof LomoAlbumsError) {
      console.error(`[albums] detail: albumId=${albumId} ${error.message}`);
      return res.status(error.status).json({ message: 'Failed to fetch albums' });
    }
    console.error('[albums] detail error:', error);
    res.status(500).json({ message: 'Internal error' });
  }
});

/**
 * POST /api/albums
 * Create album
 */
albumsRouter.post('/', async (req, res) => {
  const auth = getLomoToken(req);
  if (!auth) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  try {
    const { albumName, description } = req.body;
    const lomoRes = await lomoFetch(`${auth.serverUrl}/album?token=${auth.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Title: albumName || 'Untitled',
        Description: description || '',
        Author: auth.username,
      }),
    });

    if (!lomoRes.ok) {
      const errorText = await lomoRes.text();
      console.error(`[albums] create failed: ${lomoRes.status} ${errorText}`);
      return res.status(lomoRes.status).json({ message: 'Failed to create album' });
    }

    albumsChanged();
    const album = await lomoRes.json() as LomoAlbum;
    res.status(201).json(toAlbumResponseDto(album, auth.userId, auth.username, 0, null));
  } catch (error) {
    console.error('[albums] create error:', error);
    res.status(500).json({ message: 'Internal error' });
  }
});

/**
 * PATCH /api/albums/:id
 * Update album
 */
albumsRouter.patch('/:id', async (req, res) => {
  const auth = getLomoToken(req);
  if (!auth) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  const albumId = req.params.id;

  try {
    const { albumName, description } = req.body;
    const updateBody: any = { ID: parseInt(albumId, 10) };
    if (albumName !== undefined) updateBody.Title = albumName;
    if (description !== undefined) updateBody.Description = description;

    const lomoRes = await lomoFetch(`${auth.serverUrl}/album?token=${auth.token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updateBody),
    });

    if (!lomoRes.ok) {
      const errorText = await lomoRes.text();
      console.error(`[albums] update failed: ${lomoRes.status} ${errorText}`);
      return res.status(lomoRes.status).json({ message: 'Failed to update album' });
    }

    // Fetch the updated album to return
    albumsChanged();
    const album = (await getLomoAlbums(auth)).find((a) => String(a.ID) === albumId);

    if (album) {
      res.json(toAlbumResponseDto(album, auth.userId, auth.username, 0, null));
    } else {
      res.json({ id: albumId });
    }
  } catch (error) {
    console.error('[albums] update error:', error);
    res.status(500).json({ message: 'Internal error' });
  }
});

/**
 * DELETE /api/albums/:id
 * Delete album
 */
albumsRouter.delete('/:id', async (req, res) => {
  const auth = getLomoToken(req);
  if (!auth) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  try {
    const lomoRes = await lomoFetch(`${auth.serverUrl}/album/${req.params.id}?token=${auth.token}`, {
      method: 'DELETE',
    });

    if (!lomoRes.ok) {
      console.error(`[albums] delete failed: ${lomoRes.status}`);
      return res.status(lomoRes.status).json({ message: 'Failed to delete album' });
    }
    albumsChanged();

    res.status(200).json({});
  } catch (error) {
    console.error('[albums] delete error:', error);
    res.status(500).json({ message: 'Internal error' });
  }
});

/**
 * PUT /api/albums/:id/assets
 * Add assets to album
 */
albumsRouter.put('/:id/assets', async (req, res) => {
  const auth = getLomoToken(req);
  if (!auth) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  try {
    // Immich sends {ids: ["1.jpg", "2.jpg"]}
    const { ids } = req.body;
    // Lomo expects ["1", "2"] (just the numeric part, without extension)
    const assetIds = (ids || []).map((id: string) => {
      const dotIdx = id.lastIndexOf('.');
      return dotIdx > 0 ? id.substring(0, dotIdx) : id;
    });

    const lomoRes = await lomoFetch(`${auth.serverUrl}/album/${req.params.id}/assets?token=${auth.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(assetIds),
    });

    if (!lomoRes.ok) {
      const errorText = await lomoRes.text();
      console.error(`[albums] add assets failed: ${lomoRes.status} ${errorText}`);
      return res.status(lomoRes.status).json({ message: 'Failed to add assets' });
    }
    albumsChanged();

    // Return success response matching Immich format
    const results = (ids || []).map((id: string) => ({
      id,
      success: true,
      error: undefined,
    }));
    res.json(results);
  } catch (error) {
    console.error('[albums] add assets error:', error);
    res.status(500).json({ message: 'Internal error' });
  }
});

/**
 * DELETE /api/albums/:id/assets
 * Remove assets from album
 */
albumsRouter.delete('/:id/assets', async (req, res) => {
  const auth = getLomoToken(req);
  if (!auth) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  try {
    const { ids } = req.body;
    const assetIds = (ids || []).map((id: string) => {
      const dotIdx = id.lastIndexOf('.');
      return dotIdx > 0 ? id.substring(0, dotIdx) : id;
    });

    const lomoRes = await lomoFetch(`${auth.serverUrl}/album/${req.params.id}/assets?token=${auth.token}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(assetIds),
    });

    if (!lomoRes.ok) {
      const errorText = await lomoRes.text();
      console.error(`[albums] remove assets failed: ${lomoRes.status} ${errorText}`);
      return res.status(lomoRes.status).json({ message: 'Failed to remove assets' });
    }
    albumsChanged();

    const results = (ids || []).map((id: string) => ({
      id,
      success: true,
      error: undefined,
    }));
    res.json(results);
  } catch (error) {
    console.error('[albums] remove assets error:', error);
    res.status(500).json({ message: 'Internal error' });
  }
});

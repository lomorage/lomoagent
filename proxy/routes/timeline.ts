import { Router } from 'express';
import { lomoFetch } from '../http-agent';
import { getCachedAssetRatios, prefetchMissingAssetRatios, type AssetCacheEntry } from '../dimensions-cache';
import {
  fetchAlbumAssetNames,
  fetchAssetDateInfos,
  fetchAssetStatusMapForDates,
  isFavoriteStatus,
  type LomoAssetDateInfo,
  parseBooleanQueryValue,
} from '../lomo-assets';
import { getLomoToken } from '../session';

export const timelineRouter = Router();

// Lomo merkletree types
interface LomoAsset {
  Date: string;
  Device: string;
  Status: number;
  Hash: string;
  Name: string;
}

interface LomoDay {
  Assets?: LomoAsset[];
  Day: number;
  Hash: string;
}

interface LomoMonth {
  Days: LomoDay[];
  Hash: string;
  Month: number;
}

interface LomoYear {
  Hash: string;
  Months: LomoMonth[];
  Year: number;
}

interface LomoYearList {
  Hash: string;
  Years: LomoYear[];
}

interface LomoMonthDetail {
  Days: LomoDay[];
  Hash: string;
  Month: number;
}

type TimelineBucket = {
  timeBucket: string;
  count: number;
};

function needsMonthDetail(entry: { days: LomoDay[] }): boolean {
  return entry.days.length === 0
    || entry.days.some((day) => !Array.isArray(day.Assets))
    || !entry.days.some((day) => (day.Assets || []).length > 0);
}

class UpstreamHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function isImageExt(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'bmp', 'tiff', 'dng', 'raw'].includes(ext);
}

function isVideoExt(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return ['mp4', 'mov', 'avi', 'mkv', 'webm', '3gp', 'wmv', 'flv'].includes(ext);
}

// Cache for album assets grouped by month, keyed by serverUrl\0albumId so
// numeric album IDs can't collide across servers / sessions.
const albumBucketCache = new Map<string, {
  data: Map<string, LomoAssetDateInfo[]>;
  timestamp: number;
}>();

function albumBucketCacheKey(serverUrl: string, albumId: string): string {
  return `${serverUrl}\0${albumId}`;
}
const ALBUM_CACHE_TTL = 60_000; // 60 seconds
const TIMELINE_BUCKET_CACHE_TTL = 60_000; // 60 seconds
const timelineBucketCache = new Map<string, {
  data: TimelineBucket[];
  timestamp: number;
}>();
const timelineBucketInflight = new Map<string, Promise<TimelineBucket[]>>();
let timelineBucketCacheGeneration = 0;

// Per-bucket content cache: caches the fully-assembled bucket response for fast repeat access
// and pre-warmed adjacent months. Key: serverUrl\0userId\0year\0month\0favoriteFilter
const BUCKET_CONTENT_CACHE_TTL = 120_000; // 2 minutes
const bucketContentCache = new Map<string, { data: object; timestamp: number }>();

function bucketContentCacheKey(
  serverUrl: string,
  userId: string,
  year: number,
  month: number,
  favoriteFilter: boolean | undefined,
): string {
  return [serverUrl, userId, year, month, favoriteFilter === undefined ? 'all' : String(favoriteFilter)].join('\0');
}

export function clearAlbumBucketCache() {
  albumBucketCache.clear();
  timelineBucketCache.clear();
  timelineBucketInflight.clear();
  bucketContentCache.clear();
  timelineBucketCacheGeneration += 1;
}

function offsetMonthBucket(timeBucket: string, delta: number): string {
  const d = new Date(timeBucket);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00.000Z`;
}

function getTimelineBucketCacheKey(
  serverUrl: string,
  token: string,
  userId: string,
  favoriteFilter: boolean | undefined,
): string {
  return [serverUrl, token, userId, favoriteFilter === undefined ? 'all' : String(favoriteFilter)].join('\0');
}

async function fetchTimelineBuckets(
  serverUrl: string,
  token: string,
  favoriteFilter: boolean | undefined,
): Promise<TimelineBucket[]> {
  const lomoRes = await lomoFetch(`${serverUrl}/assets/merkletree?token=${token}`);
  if (!lomoRes.ok) {
    console.error(`[timeline] merkletree failed: ${lomoRes.status}`);
    throw new UpstreamHttpError(lomoRes.status, 'Failed to fetch assets');
  }

  const data = await lomoRes.json() as LomoYearList;
  const years = data.Years || [];
  console.log(`[timeline] merkletree from ${serverUrl}: years=${years.length}`);

  // Collect all year/month pairs from the root tree
  const monthEntries: Array<{ year: number; month: number; days: LomoDay[] }> = [];
  for (const year of years) {
    for (const month of year.Months || []) {
      monthEntries.push({ year: year.Year, month: month.Month, days: month.Days || [] });
    }
  }

  // If the root tree doesn't include asset detail, fetch month detail.
  // Favorites depend on the per-asset Status bit, so day hashes alone are not enough.
  const entriesNeedingDetail = monthEntries.filter(needsMonthDetail);
  if (entriesNeedingDetail.length > 0) {
    console.log(`[timeline] root tree missing asset detail, fetching ${entriesNeedingDetail.length} month(s) individually`);
    await Promise.all(
      entriesNeedingDetail.map(async (entry) => {
        try {
          const res = await lomoFetch(
            `${serverUrl}/assets/merkletree/${entry.year}/${entry.month}?token=${token}`,
          );
          if (res.ok) {
            const monthData = await res.json() as LomoMonthDetail;
            entry.days = monthData.Days || [];
          }
        } catch {
          // leave days empty for this month
        }
      }),
    );
  }

  const buckets: TimelineBucket[] = [];

  for (const entry of monthEntries) {
    let count = 0;
    for (const day of entry.days) {
      for (const asset of day.Assets || []) {
        if (favoriteFilter === undefined || isFavoriteStatus(asset.Status) === favoriteFilter) {
          count += 1;
        }
      }
    }
    if (count > 0) {
      const mm = String(entry.month).padStart(2, '0');
      buckets.push({ timeBucket: `${entry.year}-${mm}-01T00:00:00.000Z`, count });
    }
  }

  // Sort descending (newest first) — Immich default
  buckets.sort((a, b) => b.timeBucket.localeCompare(a.timeBucket));
  console.log(`[timeline] returning ${buckets.length} buckets`);

  // NOTE: no whole-library thumbhash sweep here. It used to queue *every* asset
  // (concurrency 16), flooding the backend and starving the visible grid. Ratios
  // and thumbhashes are now filled lazily per visible bucket (see bucket-content
  // and adjacent pre-warm below) and from each served grid thumbnail buffer.

  return buckets;
}

async function getCachedTimelineBuckets(
  serverUrl: string,
  token: string,
  userId: string,
  favoriteFilter: boolean | undefined,
): Promise<TimelineBucket[]> {
  const cacheKey = getTimelineBucketCacheKey(serverUrl, token, userId, favoriteFilter);
  const cached = timelineBucketCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < TIMELINE_BUCKET_CACHE_TTL) {
    return cached.data;
  }

  const existing = timelineBucketInflight.get(cacheKey);
  if (existing) {
    return existing;
  }

  const generation = timelineBucketCacheGeneration;
  const pending = fetchTimelineBuckets(serverUrl, token, favoriteFilter)
    .then((buckets) => {
      if (generation === timelineBucketCacheGeneration) {
        timelineBucketCache.set(cacheKey, { data: buckets, timestamp: Date.now() });
      }
      return buckets;
    })
    .finally(() => {
      timelineBucketInflight.delete(cacheKey);
    });

  timelineBucketInflight.set(cacheKey, pending);
  return pending;
}

/**
 * Fetch all asset names in an album, then fetch metadata to get dates.
 * Returns assets grouped by YYYY-MM bucket. Results are cached per album.
 */
async function fetchAlbumAssetsByMonth(
  albumId: string,
  token: string,
  serverUrl: string,
): Promise<Map<string, LomoAssetDateInfo[]>> {
  // Check cache
  const cacheKey = albumBucketCacheKey(serverUrl, albumId);
  const cached = albumBucketCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < ALBUM_CACHE_TTL) {
    return cached.data;
  }

  // Get all asset names in the album
  const assetNames = await fetchAlbumAssetNames(serverUrl, token, albumId);
  const byMonth = new Map<string, LomoAssetDateInfo[]>();
  const assets = await fetchAssetDateInfos(serverUrl, token, assetNames);

  for (const asset of assets) {
    const d = new Date(asset.date);
    const year = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const bucket = `${year}-${mm}-01T00:00:00.000Z`;
    if (!byMonth.has(bucket)) {
      byMonth.set(bucket, []);
    }
    byMonth.get(bucket)!.push(asset);
  }

  // Store in cache
  albumBucketCache.set(cacheKey, { data: byMonth, timestamp: Date.now() });

  return byMonth;
}

/**
 * GET /api/timeline/buckets
 * Fetches full merkletree from lomo and converts to TimeBucketsResponseDto[]
 * Supports albumId query param for album-specific buckets.
 */
timelineRouter.get('/buckets', async (req, res) => {
  const auth = getLomoToken(req);
  if (!auth) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  const albumId = req.query.albumId as string | undefined;
  const favoriteFilter = parseBooleanQueryValue(req.query.isFavorite);

  try {
    if (albumId) {
      // Album-specific buckets
      const byMonth = await fetchAlbumAssetsByMonth(albumId, auth.token, auth.serverUrl);
      const bucketResults = await Promise.all(
        Array.from(byMonth.entries()).map(async ([bucket, assets]) => {
          if (favoriteFilter === undefined) {
            return { timeBucket: bucket, count: assets.length };
          }

          const statusMap = await fetchAssetStatusMapForDates(auth.serverUrl, auth.token, assets);
          const count = assets.filter((asset) => isFavoriteStatus(statusMap.get(asset.name) ?? 0) === favoriteFilter).length;
          return { timeBucket: bucket, count };
        }),
      );

      const buckets = bucketResults.filter((bucket) => bucket.count > 0);
      buckets.sort((a, b) => b.timeBucket.localeCompare(a.timeBucket));
      return res.json(buckets);
    }

    // Default: full merkletree buckets are expensive on lomod, so cache briefly.
    const buckets = await getCachedTimelineBuckets(auth.serverUrl, auth.token, auth.userId, favoriteFilter);
    res.json(buckets);
  } catch (error) {
    if (error instanceof UpstreamHttpError) {
      return res.status(error.status).json({ message: error.message });
    }

    console.error('[timeline] buckets error:', error);
    res.status(500).json({ message: 'Internal error' });
  }
});

/**
 * GET /api/timeline/bucket?timeBucket=YYYY-MM-DDT00:00:00.000Z
 * Fetches a specific month from lomo merkletree and converts to TimeBucketAssetResponseDto
 */
timelineRouter.get('/bucket', async (req, res) => {
  const auth = getLomoToken(req);
  if (!auth) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  const timeBucket = req.query.timeBucket as string;
  if (!timeBucket) {
    return res.status(400).json({ message: 'timeBucket parameter required' });
  }

  const albumId = req.query.albumId as string | undefined;
  const favoriteFilter = parseBooleanQueryValue(req.query.isFavorite);

  // Parse year and month from timeBucket (e.g., "2024-03-01T00:00:00.000Z")
  const date = new Date(timeBucket);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1; // 1-indexed

  try {
    if (albumId) {
      // Album-specific bucket: fetch album assets and filter by month
      const byMonth = await fetchAlbumAssetsByMonth(albumId, auth.token, auth.serverUrl);
      const bucketKey = `${year}-${String(month).padStart(2, '0')}-01T00:00:00.000Z`;
      const assets = byMonth.get(bucketKey) || [];
      const statusMap = await fetchAssetStatusMapForDates(auth.serverUrl, auth.token, assets);
      const filteredAssets =
        favoriteFilter === undefined
          ? assets
          : assets.filter((asset) => isFavoriteStatus(statusMap.get(asset.name) ?? 0) === favoriteFilter);

      const albumAssets = filteredAssets.map(a => ({ name: a.name, hash: a.hash }));
      const albumCacheMap = await getCachedAssetRatios(albumAssets, auth.serverUrl);
      prefetchMissingAssetRatios(albumAssets, auth.token, auth.serverUrl);

      const result = {
        id: filteredAssets.map(a => a.name),
        city: filteredAssets.map(() => null),
        country: filteredAssets.map(() => null),
        duration: filteredAssets.map(a => isVideoExt(a.name) ? '0:00:00.000000' : null),
        fileCreatedAt: filteredAssets.map(a => a.date),
        isFavorite: filteredAssets.map(a => isFavoriteStatus(statusMap.get(a.name) ?? 0)),
        isImage: filteredAssets.map(a => isImageExt(a.name)),
        isTrashed: filteredAssets.map(() => false),
        livePhotoVideoId: filteredAssets.map(() => null),
        localOffsetHours: filteredAssets.map(() => 0),
        ownerId: filteredAssets.map(() => auth.userId),
        projectionType: filteredAssets.map(() => null),
        ratio: filteredAssets.map(a => albumCacheMap.get(a.name)?.ratio ?? (isVideoExt(a.name) ? 1.78 : 1.5)),
        thumbhash: filteredAssets.map(a => albumCacheMap.get(a.name)?.thumbhash ?? null),
        visibility: filteredAssets.map(() => 'timeline'),
      };

      return res.json(result);
    }

    // Check per-bucket content cache first (also populated by adjacent pre-warming)
    const contentCacheKey = bucketContentCacheKey(auth.serverUrl, auth.userId, year, month, favoriteFilter);
    const cachedContent = bucketContentCache.get(contentCacheKey);
    if (cachedContent && Date.now() - cachedContent.timestamp < BUCKET_CONTENT_CACHE_TTL) {
      return res.json(cachedContent.data);
    }

    const lomoRes = await lomoFetch(`${auth.serverUrl}/assets/merkletree/${year}/${month}?token=${auth.token}`);
    if (!lomoRes.ok) {
      console.error(`[timeline] bucket ${year}/${month} failed: ${lomoRes.status}`);
      return res.status(lomoRes.status).json({ message: 'Failed to fetch bucket' });
    }

    const data = await lomoRes.json() as LomoMonthDetail;

    // Flatten all assets from all days
    const allAssets: Array<{ asset: LomoAsset; day: number }> = [];
    for (const day of data.Days || []) {
      for (const asset of day.Assets || []) {
        allAssets.push({ asset, day: day.Day });
      }
    }
    const filteredAssets =
      favoriteFilter === undefined
        ? allAssets
        : allAssets.filter((entry) => isFavoriteStatus(entry.asset.Status) === favoriteFilter);

    const assetsForRatios = filteredAssets.map(a => ({ name: a.asset.Name, hash: a.asset.Hash }));
    const assetCacheMap = await getCachedAssetRatios(assetsForRatios, auth.serverUrl);
    prefetchMissingAssetRatios(assetsForRatios, auth.token, auth.serverUrl);

    // Build column-oriented response (TimeBucketAssetResponseDto)
    const result = {
      id: filteredAssets.map(a => a.asset.Name),
      city: filteredAssets.map(() => null),
      country: filteredAssets.map(() => null),
      duration: filteredAssets.map(a => isVideoExt(a.asset.Name) ? '0:00:00.000000' : null),
      fileCreatedAt: filteredAssets.map(a => a.asset.Date),
      isFavorite: filteredAssets.map(a => isFavoriteStatus(a.asset.Status)),
      isImage: filteredAssets.map(a => isImageExt(a.asset.Name)),
      isTrashed: filteredAssets.map(() => false),
      livePhotoVideoId: filteredAssets.map(() => null),
      localOffsetHours: filteredAssets.map(() => 0),
      ownerId: filteredAssets.map(() => auth.userId),
      projectionType: filteredAssets.map(() => null),
      ratio: filteredAssets.map(a => assetCacheMap.get(a.asset.Name)?.ratio ?? (isVideoExt(a.asset.Name) ? 1.78 : 1.5)),
      thumbhash: filteredAssets.map(a => assetCacheMap.get(a.asset.Name)?.thumbhash ?? null),
      visibility: filteredAssets.map(a => (a.asset.Status & 2) !== 0 ? 'hidden' : 'timeline'),
    };

    // Store in content cache
    bucketContentCache.set(contentCacheKey, { data: result, timestamp: Date.now() });

    res.json(result);

    // Pre-warm adjacent months in background (fire-and-forget)
    // This ensures the next/previous month is ready before the user scrolls to it
    setImmediate(() => {
      for (const delta of [-1, 1]) {
        const neighborBucket = offsetMonthBucket(timeBucket, delta);
        const neighborDate = new Date(neighborBucket);
        const neighborYear = neighborDate.getUTCFullYear();
        const neighborMonth = neighborDate.getUTCMonth() + 1;
        const neighborKey = bucketContentCacheKey(auth.serverUrl, auth.userId, neighborYear, neighborMonth, favoriteFilter);

        // Skip if already cached
        const neighborCached = bucketContentCache.get(neighborKey);
        if (neighborCached && Date.now() - neighborCached.timestamp < BUCKET_CONTENT_CACHE_TTL) {
          continue;
        }

        void (async () => {
          try {
            const r = await lomoFetch(`${auth.serverUrl}/assets/merkletree/${neighborYear}/${neighborMonth}?token=${auth.token}`);
            if (!r.ok) return;
            const neighborData = await r.json() as LomoMonthDetail;
            const neighborAllAssets: Array<{ asset: LomoAsset; day: number }> = [];
            for (const day of neighborData.Days || []) {
              for (const asset of day.Assets || []) {
                neighborAllAssets.push({ asset, day: day.Day });
              }
            }
            const neighborFiltered =
              favoriteFilter === undefined
                ? neighborAllAssets
                : neighborAllAssets.filter((entry) => isFavoriteStatus(entry.asset.Status) === favoriteFilter);

            if (neighborFiltered.length === 0) return;

            const neighborAssetsForRatios = neighborFiltered.map(a => ({ name: a.asset.Name, hash: a.asset.Hash }));
            const neighborCacheMap = await getCachedAssetRatios(neighborAssetsForRatios, auth.serverUrl);
            prefetchMissingAssetRatios(neighborAssetsForRatios, auth.token, auth.serverUrl);

            const neighborResult = {
              id: neighborFiltered.map(a => a.asset.Name),
              city: neighborFiltered.map(() => null),
              country: neighborFiltered.map(() => null),
              duration: neighborFiltered.map(a => isVideoExt(a.asset.Name) ? '0:00:00.000000' : null),
              fileCreatedAt: neighborFiltered.map(a => a.asset.Date),
              isFavorite: neighborFiltered.map(a => isFavoriteStatus(a.asset.Status)),
              isImage: neighborFiltered.map(a => isImageExt(a.asset.Name)),
              isTrashed: neighborFiltered.map(() => false),
              livePhotoVideoId: neighborFiltered.map(() => null),
              localOffsetHours: neighborFiltered.map(() => 0),
              ownerId: neighborFiltered.map(() => auth.userId),
              projectionType: neighborFiltered.map(() => null),
              ratio: neighborFiltered.map(a => neighborCacheMap.get(a.asset.Name)?.ratio ?? (isVideoExt(a.asset.Name) ? 1.78 : 1.5)),
              thumbhash: neighborFiltered.map(a => neighborCacheMap.get(a.asset.Name)?.thumbhash ?? null),
              visibility: neighborFiltered.map(a => (a.asset.Status & 2) !== 0 ? 'hidden' : 'timeline'),
            };

            bucketContentCache.set(neighborKey, { data: neighborResult, timestamp: Date.now() });
            console.log(`[timeline] pre-warmed bucket ${neighborYear}/${neighborMonth} (${neighborFiltered.length} assets)`);
          } catch {
            // Silent — pre-warming is best-effort
          }
        })();
      }
    });
  } catch (error) {
    console.error('[timeline] bucket error:', error);
    res.status(500).json({ message: 'Internal error' });
  }
});

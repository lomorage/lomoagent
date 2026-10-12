import { lomoFetch } from './http-agent';

const DEFAULT_ASSET_DATE = '2000-01-01T00:00:00Z';
const FAVORITE_STATUS_MASK = 8;

export interface LomoAssetDateInfo {
  name: string;
  date: string;
  hash?: string;
}

export interface LomoAssetSummary extends LomoAssetDateInfo {
  status: number;
}

interface LomoAssetMetadata {
  Date?: string;
  Hash?: string;
}

interface LomoDayDetail {
  Assets?: Array<{ Name: string; Status: number }>;
}

export function isFavoriteStatus(status: number): boolean {
  return (status & FAVORITE_STATUS_MASK) !== 0;
}

export function parseBooleanQueryValue(value: unknown): boolean | undefined {
  const rawValue = Array.isArray(value) ? value[0] : value;

  if (typeof rawValue === 'boolean') {
    return rawValue;
  }

  if (typeof rawValue !== 'string') {
    return undefined;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }

  return undefined;
}

// lomod's GET /album/{id}/assets returns this many asset names per page, whatever `limit` asks.
const ALBUM_ASSETS_PAGE_SIZE = 100;
const MAX_ALBUM_ASSET_PAGES = 1000;

/**
 * Every asset name in an album, newest first. lomod pages album assets 100 at a time, so read
 * the count (HEAD) and fetch all the pages at once.
 */
export async function fetchAlbumAssetNames(serverUrl: string, token: string, albumId: string): Promise<string[]> {
  const pageUrl = (page: number) => `${serverUrl}/album/${encodeURIComponent(albumId)}/assets?token=${token}&page=${page}`;
  const fetchPage = async (page: number): Promise<string[]> => {
    const res = await lomoFetch(pageUrl(page));
    if (!res.ok) {
      throw new Error(`Failed to fetch album assets: ${res.status}`);
    }
    return ((await res.json()) as string[] | null) ?? [];
  };

  const headRes = await lomoFetch(`${serverUrl}/album/${encodeURIComponent(albumId)}/assets?token=${token}`, {
    method: 'HEAD',
  });
  const total = Number.parseInt(headRes.headers.get('x-total-count') ?? '', 10);

  let pages: string[][];
  if (headRes.ok && Number.isFinite(total)) {
    const pageCount = Math.min(Math.ceil(total / ALBUM_ASSETS_PAGE_SIZE), MAX_ALBUM_ASSET_PAGES);
    pages = await Promise.all(Array.from({ length: pageCount }, (_, page) => fetchPage(page)));
  } else {
    // No count: read pages until a short one
    pages = [];
    for (let page = 0; page < MAX_ALBUM_ASSET_PAGES; page++) {
      const names = await fetchPage(page);
      pages.push(names);
      if (names.length < ALBUM_ASSETS_PAGE_SIZE) {
        break;
      }
    }
  }

  // An asset added or removed while paging can shift one across a page boundary
  return [...new Set(pages.flat())];
}

// Asset dates rarely change, and an album timeline needs one metadata request per asset to
// place it, so keep them for a while. Keyed by server, so local and remote never mix.
const ASSET_DATE_CACHE_TTL = 10 * 60_000;
const ASSET_DATE_CACHE_MAX = 100_000;
const ASSET_METADATA_CONCURRENCY = 32;
const assetDateCache = new Map<string, { info: LomoAssetDateInfo; timestamp: number }>();

function assetDateCacheKey(serverUrl: string, name: string): string {
  return `${serverUrl}\0${name}`;
}

/** Forget cached asset dates: the given assets on a server, or all of them. */
export function clearAssetDateCache(serverUrl?: string, names?: string[]): void {
  if (serverUrl === undefined || names === undefined) {
    assetDateCache.clear();
    return;
  }
  for (const name of names) {
    assetDateCache.delete(assetDateCacheKey(serverUrl, name));
  }
}

async function fetchAssetDateInfo(serverUrl: string, token: string, name: string): Promise<LomoAssetDateInfo> {
  try {
    const metaRes = await lomoFetch(`${serverUrl}/asset/metadata/${encodeURIComponent(name)}?token=${token}`);
    if (metaRes.ok) {
      const meta = await metaRes.json() as LomoAssetMetadata;
      const info = { name, date: meta.Date || DEFAULT_ASSET_DATE, hash: meta.Hash };
      if (assetDateCache.size >= ASSET_DATE_CACHE_MAX) {
        // Maps iterate in insertion order: drop the oldest entry
        const oldest = assetDateCache.keys().next().value;
        if (oldest !== undefined) {
          assetDateCache.delete(oldest);
        }
      }
      assetDateCache.set(assetDateCacheKey(serverUrl, name), { info, timestamp: Date.now() });
      return info;
    }
  } catch {
    // Ignore individual metadata failures and fall back to a stable default date.
  }

  // Not cached, so it is retried next time
  return { name, date: DEFAULT_ASSET_DATE };
}

/** The date (and hash) of each asset, in the given order: cached ones at once, the rest from lomod. */
export async function fetchAssetDateInfos(
  serverUrl: string,
  token: string,
  assetNames: string[],
): Promise<LomoAssetDateInfo[]> {
  const now = Date.now();
  const assets: LomoAssetDateInfo[] = new Array(assetNames.length);
  const missing: number[] = [];

  assetNames.forEach((name, index) => {
    const cached = assetDateCache.get(assetDateCacheKey(serverUrl, name));
    if (cached && now - cached.timestamp < ASSET_DATE_CACHE_TTL) {
      assets[index] = cached.info;
    } else {
      missing.push(index);
    }
  });

  // A fixed number of requests in flight: a slow one doesn't hold up a whole batch
  let next = 0;
  const worker = async () => {
    while (next < missing.length) {
      const index = missing[next++];
      assets[index] = await fetchAssetDateInfo(serverUrl, token, assetNames[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(ASSET_METADATA_CONCURRENCY, missing.length) }, worker));

  return assets;
}

export async function fetchAssetStatusMapForDates(
  serverUrl: string,
  token: string,
  assets: LomoAssetDateInfo[],
): Promise<Map<string, number>> {
  const dayRequests = new Map<string, { year: number; month: number; day: number }>();

  for (const asset of assets) {
    const date = new Date(asset.date);
    if (Number.isNaN(date.getTime())) {
      continue;
    }

    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const key = `${year}-${month}-${day}`;

    if (!dayRequests.has(key)) {
      dayRequests.set(key, { year, month, day });
    }
  }

  const dayResults = await Promise.all(
    Array.from(dayRequests.values()).map(async ({ year, month, day }) => {
      try {
        const res = await lomoFetch(`${serverUrl}/assets/merkletree/${year}/${month}/${day}?token=${token}`);
        if (!res.ok) {
          return [];
        }

        const dayData = await res.json() as LomoDayDetail;
        return dayData.Assets || [];
      } catch {
        return [];
      }
    }),
  );

  const statusByAssetName = new Map<string, number>();
  for (const dayAssets of dayResults) {
    for (const asset of dayAssets) {
      statusByAssetName.set(asset.Name, asset.Status);
    }
  }

  return statusByAssetName;
}

export async function fetchAssetSummaries(
  serverUrl: string,
  token: string,
  assetNames: string[],
): Promise<LomoAssetSummary[]> {
  const datedAssets = await fetchAssetDateInfos(serverUrl, token, assetNames);
  const statusMap = await fetchAssetStatusMapForDates(serverUrl, token, datedAssets);

  return datedAssets.map((asset) => ({
    ...asset,
    status: statusMap.get(asset.name) ?? 0,
  }));
}

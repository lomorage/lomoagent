import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import multer from 'multer';
import { lomoFetch } from '../http-agent';
import probe from 'probe-image-size';
import heicConvert from 'heic-convert';
// sharp is loaded lazily from NODE_PATH to work with pkg (native modules can't be in snapshot)
let _sharp: any = null;
function getSharp(): any {
  if (!_sharp) {
    const nodePath = process.env.NODE_PATH || '';
    if (nodePath) {
      const sharpPath = require('path').join(nodePath, 'sharp');
      // Use createRequire to load from outside pkg snapshot
      const { createRequire } = require('module');
      const externalRequire = createRequire(sharpPath + '/');
      _sharp = externalRequire(sharpPath);
    } else {
      _sharp = require('sharp');
    }
    console.log('[assets] sharp loaded successfully');
  }
  return _sharp;
}
import { cacheDimensions, readCachedThumbhash, computeAndStoreThumbhash } from '../dimensions-cache';
import { clearAssetDateCache, fetchAssetStatusMapForDates, isFavoriteStatus } from '../lomo-assets';
import { getLomoToken } from '../session';
import { clearAlbumBucketCache } from './timeline';
import { clearAlbumListCache } from './albums';

function isHeic(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return ext === 'heic' || ext === 'heif';
}

// Detect HEIC/HEIF by content (magic bytes), for files mislabeled with a .jpg/.png
// extension. ISO-BMFF layout: [4-byte box size]['ftyp'][4-byte major brand].
// Cheap: only inspects the first 12 bytes. Call this lazily — only after a normal
// decode has already failed — so the happy path pays nothing.
function looksLikeHeic(buf: Buffer): boolean {
  if (buf.length < 12 || buf.toString('ascii', 4, 8) !== 'ftyp') {
    return false;
  }
  const brand = buf.toString('ascii', 8, 12).toLowerCase();
  return ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'heif'].includes(brand);
}

async function heicBufferToJpeg(buf: Buffer, quality: number): Promise<Buffer> {
  const converted = await heicConvert({ buffer: buf, format: 'JPEG', quality } as any);
  return Buffer.from(converted);
}

/**
 * Fetch original asset from lomo and convert to JPEG.
 * For HEIC/HEIF files, uses heic-convert (pure JS) since sharp's Windows build
 * lacks the HEVC decoder plugin. Then resizes with sharp.
 */
async function sharpFallbackThumbnail(
  serverUrl: string,
  token: string,
  assetName: string,
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const origRes = await lomoFetch(`${serverUrl}/asset/${encodeURIComponent(assetName)}?token=${token}`, { signal });
  if (!origRes.ok) {
    throw new Error(`Failed to fetch original: ${origRes.status}`);
  }
  const buf = Buffer.from(await origRes.arrayBuffer());

  const s = getSharp();
  const resizeWidth = width > 0 ? width : undefined;
  const resizeHeight = height > 0 ? height : undefined;
  const encode = (input: Buffer) =>
    s(input)
      .resize(resizeWidth, resizeHeight, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

  // Known HEIC by extension: decode with the pure-JS decoder up front (sharp's
  // Windows build lacks the HEVC plugin, so attempting sharp first would just fail).
  if (isHeic(assetName)) {
    console.log(`[assets] heic-convert for ${assetName}`);
    return encode(await heicBufferToJpeg(buf, 0.8));
  }

  // Otherwise assume a normal sharp-decodable image (jpg/png/webp/…) — the happy
  // path, no magic-byte inspection. Only if sharp fails to decode do we check
  // whether this is actually a HEIC mislabeled with a .jpg/.png extension.
  try {
    return await encode(buf);
  } catch (error) {
    if (looksLikeHeic(buf)) {
      console.log(`[assets] ${assetName} decode failed; detected HEIC by content, using heic-convert`);
      return encode(await heicBufferToJpeg(buf, 0.8));
    }
    throw error;
  }
}

// LOMO_URL is now per-session via auth.serverUrl

const upload = multer({ storage: multer.memoryStorage() });

export const assetsRouter = Router();

type ThumbnailResult = {
  buffer: Buffer;
  contentType: string;
};

type ThumbnailCacheMeta = {
  contentType: string;
  createdAt: string;
};

const THUMBNAIL_CACHE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const THUMBNAIL_FETCH_CONCURRENCY = parsePositiveInteger(process.env.THUMBNAIL_FETCH_CONCURRENCY, 6);
// lomod pre-generates webp previews at native widths 75 / 320 / 640. Requesting a
// native width lets lomod serve the stored .webp file directly (no re-encode).
// 320 is the grid sweet spot: crisp (~10KB) and a static file.
const LOMO_THUMBNAIL_WIDTH = parsePositiveInteger(process.env.LOMO_THUMBNAIL_WIDTH, 320);
const LOMO_PREVIEW_WIDTH = parsePositiveInteger(process.env.LOMO_PREVIEW_WIDTH, 640);
// lomod's /asset/preview supports `icodec=webp` (see lomo-backend-api.md). Requesting
// webp makes lomod serve its pre-generated _<width>_0.webp file (smaller over the wire
// than JPEG — a real win in remote mode). Override with LOMO_IMAGE_CODEC=jpg if needed.
const LOMO_IMAGE_CODEC = (process.env.LOMO_IMAGE_CODEC || 'webp').trim();
const thumbnailInflight = new Map<string, Promise<ThumbnailResult>>();

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

class AsyncLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('Request aborted'));
          return;
        }

        const release = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const index = this.queue.indexOf(release);
          if (index >= 0) {
            this.queue.splice(index, 1);
          }
          reject(new Error('Request aborted'));
        };

        signal?.addEventListener('abort', onAbort, { once: true });
        this.queue.push(release);
      });
    }

    if (signal?.aborted) {
      throw new Error('Request aborted');
    }

    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

const thumbnailFetchLimiter = new AsyncLimiter(Math.max(1, THUMBNAIL_FETCH_CONCURRENCY));

function getThumbnailCacheDir(): string {
  const configDir = process.env.CONFIG_PATH ? path.dirname(process.env.CONFIG_PATH) : process.cwd();
  return path.join(configDir, 'thumbnail-cache');
}

function thumbnailCacheKey(serverUrl: string, assetName: string, width: number, height: number, size: string): string {
  // Codec is part of the key so switching JPEG<->webp doesn't serve stale entries.
  return createHash('sha1')
    .update(`${serverUrl}\0${assetName}\0${width}\0${height}\0${size}\0${LOMO_IMAGE_CODEC}`)
    .digest('hex');
}

function thumbnailCachePaths(cacheKey: string): { dataPath: string; metaPath: string } {
  const cacheDir = getThumbnailCacheDir();
  return {
    dataPath: path.join(cacheDir, `${cacheKey}.bin`),
    metaPath: path.join(cacheDir, `${cacheKey}.json`),
  };
}

async function readThumbnailCache(cacheKey: string): Promise<ThumbnailResult | null> {
  const { dataPath, metaPath } = thumbnailCachePaths(cacheKey);
  try {
    const [data, metaRaw] = await Promise.all([
      fs.promises.readFile(dataPath),
      fs.promises.readFile(metaPath, 'utf-8'),
    ]);
    const meta = JSON.parse(metaRaw) as ThumbnailCacheMeta;
    const createdAt = Date.parse(meta.createdAt);
    if (!meta.contentType || !Number.isFinite(createdAt)) {
      return null;
    }

    if (Date.now() - createdAt > THUMBNAIL_CACHE_MAX_AGE_SECONDS * 1000) {
      await Promise.all([
        fs.promises.rm(dataPath, { force: true }),
        fs.promises.rm(metaPath, { force: true }),
      ]);
      return null;
    }

    return { buffer: data, contentType: meta.contentType };
  } catch {
    return null;
  }
}

async function writeThumbnailCache(cacheKey: string, result: ThumbnailResult): Promise<void> {
  const cacheDir = getThumbnailCacheDir();
  const { dataPath, metaPath } = thumbnailCachePaths(cacheKey);
  const tmpDataPath = `${dataPath}.${process.pid}.${Date.now()}.tmp`;
  const tmpMetaPath = `${metaPath}.${process.pid}.${Date.now()}.tmp`;

  await fs.promises.mkdir(cacheDir, { recursive: true });
  await fs.promises.writeFile(tmpDataPath, result.buffer);
  await fs.promises.writeFile(
    tmpMetaPath,
    JSON.stringify({ contentType: result.contentType, createdAt: new Date().toISOString() } satisfies ThumbnailCacheMeta),
  );
  await fs.promises.rm(dataPath, { force: true });
  await fs.promises.rm(metaPath, { force: true });
  await fs.promises.rename(tmpDataPath, dataPath);
  await fs.promises.rename(tmpMetaPath, metaPath);
}

async function fetchThumbnailFromLomo(
  serverUrl: string,
  token: string,
  assetName: string,
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<ThumbnailResult> {
  const lomoRes = await lomoFetch(
    `${serverUrl}/asset/preview/${encodeURIComponent(assetName)}?token=${token}&width=${width}&height=${height}&icodec=${LOMO_IMAGE_CODEC}`,
    { signal },
  );

  if (lomoRes.ok) {
    const contentType = lomoRes.headers.get('content-type') || 'image/jpeg';
    return {
      buffer: Buffer.from(await lomoRes.arrayBuffer()),
      contentType,
    };
  }

  // Fallback: convert original with sharp (handles HEIC, etc.)
  console.log(`[assets] sharp fallback for thumbnail ${assetName}`);
  const buffer = await sharpFallbackThumbnail(serverUrl, token, assetName, width, height, signal);
  return { buffer, contentType: 'image/jpeg' };
}

async function getCachedThumbnail(
  serverUrl: string,
  token: string,
  assetName: string,
  width: number,
  height: number,
  size: string,
  signal?: AbortSignal,
): Promise<ThumbnailResult> {
  const cacheKey = thumbnailCacheKey(serverUrl, assetName, width, height, size);
  const cached = await readThumbnailCache(cacheKey);
  if (cached) {
    return cached;
  }

  const existing = thumbnailInflight.get(cacheKey);
  if (existing) {
    return existing;
  }

  const pending = thumbnailFetchLimiter
    .run(async () => {
      const cachedAfterQueue = await readThumbnailCache(cacheKey);
      if (cachedAfterQueue) {
        return cachedAfterQueue;
      }

      const result = await fetchThumbnailFromLomo(serverUrl, token, assetName, width, height, signal);
      await writeThumbnailCache(cacheKey, result).catch((error) => {
        console.warn(`[assets] thumbnail cache write failed for ${assetName}:`, error);
      });
      return result;
    }, signal)
    .finally(() => {
      thumbnailInflight.delete(cacheKey);
    });

  thumbnailInflight.set(cacheKey, pending);
  return pending;
}

/**
 * Full-resolution image for the full-screen photo view.
 *
 * Fast path: lomod transcodes the original to a full-res JPEG via `?icodec=jpg`.
 * Fallback: some servers' libvips lack the HEIF/HEVC loader, so for HEIC the
 * `icodec=jpg` transcode (and any JIT preview generation) returns HTTP 500
 * ("VipsForeignLoad: ... is not a known file format"). In that case we fetch the
 * raw original and decode it locally at full resolution (heic-convert + sharp),
 * exactly like the thumbnail path's sharp fallback. The result is cached so the
 * slow pure-JS HEIC decode (and, in remote mode, the network fetch) only runs
 * once per asset.
 */
async function getCachedFullResImage(
  serverUrl: string,
  token: string,
  assetName: string,
  signal?: AbortSignal,
): Promise<ThumbnailResult> {
  const cacheKey = thumbnailCacheKey(serverUrl, assetName, 0, 0, 'fullres');
  const cached = await readThumbnailCache(cacheKey);
  if (cached) {
    return cached;
  }

  const existing = thumbnailInflight.get(cacheKey);
  if (existing) {
    return existing;
  }

  const pending = thumbnailFetchLimiter
    .run(async () => {
      const cachedAfterQueue = await readThumbnailCache(cacheKey);
      if (cachedAfterQueue) {
        return cachedAfterQueue;
      }

      let result: ThumbnailResult;
      const lomoRes = await lomoFetch(
        `${serverUrl}/asset/${encodeURIComponent(assetName)}?token=${token}&icodec=jpg`,
        { signal },
      );
      const contentType = lomoRes.headers.get('content-type') || '';
      if (lomoRes.ok && contentType.startsWith('image/')) {
        result = { buffer: Buffer.from(await lomoRes.arrayBuffer()), contentType };
      } else {
        // Server can't transcode (e.g. libvips without the HEIF loader) — decode
        // locally at full resolution (width/height 0 = no downscaling).
        console.log(`[assets] full-res local decode for ${assetName} (lomod icodec=jpg ${lomoRes.status})`);
        const buffer = await sharpFallbackThumbnail(serverUrl, token, assetName, 0, 0, signal);
        result = { buffer, contentType: 'image/jpeg' };
      }

      await writeThumbnailCache(cacheKey, result).catch((error) => {
        console.warn(`[assets] full-res cache write failed for ${assetName}:`, error);
      });
      return result;
    }, signal)
    .finally(() => {
      thumbnailInflight.delete(cacheKey);
    });

  thumbnailInflight.set(cacheKey, pending);
  return pending;
}

function getMimeType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    heic: 'image/heic', heif: 'image/heif', webp: 'image/webp',
    gif: 'image/gif', bmp: 'image/bmp', tiff: 'image/tiff',
    mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
    mkv: 'video/x-matroska', webm: 'video/webm', '3gp': 'video/3gpp',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

function isImage(name: string): boolean {
  return getMimeType(name).startsWith('image/');
}

/**
 * GET /api/assets/:id/thumbnail
 * Proxies to lomo /asset/preview/{name}?token=X
 */
assetsRouter.get('/:id/thumbnail', async (req, res) => {
  const auth = getLomoToken(req);
  if (!auth) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  const abortController = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  const assetName = req.params.id;
  const size = req.query.size as string;

  // Full-screen photo view: serve the ORIGINAL at full resolution — no downscaling.
  // Prefers lomod's `?icodec=jpg` transcode, but falls back to a local full-res
  // HEIC decode when the server can't transcode (see getCachedFullResImage).
  // Videos fall through to a poster below.
  if (size === 'preview' && isImage(assetName)) {
    try {
      const image = await getCachedFullResImage(auth.serverUrl, auth.token, assetName, abortController.signal);
      if (abortController.signal.aborted) return;
      res.setHeader('Content-Type', image.contentType);
      res.setHeader('Content-Length', image.buffer.length);
      res.setHeader('Cache-Control', `public, max-age=${THUMBNAIL_CACHE_MAX_AGE_SECONDS}, immutable`);
      res.end(image.buffer);
    } catch (error) {
      if (abortController.signal.aborted) return;
      console.error(`[assets] full-res preview error for ${assetName}:`, error);
      res.status(500).end();
    }
    return;
  }

  // Map Immich sizes to lomo preview dimensions (grid thumbnail, or video poster).
  let width = LOMO_THUMBNAIL_WIDTH;
  let height = 0;
  if (size === 'preview') {
    // Video poster only (images are handled full-res above). 640 is lomod's largest
    // native webp width — served as a file, no re-encode.
    width = LOMO_PREVIEW_WIDTH;
    height = 0;
  }

  try {
    const thumbnail = await getCachedThumbnail(
      auth.serverUrl,
      auth.token,
      assetName,
      width,
      height,
      size || 'thumbnail',
      abortController.signal,
    );
    if (abortController.signal.aborted) {
      return;
    }
    res.setHeader('Content-Type', thumbnail.contentType);
    res.setHeader('Content-Length', thumbnail.buffer.length);
    res.setHeader('Cache-Control', `public, max-age=${THUMBNAIL_CACHE_MAX_AGE_SECONDS}, immutable`);
    res.end(thumbnail.buffer);

    // After sending the response: compute thumbhash from the buffer if not yet cached.
    // Zero extra HTTP cost — we already have the image. Fire-and-forget.
    if (!readCachedThumbhash(assetName, auth.serverUrl)) {
      computeAndStoreThumbhash(thumbnail.buffer, assetName, auth.serverUrl);
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      return;
    }
    console.error(`[assets] thumbnail error for ${assetName}:`, error);
    res.status(500).end();
  }
});

/**
 * GET /api/assets/:id/original
 * Proxies to lomo /asset/{name}?token=X
 */
assetsRouter.get('/:id/original', async (req, res) => {
  const auth = getLomoToken(req);
  if (!auth) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  const assetName = req.params.id;

  try {
    const lomoRes = await lomoFetch(
      `${auth.serverUrl}/asset/${encodeURIComponent(assetName)}?token=${auth.token}`
    );

    if (!lomoRes.ok) {
      console.error(`[assets] original ${assetName} failed: ${lomoRes.status}`);
      return res.status(lomoRes.status).end();
    }

    const contentType = lomoRes.headers.get('content-type');

    // Images: buffer so we can detect a HEIC mislabeled with a .jpg/.png extension.
    // Such a file streamed as image/jpeg can't be decoded by the browser ("Error
    // loading image"), so transcode it to real JPEG. Normal images are sent through
    // unchanged. Videos (and anything non-image) keep streaming — never buffered.
    if (isImage(assetName)) {
      const buf = Buffer.from(await lomoRes.arrayBuffer());
      let outBuf = buf;
      let outType = contentType || 'image/jpeg';
      if (looksLikeHeic(buf)) {
        console.log(`[assets] original ${assetName} is HEIC by content; transcoding to JPEG`);
        outBuf = await heicBufferToJpeg(buf, 0.9);
        outType = 'image/jpeg';
      }
      res.setHeader('Content-Type', outType);
      res.setHeader('Content-Length', outBuf.length);
      res.setHeader('Content-Disposition', `inline; filename="${assetName}"`);
      return res.end(outBuf);
    }

    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }
    const contentLength = lomoRes.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    res.setHeader('Content-Disposition', `inline; filename="${assetName}"`);

    lomoRes.body?.pipe(res);
  } catch (error) {
    console.error(`[assets] original error for ${assetName}:`, error);
    res.status(500).end();
  }
});

/**
 * GET /api/assets/:id/video/playback
 * Proxies to lomo /asset/{name}?token=X (same as original for video)
 */
assetsRouter.get('/:id/video/playback', async (req, res) => {
  const auth = getLomoToken(req);
  if (!auth) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  const assetName = req.params.id;

  try {
    const lomoRes = await lomoFetch(
      `${auth.serverUrl}/asset/${encodeURIComponent(assetName)}?token=${auth.token}`
    );

    if (!lomoRes.ok) {
      return res.status(lomoRes.status).end();
    }

    const contentType = lomoRes.headers.get('content-type') || getMimeType(assetName);
    res.setHeader('Content-Type', contentType);
    const contentLength = lomoRes.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    lomoRes.body?.pipe(res);
  } catch (error) {
    console.error(`[assets] playback error for ${assetName}:`, error);
    res.status(500).end();
  }
});

/**
 * GET /api/assets/:id
 * Fetches lomo asset metadata and converts to AssetResponseDto
 */
assetsRouter.get('/:id', async (req, res) => {
  const auth = getLomoToken(req);
  if (!auth) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  const assetName = req.params.id;

  try {
    const lomoRes = await lomoFetch(
      `${auth.serverUrl}/asset/metadata/${encodeURIComponent(assetName)}?token=${auth.token}`
    );

    if (!lomoRes.ok) {
      console.error(`[assets] metadata ${assetName} failed: ${lomoRes.status}`);
      return res.status(lomoRes.status).json({ message: 'Asset not found' });
    }

    const meta = await lomoRes.json() as {
      Date: string;
      Device: string;
      Hash: string;
      Name: string;
      Latitude?: string;
      Longtitude?: string; // Note: lomo API has typo "Longtitude"
    };

    const lat = meta.Latitude && meta.Latitude !== '888' ? parseFloat(meta.Latitude) : null;
    const lng = meta.Longtitude && meta.Longtitude !== '888' ? parseFloat(meta.Longtitude) : null;

    // Fetch favorite state from the backend day tree so the UI matches lomo-backend.
    const statusMap = await fetchAssetStatusMapForDates(auth.serverUrl, auth.token, [{ name: meta.Name, date: meta.Date }]);
    const isFavorite = isFavoriteStatus(statusMap.get(meta.Name) ?? 0);

    // Probe preview image to get actual dimensions
    let width: number | null = null;
    let height: number | null = null;
    try {
      const previewUrl = `${auth.serverUrl}/asset/preview/${encodeURIComponent(meta.Name)}?token=${auth.token}&width=1080&height=0`;
      const result = await probe(previewUrl);
      width = result.width;
      height = result.height;
      cacheDimensions({ name: meta.Name, hash: meta.Hash }, width, height, auth.serverUrl);
    } catch {
      // Fallback: fetch original and use sharp for dimensions (handles HEIC, etc.)
      try {
        const origRes = await lomoFetch(`${auth.serverUrl}/asset/${encodeURIComponent(meta.Name)}?token=${auth.token}`);
        if (origRes.ok) {
          const buf = Buffer.from(await origRes.arrayBuffer());
          const s = getSharp();
        const metadata = await s(buf).metadata();
          width = metadata.width || null;
          height = metadata.height || null;
          if (width && height) cacheDimensions({ name: meta.Name, hash: meta.Hash }, width, height, auth.serverUrl);
          console.log(`[assets] sharp metadata fallback for ${meta.Name}: ${width}x${height}`);
        }
      } catch (e2) {
        console.error(`[assets] sharp metadata fallback failed for ${meta.Name}:`, e2);
      }
    }

    // Build AssetResponseDto
    res.json({
      id: meta.Name,
      checksum: meta.Hash,
      createdAt: meta.Date,
      deviceAssetId: meta.Name,
      deviceId: meta.Device,
      duplicateId: null,
      duration: isImage(meta.Name) ? '0:00:00.000000' : '',
      exifInfo: {
        latitude: lat,
        longitude: lng,
        dateTimeOriginal: meta.Date,
        make: null,
        model: null,
        city: null,
        state: null,
        country: null,
        description: null,
        fileSizeInByte: null,
        exifImageWidth: width,
        exifImageHeight: height,
      },
      fileCreatedAt: meta.Date,
      fileModifiedAt: meta.Date,
      hasMetadata: true,
      height,
      isArchived: false,
      isEdited: false,
      isFavorite,
      isOffline: false,
      isTrashed: false,
      libraryId: null,
      livePhotoVideoId: null,
      localDateTime: meta.Date,
      originalFileName: meta.Name,
      originalMimeType: getMimeType(meta.Name),
      originalPath: meta.Name,
      ownerId: auth.userId,
      resized: true,
      stack: null,
      tags: [],
      thumbhash: null,
      type: isImage(meta.Name) ? 'IMAGE' : 'VIDEO',
      updatedAt: meta.Date,
      visibility: 'timeline',
      width,
    });
  } catch (error) {
    console.error(`[assets] metadata error for ${assetName}:`, error);
    res.status(500).json({ message: 'Internal error' });
  }
});

// POST /api/assets/bulk-upload-check
assetsRouter.post('/bulk-upload-check', async (req, res) => {
  // Always allow upload (no duplicate detection)
  const { assets } = req.body as { assets: Array<{ id: string; checksum: string }> };
  res.json({
    results: (assets || []).map((a) => ({
      id: a.id,
      action: 'accept',
      assetId: null,
      isTrashed: false,
    })),
  });
});

// POST /api/assets (upload)
assetsRouter.post('/', upload.single('assetData'), async (req, res) => {
  const auth = getLomoToken(req);
  if (!auth) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ message: 'No file provided' });
    }

    // Compute SHA-1 of the file
    const sha1 = createHash('sha1').update(file.buffer).digest('hex');
    const ext = file.originalname.split('.').pop()?.toLowerCase() || 'jpg';
    const modifiedTime = (req.body.fileCreatedAt || req.body.fileModifiedAt || new Date().toISOString());

    console.log(`[assets] upload: ${file.originalname} (${file.size} bytes), sha1=${sha1}, ext=${ext}`);

    const lomoRes = await lomoFetch(
      `${auth.serverUrl}/asset/${sha1}?token=${auth.token}&ext=${ext}&modifiedtime=${encodeURIComponent(modifiedTime)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file.buffer,
      },
    );

    if (lomoRes.status === 409) {
      // Duplicate — return success with duplicate status
      const data = await lomoRes.json() as { Name: string };
      console.log(`[assets] upload duplicate: ${data.Name}`);
      return res.status(200).json({ id: data.Name, status: 'duplicate' });
    }

    if (!lomoRes.ok) {
      const errorText = await lomoRes.text();
      console.error(`[assets] upload failed: ${lomoRes.status} ${errorText}`);
      return res.status(lomoRes.status).json({ message: 'Upload failed' });
    }

    const data = await lomoRes.json() as { Name: string; Hash: string; Date: string };
    console.log(`[assets] upload success: ${data.Name}`);

    // Invalidate caches
    clearAlbumBucketCache();
    clearAlbumListCache();

    res.status(201).json({ id: data.Name, status: 'created' });
  } catch (error) {
    console.error('[assets] upload error:', error);
    res.status(500).json({ message: 'Internal error' });
  }
});

// Helper: set or remove favorite on lomo backend
async function setFavorite(serverUrl: string, token: string, ids: string[], isFavorite: boolean): Promise<boolean> {
  const method = isFavorite ? 'POST' : 'DELETE';
  console.log(`[assets] ${isFavorite ? 'favorite' : 'unfavorite'}: ${ids.length} assets`);
  const lomoRes = await lomoFetch(`${serverUrl}/assets/favorite?token=${token}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ids),
  });
  if (!lomoRes.ok) {
    const errorText = await lomoRes.text();
    console.error(`[assets] favorite ${method} failed: ${lomoRes.status} ${errorText}`);
    return false;
  }
  return true;
}

function parseLomoAssetDate(value: unknown): { year: number; month: number; day: number } | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(T.*)?$/.exec(trimmed);
  if (!match) {
    return null;
  }
  if (match[4] && Number.isNaN(Date.parse(trimmed))) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    return null;
  }

  return { year, month, day };
}

// PUT /api/assets (bulk update — handles isFavorite)
assetsRouter.put('/', async (req, res) => {
  const auth = getLomoToken(req);
  if (!auth) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  try {
    const { ids, isFavorite } = req.body as { ids: string[]; isFavorite?: boolean };
    if (!ids || ids.length === 0) {
      return res.json([]);
    }

    if (isFavorite !== undefined) {
      const ok = await setFavorite(auth.serverUrl, auth.token, ids, isFavorite);
      if (!ok) {
        return res.status(500).json({ message: 'Failed to update favorites' });
      }
      clearAlbumBucketCache();
    }

    res.json([]);
  } catch (error) {
    console.error('[assets] bulk update error:', error);
    res.status(500).json({ message: 'Internal error' });
  }
});

// PUT /api/assets/:id (single asset update)
assetsRouter.put('/:id', async (req, res) => {
  const auth = getLomoToken(req);
  if (!auth) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  const assetName = req.params.id;

  try {
    const { isFavorite, dateTimeOriginal } = req.body as {
      isFavorite?: boolean;
      dateTimeOriginal?: string;
    };

    if (isFavorite !== undefined) {
      const ok = await setFavorite(auth.serverUrl, auth.token, [assetName], isFavorite);
      if (!ok) {
        return res.status(500).json({ message: 'Failed to update favorite' });
      }
      clearAlbumBucketCache();
    }

    if (dateTimeOriginal !== undefined) {
      const date = parseLomoAssetDate(dateTimeOriginal);
      if (!date) {
        return res.status(400).json({ message: 'Invalid asset date' });
      }

      const metadataRes = await lomoFetch(
        `${auth.serverUrl}/asset/metadata/${encodeURIComponent(assetName)}?token=${auth.token}`,
      );
      if (!metadataRes.ok) {
        return res.status(metadataRes.status).json({ message: 'Asset not found' });
      }

      const metadata = await metadataRes.json() as { Hash?: string };
      if (!metadata.Hash) {
        return res.status(502).json({ message: 'Asset hash is unavailable' });
      }

      const updateRes = await lomoFetch(
        `${auth.serverUrl}/asset/${encodeURIComponent(metadata.Hash)}/${date.year}/${date.month}/${date.day}?token=${auth.token}`,
        { method: 'PUT' },
      );
      if (!updateRes.ok) {
        const errorText = await updateRes.text();
        console.error(`[assets] date update failed for ${assetName}: ${updateRes.status} ${errorText}`);
        return res.status(updateRes.status).json({ message: 'Failed to update asset date' });
      }

      clearAssetDateCache(auth.serverUrl, [assetName]);
      clearAlbumBucketCache();
    }

    // Return updated asset — re-fetch metadata
    const lomoRes = await lomoFetch(
      `${auth.serverUrl}/asset/metadata/${encodeURIComponent(assetName)}?token=${auth.token}`
    );
    if (!lomoRes.ok) {
      return res.status(lomoRes.status).json({ message: 'Asset not found' });
    }
    const meta = await lomoRes.json() as {
      Date: string; Device: string; Hash: string; Name: string;
      Latitude?: string; Longtitude?: string;
    };
    const statusMap = await fetchAssetStatusMapForDates(auth.serverUrl, auth.token, [{ name: meta.Name, date: meta.Date }]);
    const favoriteStatus = isFavoriteStatus(statusMap.get(meta.Name) ?? 0);

    res.json({
      id: meta.Name,
      checksum: meta.Hash,
      createdAt: meta.Date,
      deviceAssetId: meta.Name,
      deviceId: meta.Device,
      duplicateId: null,
      duration: isImage(meta.Name) ? '0:00:00.000000' : '',
      exifInfo: { dateTimeOriginal: meta.Date },
      fileCreatedAt: meta.Date,
      fileModifiedAt: meta.Date,
      hasMetadata: true,
      isArchived: false,
      isEdited: false,
      isFavorite: favoriteStatus,
      isOffline: false,
      isTrashed: false,
      libraryId: null,
      livePhotoVideoId: null,
      localDateTime: meta.Date,
      originalFileName: meta.Name,
      originalMimeType: getMimeType(meta.Name),
      originalPath: meta.Name,
      ownerId: auth.userId,
      resized: true,
      stack: null,
      tags: [],
      thumbhash: null,
      type: isImage(meta.Name) ? 'IMAGE' : 'VIDEO',
      updatedAt: meta.Date,
      visibility: 'timeline',
    });
  } catch (error) {
    console.error(`[assets] update error for ${assetName}:`, error);
    res.status(500).json({ message: 'Internal error' });
  }
});

// DELETE /api/assets (bulk delete)
assetsRouter.delete('/', async (req, res) => {
  const auth = getLomoToken(req);
  if (!auth) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  try {
    const { ids, force } = req.body as { ids: string[]; force?: boolean };
    if (!ids || ids.length === 0) {
      return res.json([]);
    }

    const deleteList = ids.map((id: string) => ({
      ID: id,
      Type: 0,
      ...(force ? { Force: true } : {}),
    }));

    console.log(`[assets] bulk delete: ${ids.length} assets, force=${!!force}`);

    const lomoRes = await lomoFetch(`${auth.serverUrl}/asset?token=${auth.token}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ List: deleteList }),
    });

    if (!lomoRes.ok) {
      const errorText = await lomoRes.text();
      console.error(`[assets] bulk delete failed: ${lomoRes.status} ${errorText}`);
      return res.status(lomoRes.status).json({ message: 'Failed to delete assets' });
    }

    // Invalidate caches so timeline/albums reflect the deletion
    clearAlbumBucketCache();
    clearAlbumListCache();

    console.log(`[assets] bulk delete success: ${ids.length} assets`);
    res.json([]);
  } catch (error) {
    console.error('[assets] bulk delete error:', error);
    res.status(500).json({ message: 'Internal error' });
  }
});

// POST /api/assets/jobs — stub
assetsRouter.post('/jobs', (_req, res) => {
  res.status(204).end();
});

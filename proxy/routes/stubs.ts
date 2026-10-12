import { Router } from 'express';
import * as os from 'os';
import { lomoFetch } from '../http-agent';
import { clearAssetDateCache } from '../lomo-assets';
import { getLomoToken } from '../session';
import { clearAlbumListCache } from './albums';
import { clearAlbumBucketCache } from './timeline';

export const stubsRouter = Router();

// GET /api/server/config
stubsRouter.get('/server/config', (_req, res) => {
  res.json({
    externalDomain: '',
    isInitialized: true,
    isOnboarded: true,
    loginPageMessage: '',
    maintenanceMode: false,
    mapDarkStyleUrl: '',
    mapLightStyleUrl: '',
    oauthButtonText: '',
    publicUsers: false,
    trashDays: 30,
    userDeleteDelay: 7,
  });
});

// GET /api/server/features
stubsRouter.get('/server/features', (_req, res) => {
  res.json({
    configFile: false,
    duplicateDetection: false,
    email: false,
    facialRecognition: false,
    importFaces: false,
    map: false,
    oauth: false,
    oauthAutoLaunch: false,
    ocr: false,
    passwordLogin: true,
    reverseGeocoding: false,
    search: false,
    sidecar: false,
    smartSearch: false,
    trash: false,
  });
});

// GET /api/server/version
stubsRouter.get('/server/version', (_req, res) => {
  res.json({ major: 1, minor: 0, patch: 0 });
});

// GET /api/server/about
stubsRouter.get('/server/about', (_req, res) => {
  res.json({
    version: '1.0.0',
    versionUrl: '',
    licensed: true,
    build: 'lomo-proxy',
    buildUrl: '',
    buildImage: '',
    buildImageUrl: '',
    repository: '',
    repositoryUrl: '',
    sourceRef: '',
    sourceCommit: '',
    sourceUrl: '',
    nodejs: process.version,
    ffmpeg: '',
    imagemagick: '',
    libvips: '',
    exiftool: '',
  });
});

// GET /api/server/storage
stubsRouter.get('/server/storage', async (req, res) => {
  const auth = getLomoToken(req);
  if (auth) {
    try {
      const lomoRes = await lomoFetch(`${auth.serverUrl}/mount?token=${auth.token}`);
      if (lomoRes.ok) {
        type MountEntry = { FreeSize?: number; TotalSize?: number; Error?: string };
        const mounts = await lomoRes.json() as MountEntry[];
        const main = Array.isArray(mounts) ? (mounts.find((m) => !m.Error) ?? mounts[0]) : undefined;
        if (main?.TotalSize) {
          const mib = 1024 * 1024;
          const totalRaw = main.TotalSize * mib;
          const freeRaw = (main.FreeSize ?? 0) * mib;
          const usedRaw = totalRaw - freeRaw;
          const fmt = (b: number) => {
            const gib = 1024 ** 3;
            return b >= gib ? `${(b / gib).toFixed(1)} GiB` : `${(b / (1024 * 1024)).toFixed(0)} MiB`;
          };
          return res.json({
            diskAvailable: fmt(freeRaw),
            diskAvailableRaw: freeRaw,
            diskSize: fmt(totalRaw),
            diskSizeRaw: totalRaw,
            diskUse: fmt(usedRaw),
            diskUseRaw: usedRaw,
            diskUsagePercentage: Math.round((usedRaw / totalRaw) * 100),
          });
        }
      }
    } catch {
      // fall through to stub
    }
  }
  // Local stub fallback
  const gib = 1024 ** 3;
  res.json({
    diskAvailable: 'N/A',
    diskAvailableRaw: 0,
    diskSize: 'N/A',
    diskSizeRaw: gib,
    diskUse: 'N/A',
    diskUseRaw: 0,
    diskUsagePercentage: 0,
  });
});

// GET /api/users/me
stubsRouter.get('/users/me', (req, res) => {
  const auth = getLomoToken(req);
  if (!auth) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
  res.json({
    avatarColor: 'primary',
    createdAt: '2024-01-01T00:00:00.000Z',
    deletedAt: null,
    email: auth.username,
    id: auth.userId,
    isAdmin: true,
    license: null,
    name: auth.username,
    oauthId: '',
    profileChangedAt: '2024-01-01T00:00:00.000Z',
    profileImagePath: '',
    quotaSizeInBytes: null,
    quotaUsageInBytes: null,
    shouldChangePassword: false,
    status: 'active',
    storageLabel: null,
    updatedAt: '2024-01-01T00:00:00.000Z',
  });
});

// GET /api/users/me/preferences
stubsRouter.get('/users/me/preferences', (_req, res) => {
  res.json({
    albums: { defaultAssetOrder: 'desc' },
    cast: { gCastEnabled: false },
    download: { archiveSize: 4294967296, includeEmbeddedVideos: false },
    emailNotifications: { albumInvite: false, albumUpdate: false, enabled: false },
    folders: { enabled: false, sidebarWeb: false },
    memories: { duration: 10, enabled: false },
    people: { enabled: false, sidebarWeb: false },
    purchase: { hideBuyButtonUntil: '2099-01-01T00:00:00.000Z', showSupportBadge: false },
    ratings: { enabled: false },
    sharedLinks: { enabled: false, sidebarWeb: false },
    tags: { enabled: false, sidebarWeb: false },
  });
});

// GET /api/assets/statistics
stubsRouter.get('/assets/statistics', async (req, res) => {
  const auth = getLomoToken(req);
  if (auth) {
    try {
      const lomoRes = await lomoFetch(`${auth.serverUrl}/assets/merkletree?token=${auth.token}`);
      if (lomoRes.ok) {
        type LomoAsset = { Name: string };
        type LomoDay = { Assets?: LomoAsset[] };
        type LomoMonth = { Days?: LomoDay[] };
        type LomoYear = { Year: number; Months?: LomoMonth[] };
        type LomoTree = { Years?: LomoYear[] };
        const tree = await lomoRes.json() as LomoTree;
        let total = 0;
        let images = 0;
        const videoExts = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.3gp', '.wmv', '.flv']);
        for (const year of tree.Years ?? []) {
          for (const month of year.Months ?? []) {
            for (const day of month.Days ?? []) {
              for (const asset of day.Assets ?? []) {
                total++;
                const ext = asset.Name.slice(asset.Name.lastIndexOf('.')).toLowerCase();
                if (!videoExts.has(ext)) images++;
              }
            }
          }
        }
        return res.json({ images, videos: total - images, total });
      }
    } catch {
      // fall through
    }
  }
  res.json({ images: 0, videos: 0, total: 0 });
});

// GET /api/notifications
stubsRouter.get('/notifications', (_req, res) => {
  res.json([]);
});

// GET /api/memories
stubsRouter.get('/memories', (_req, res) => {
  res.json([]);
});

// GET /api/shared-links
stubsRouter.get('/shared-links', (_req, res) => {
  res.json([]);
});

// GET /api/server/license
stubsRouter.get('/server/license', (_req, res) => {
  res.json({ licenseKey: '', activationKey: '', activatedAt: '' });
});

// GET /api/search/suggestions
stubsRouter.get('/search/suggestions', (_req, res) => {
  res.json([]);
});

// GET /api/server/media-types
stubsRouter.get('/server/media-types', (_req, res) => {
  res.json({
    image: ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.bmp', '.tiff', '.dng', '.raw'],
    sidecar: ['.xmp'],
    video: ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.3gp', '.wmv', '.flv'],
  });
});

// GET /api/server/version-history
stubsRouter.get('/server/version-history', (_req, res) => {
  res.json([{ version: '1.0.0', createdAt: '2024-01-01T00:00:00.000Z' }]);
});

// GET /api/partners
stubsRouter.get('/partners', (_req, res) => {
  res.json([]);
});

// GET /api/api-keys
stubsRouter.get('/api-keys', (_req, res) => {
  res.json([]);
});

// GET /api/sessions
stubsRouter.get('/sessions', (_req, res) => {
  res.json([]);
});

// POST /api/trash/restore/assets — stub (lomo has no restore)
stubsRouter.post('/trash/restore/assets', (_req, res) => {
  res.status(204).end();
});

// ── Settings API (proxy HTTP endpoints) ──────────────────────────────
import * as fs from 'fs';
const CONFIG_PATH = process.env.CONFIG_PATH || '';

type LomoAppConfig = {
  active_backend_mode: 'local' | 'remote';
  photos_dir: string;
  setup_completed: boolean;
  needs_local_setup?: boolean;
  backend_mode: 'local' | 'remote';
  remote_lomod_url: string;
  local: {
    photos_dir: string;
    setup_completed: boolean;
  };
  remote: {
    default_url: string;
  };
};

type LomoAppConfigInput = {
  active_backend_mode?: 'local' | 'remote';
  backend_mode?: 'local' | 'remote';
  photos_dir?: string;
  setup_completed?: boolean;
  remote_lomod_url?: string;
  local?: Partial<LomoAppConfig['local']>;
  remote?: Partial<LomoAppConfig['remote']>;
};

function normalizeRemoteLomodUrl(value: string | undefined): string {
  const trimmed = (value ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    return '';
  }

  return trimmed.includes('://') ? trimmed : `http://${trimmed}`;
}

function normalizeConfig(input?: LomoAppConfigInput): LomoAppConfig {
  const activeMode = input?.active_backend_mode ?? input?.backend_mode ?? 'local';
  const localPhotosDir = input?.local?.photos_dir ?? input?.photos_dir ?? '';
  const localSetupCompleted = input?.local?.setup_completed ?? input?.setup_completed ?? false;
  const remoteDefaultUrl = normalizeRemoteLomodUrl(input?.remote?.default_url ?? input?.remote_lomod_url);

  return {
    active_backend_mode: activeMode,
    photos_dir: localPhotosDir,
    setup_completed: localSetupCompleted,
    needs_local_setup: !localSetupCompleted,
    backend_mode: activeMode,
    remote_lomod_url: remoteDefaultUrl,
    local: {
      photos_dir: localPhotosDir,
      setup_completed: localSetupCompleted,
    },
    remote: {
      default_url: remoteDefaultUrl,
    },
  };
}

function readConfig(): LomoAppConfig {
  try {
    if (CONFIG_PATH && fs.existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as LomoAppConfigInput;
      return normalizeConfig(parsed);
    }
  } catch {}
  return normalizeConfig();
}

function writeConfig(config: Partial<LomoAppConfigInput>): void {
  if (!CONFIG_PATH) throw new Error('CONFIG_PATH not set');
  const current = readConfig();
  const nextConfig = normalizeConfig({
    active_backend_mode: config.active_backend_mode ?? config.backend_mode ?? current.active_backend_mode,
    photos_dir: config.local?.photos_dir ?? config.photos_dir ?? current.local.photos_dir,
    setup_completed: config.local?.setup_completed ?? config.setup_completed ?? current.local.setup_completed,
    remote_lomod_url: config.remote?.default_url ?? config.remote_lomod_url ?? current.remote.default_url,
  });

  if (nextConfig.active_backend_mode === 'local' && !nextConfig.local.photos_dir.trim()) {
    throw new Error('photos_dir is required when using the bundled local backend');
  }

  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      {
        active_backend_mode: nextConfig.active_backend_mode,
        local: nextConfig.local,
        remote: nextConfig.remote,
      },
      null,
      2,
    ),
  );
}

function isPrivateIpv4(address: string): boolean {
  if (address.startsWith('10.')) {
    return true;
  }

  if (address.startsWith('192.168.')) {
    return true;
  }

  const octets = address.split('.').map((value) => Number(value));
  return octets.length === 4 && octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31;
}

function scoreNetworkInterface(name: string, address: string): number {
  const normalizedName = name.toLowerCase();
  let score = 0;

  if (isPrivateIpv4(address)) {
    score += 50;
  }

  if (normalizedName.includes('wi-fi') || normalizedName.includes('wifi') || normalizedName.includes('wlan') || normalizedName.includes('wireless')) {
    score += 30;
  }

  if (normalizedName.includes('ethernet') || normalizedName.includes('lan')) {
    score += 20;
  }

  if (
    normalizedName.includes('tailscale') ||
    normalizedName.includes('zerotier') ||
    normalizedName.includes('docker') ||
    normalizedName.includes('vethernet') ||
    normalizedName.includes('hyper-v') ||
    normalizedName.includes('vmware') ||
    normalizedName.includes('virtualbox') ||
    normalizedName.includes('vbox') ||
    normalizedName.includes('wsl') ||
    normalizedName.includes('loopback') ||
    normalizedName.includes('tap') ||
    normalizedName.includes('tun') ||
    normalizedName.includes('hamachi')
  ) {
    score -= 40;
  }

  if (address.startsWith('169.254.')) {
    score -= 100;
  }

  return score;
}

function getLanAddresses(): string[] {
  const candidates: Array<{ address: string; score: number }> = [];

  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) {
        continue;
      }

      candidates.push({
        address: entry.address,
        score: scoreNetworkInterface(name, entry.address),
      });
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address))
    .map((candidate) => candidate.address)
    .filter((address, index, values) => values.indexOf(address) === index);
}

function getRequestHost(req: { get(name: string): string | undefined }): string {
  const hostHeader = req.get('host') ?? `localhost:${process.env.PROXY_PORT || 3001}`;
  return hostHeader.split(':')[0] || 'localhost';
}

function normalizeBrowserPath(path: unknown): string {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    return '/';
  }

  if (path.startsWith('//') || path.includes('\\')) {
    return '/';
  }

  return path;
}

// The live session's serverUrl is the source of truth for which backend we're talking to.
// config.active_backend_mode only stores the saved *default* and can read 'local' even while the
// user is signed into a remote server for this session (remote URL passed via X-Lomo-Server at
// login). A loopback serverUrl means the bundled local lomod; anything else is a remote server.
function sessionBackendMode(serverUrl: string): 'local' | 'remote' {
  try {
    const host = new URL(serverUrl).hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') {
      return 'local';
    }
    return 'remote';
  } catch {
    return 'local';
  }
}

// GET /api/lomo/settings
stubsRouter.get('/lomo/settings', (_req, res) => {
  res.json(readConfig());
});

// GET /api/lomo/version
stubsRouter.get('/lomo/version', async (req, res) => {
  const auth = getLomoToken(req);
  if (!auth) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  try {
    const lomoRes = await lomoFetch(`${auth.serverUrl}/system?token=${encodeURIComponent(auth.token)}`);
    if (!lomoRes.ok) {
      return res.status(502).json({ message: `Lomod returned ${lomoRes.status}` });
    }

    const system = await lomoRes.json() as { LomodVersion?: unknown };
    if (typeof system.LomodVersion !== 'string' || !system.LomodVersion.trim()) {
      return res.status(502).json({ message: 'Lomod version is unavailable' });
    }

    res.json({ version: system.LomodVersion.trim() });
  } catch (error) {
    console.error('[version] Failed to read lomod version:', error);
    res.status(502).json({ message: 'Failed to read lomod version' });
  }
});

// POST /api/lomo/refresh
// The web app's Refresh button calls this before reloading the page. Photos uploaded straight to
// lomod (e.g. by the Lomorage mobile app) never pass through this proxy, so its timeline and album
// caches would keep hiding them for a while; drop the caches so the reload asks lomod again.
stubsRouter.post('/lomo/refresh', (req, res) => {
  if (!getLomoToken(req)) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
  clearAlbumBucketCache();
  clearAlbumListCache();
  clearAssetDateCache();
  res.status(204).end();
});

// GET /api/lomo/browser-access-link
stubsRouter.get('/lomo/browser-access-link', (req, res) => {
  const port = Number(process.env.PROXY_PORT || 3001);
  const lanAddresses = getLanAddresses();
  const host = lanAddresses[0] ?? getRequestHost(req);
  const path = normalizeBrowserPath(req.query.path);
  const buildUrl = (address: string) => `http://${address}:${port}${path}`;

  res.json({
    url: buildUrl(host),
    host,
    port,
    path,
    candidateUrls: lanAddresses.map(buildUrl),
  });
});

// GET /api/lomo/mobile-upload-link
stubsRouter.get('/lomo/mobile-upload-link', (req, res) => {
  const auth = getLomoToken(req);
  if (!auth) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  const port = Number(process.env.PROXY_PORT || 3001);
  const lanAddresses = getLanAddresses();
  const host = lanAddresses[0] ?? getRequestHost(req);
  const params = new URLSearchParams({ server: auth.serverUrl });
  const preferredUrl = `http://${host}:${port}/mobile-upload?${params.toString()}`;

  res.json({
    url: preferredUrl,
    host,
    port,
    backendMode: sessionBackendMode(auth.serverUrl),
    backendUrl: auth.serverUrl,
    candidateUrls: lanAddresses.map((address) => `http://${address}:${port}/mobile-upload?${params.toString()}`),
  });
});

// PUT /api/lomo/settings
stubsRouter.put('/lomo/settings', (req, res) => {
  try {
    const { photos_dir, backend_mode, remote_lomod_url } = req.body;
    if (photos_dir !== undefined && typeof photos_dir !== 'string') {
      return res.status(400).json({ error: 'photos_dir must be a string' });
    }
    if (backend_mode !== undefined && backend_mode !== 'local' && backend_mode !== 'remote') {
      return res.status(400).json({ error: 'backend_mode must be "local" or "remote"' });
    }
    if (remote_lomod_url !== undefined && typeof remote_lomod_url !== 'string') {
      return res.status(400).json({ error: 'remote_lomod_url must be a string' });
    }

    writeConfig({ photos_dir, backend_mode, remote_lomod_url });
    const saved = readConfig();
    console.log(
      `[settings] Config saved: backend_mode=${saved.backend_mode} photos_dir=${saved.photos_dir} remote_lomod_url=${saved.remote_lomod_url}`,
    );
    res.json({ ok: true, restart_required: true });
  } catch (e: any) {
    console.error('[settings] Failed to save config:', e);
    res.status(500).json({ error: e.message });
  }
});

# syntax=docker/dockerfile:1
#
# LomoAgent for Linux servers: lomod (photo storage, built from submodules/lomod) with
# exiftool and ffmpeg, plus the Immich-based web app and its proxy -- the same pieces as the
# Windows desktop app, without the Tauri shell. Build from the repository root:
#
#   git submodule update --init submodules/immich submodules/lomod
#   docker build -f docker/Dockerfile -t lomo-photo-viewer .
#
# Usage and configuration: docker/README.md.

ARG NODE_IMAGE=node:24.13.1-bookworm-slim
ARG GO_IMAGE=golang:1.26-bookworm
ARG UBUNTU_IMAGE=ubuntu:24.04

# ---- Immich web app (static SPA; the same build as the desktop app's web.zip) ----
FROM ${NODE_IMAGE} AS web
WORKDIR /src
RUN npm install -g pnpm@10.30.3
# Only the web app and what it builds from, as upstream Immich's own Dockerfile does
COPY submodules/immich/package.json submodules/immich/pnpm-lock.yaml \
     submodules/immich/pnpm-workspace.yaml submodules/immich/.pnpmfile.cjs ./
COPY submodules/immich/open-api ./open-api
COPY submodules/immich/i18n ./i18n
COPY submodules/immich/web ./web
RUN --mount=type=cache,id=lomo-pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "immich-web..." \
 && pnpm --filter @immich/sdk run build \
 && pnpm --filter immich-web run build

# ---- proxy (Immich API -> lomod API) ----
FROM ${NODE_IMAGE} AS proxy
WORKDIR /app/proxy
COPY proxy/package.json ./
RUN --mount=type=cache,id=lomo-npm,target=/root/.npm \
    npm install --no-audit --no-fund
COPY proxy/ ./
RUN npx esbuild server.ts --bundle --platform=node --target=node22 \
      --outfile=dist/server.cjs --external:sharp \
 && npm prune --omit=dev --no-audit --no-fund

# ---- lomod (cgo + libvips, built on the same Ubuntu release it runs on) ----
FROM ${GO_IMAGE} AS go
FROM ${UBUNTU_IMAGE} AS lomod
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev pkg-config libvips-dev git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=go /usr/local/go /usr/local/go
ENV PATH=/usr/local/go/bin:/root/go/bin:$PATH GOTOOLCHAIN=local
RUN go install github.com/GeertJohan/go.rice/rice@v1.0.2
WORKDIR /src
COPY submodules/lomod ./
ARG LOMOD_VERSION=dev
# -s -w as in lomod's own Linux builds: unstripped, go.rice's init panics reading the binary.
RUN --mount=type=cache,id=lomo-gobuild,target=/root/.cache/go-build \
    cd handler && GOFLAGS=-mod=vendor rice embed-go && cd .. \
 && CGO_ENABLED=1 CGO_CFLAGS_ALLOW=-Xpreprocessor go build -mod=vendor -tags "sqlite_trace trace" \
      -ldflags "-s -w -X bitbucket.org/lomoware/lomo-backend/common/release.Version=${LOMOD_VERSION}" \
      -o /out/lomod ./cmd/lomod

# ---- runtime ----
FROM ${UBUNTU_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libvips42t64 libimage-exiftool-perl ffmpeg \
      ca-certificates curl tini tzdata \
 && rm -rf /var/lib/apt/lists/*

COPY --from=proxy /usr/local/bin/node /usr/local/bin/node
COPY --from=lomod /out/lomod /usr/local/bin/lomod
COPY --from=web /src/web/build /app/web
COPY --from=proxy /app/proxy/package.json /app/proxy/package.json
COPY --from=proxy /app/proxy/node_modules /app/proxy/node_modules
COPY --from=proxy /app/proxy/dist/server.cjs /app/proxy/dist/server.cjs
COPY scripts/lib/lomo-credential.mjs /app/scripts/lib/
COPY --chmod=755 docker/entrypoint.sh /app/docker/
COPY docker/create-admin.mjs /app/docker/

ENV LOMO_DATA_DIR=/data \
    LOMO_PHOTOS_DIR=/photos \
    WEB_PORT=3001 \
    LOMOD_PORT=8000 \
    WEBDAV_PORT=8004 \
    LOMO_ADMIN_USER=admin
VOLUME ["/data", "/photos"]
# 3001: web app; 8000: lomod (Lomorage mobile apps); 8004: lomod WebDAV (WEB_PORT/LOMOD_PORT/WEBDAV_PORT)
EXPOSE 3001 8000 8004

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD curl -fs -o /dev/null "http://127.0.0.1:${WEB_PORT}/" && curl -fs -o /dev/null "http://127.0.0.1:${LOMOD_PORT}/status"

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]

# torlnk in a container, for `serve --web`.
#
# Two things here are load-bearing and easy to get wrong, so they are called out
# rather than left to be discovered:
#
#   1. NOT alpine. `node-datachannel` (WebRTC peers, via webtorrent) ships
#      prebuilt binaries for glibc and not for musl, so on alpine its install
#      script falls back to compiling from source — and `scripts/ensure-webrtc.cjs`
#      is deliberately fail-soft, so a missing toolchain produces a WORKING
#      torlnk that has quietly lost WebRTC peers. bookworm-slim gets the
#      prebuild and the swarm behaves the way it does everywhere else.
#
#   2. ffmpeg is installed in the RUNTIME stage, not the builder. It is what
#      `src/util/ffmpegBin.ts` looks for at request time. It stays optional in
#      the code — absent means the web player classifies from release names and
#      falls back to the "needs a real player" card — but a container is a
#      controlled environment, so there is no reason to ship it without.

FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Build tools only in this stage: needed if npm cannot find a node-datachannel
# prebuild for this platform. They add ~250 MB, which is exactly why the runtime
# stage below starts from a fresh base rather than inheriting this one.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates cmake g++ libssl-dev make python3 \
  && rm -rf /var/lib/apt/lists/*

# package.json and the lockfile first, so a source-only change does not
# invalidate the dependency layer.
COPY package.json package-lock.json ./
# ensure-webrtc.cjs runs as `postinstall`, so it has to be present for `npm ci`.
COPY scripts/ensure-webrtc.cjs ./scripts/ensure-webrtc.cjs
RUN npm ci

COPY . .
RUN npm run build \
  # Drop devDependencies from the tree that the runtime stage copies. `prune`
  # does not re-run install scripts, so the native module built above survives.
  && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

# ffmpeg brings ffprobe, and torlnk wants both:
#   ffprobe — reads a stream's real container and codecs, so the web player
#             knows up front whether a browser can play it.
#   ffmpeg  — remuxes an MKV into HLS for the browser (where that rung exists).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && ffprobe -version | head -1

WORKDIR /app

# node:* images ship a non-root `node` user (uid 1000). Running as it means the
# volumes below are written as a normal user, not as root — which matters
# because those files land on the host and you have to be able to read them.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./package.json

# ONE directory for every piece of persisted state. src/config/paths.ts honours
# TORLINK_STATE_DIR by putting config/, data/ and cache/ under it, so a single
# volume covers the token, the queue, watch history, seeds and the poster cache.
ENV TORLINK_STATE_DIR=/state
# HOME decides the default download directory (`$HOME/Downloads/torlink`), so
# pointing it at /state keeps downloads on a mount too. Override `downloadDir`
# in /state/config/config.json to put them on a different disk.
ENV HOME=/state
# The container has no terminal to hand a link to and no browser to open, so the
# update check is noise here.
ENV TORLINK_NO_UPDATE_CHECK=1

RUN mkdir -p /state && chown -R node:node /state
VOLUME ["/state"]
USER node

# 9162 is the web UI. 9161 (the add API) is deliberately NOT exposed: it is a
# scripting surface with no browser, and anything that needs it can be published
# explicitly.
EXPOSE 9162

# --host 0.0.0.0 is required for the port to be reachable from outside the
# container. torlnk never exposes a non-loopback bind unauthenticated, but with
# `--web` it MINTS a token rather than refusing (daemon/serve.ts) — there is a
# browser to hand a working link to, so it prints one to the log:
#
#   token a30c…  (pass --token to pin it across restarts)
#
# That works, and it means the container boots with no configuration at all. Set
# `TORLINK_API_TOKEN` anyway for anything long-lived: a minted token is new on
# every restart, so with `restart: unless-stopped` the URL you bookmarked stops
# working the first time the container bounces.
CMD ["node", "dist/index.js", "serve", "--web", "--host", "0.0.0.0", "--port", "9162"]

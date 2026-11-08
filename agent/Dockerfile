# Sandbox for the Rebound fix agent: Node, Firefox (via Puppeteer), Claude Code.
# No credentials are baked in. The orchestrator mounts only the work dir and a
# read-only copy of the Claude Code login. No SSH keys, deploy keys or signing keys.
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates ffmpeg libgtk-3-0 libdbus-glib-1-2 libasound2 libx11-xcb1 libxtst6 \
      libpci3 fonts-dejavu-core zip jq \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@latest

# Unprivileged user; Claude Code refuses to skip permissions as root. The base
# image's `node` user is uid 1000, matching the monitor host's user, so the
# bind-mounted work dir is writable without chmod games. Rebuild with a matching
# uid if your host user differs: docker build --build-arg HOST_UID=$(id -u) ...
ARG HOST_UID=1000
RUN if [ "$HOST_UID" != "1000" ]; then usermod -u "$HOST_UID" node && chown -R node /home/node; fi
USER node
WORKDIR /home/node

# Pre-install the pinned Firefox once, so every run doesn't download it.
RUN mkdir -p /home/node/ff && cd /home/node/ff && npm init -y >/dev/null && \
    npm install puppeteer@25 >/dev/null && npx puppeteer browsers install firefox && rm -rf /home/node/ff

ENV REBOUND_STATE_DIR=/work/state REBOUND_ARTIFACTS_DIR=/work/artifacts REBOUND_NO_TRIGGER=1
WORKDIR /work

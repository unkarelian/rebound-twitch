# Sandbox for the Rebound fix agent: Node, Firefox (via Puppeteer), Claude Code.
# No credentials are baked in. The orchestrator mounts only the work dir and a
# read-only copy of the Claude Code login. No SSH keys, deploy keys or signing keys.
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates ffmpeg libgtk-3-0 libdbus-glib-1-2 libasound2 libx11-xcb1 libxtst6 \
      libpci3 fonts-dejavu-core zip jq \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@latest

# Unprivileged user; Claude Code refuses to skip permissions as root.
RUN useradd -m -u 1500 agent
USER agent
WORKDIR /home/agent

# Pre-install the pinned Firefox once, so every run doesn't download it.
RUN mkdir -p /home/agent/ff && cd /home/agent/ff && npm init -y >/dev/null && \
    npm install puppeteer@25 >/dev/null && npx puppeteer browsers install firefox && rm -rf /home/agent/ff

ENV REBOUND_STATE_DIR=/work/state REBOUND_ARTIFACTS_DIR=/work/artifacts REBOUND_NO_TRIGGER=1
WORKDIR /work

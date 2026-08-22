# Webtop Ubuntu XFCE desktop + Express API in one image.
# Desktop: 3010 (HTTP) / 3011 (HTTPS)
# API:     2001

FROM node:24 AS api-build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM linuxserver/webtop:ubuntu-xfce

USER root
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    build-essential \
    ca-certificates \
    curl \
    ffmpeg \
    git \
    gnupg \
    imagemagick \
    jq \
    libreoffice \
    python3 \
    python3-dev \
    python3-pip \
    python3-venv \
    scrot \
    sqlite3 \
    unzip \
    vim \
    wget \
    xclip \
    xdotool \
    xfce4-terminal \
    zip \
    && rm -rf /var/lib/apt/lists/*

# Ubuntu Chromium is a snap wrapper; use Google Chrome and keep chromium aliases.
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/* \
    && mv /usr/bin/google-chrome-stable /usr/bin/google-chrome-stable.real \
    && printf '%s\n' '#!/bin/bash' 'exec /usr/bin/google-chrome-stable.real --no-sandbox --disable-dev-shm-usage "$@"' \
      > /usr/bin/google-chrome-stable \
    && chmod +x /usr/bin/google-chrome-stable \
    && ln -sf /usr/bin/google-chrome-stable /usr/local/bin/chromium \
    && ln -sf /usr/bin/google-chrome-stable /usr/local/bin/chromium-browser \
    && ln -sf /usr/bin/google-chrome-stable /usr/bin/google-chrome

RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get update && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install OpenCode (https://opencode.ai) — provides `opencode serve --port 4096`
# Use HOME=/root so binary goes to /root/.opencode (not /config volume which is host-mounted and hides image content)
RUN HOME=/root curl -fsSL https://opencode.ai/install | bash
ENV PATH="/root/.opencode/bin:/config/.opencode/bin:/usr/local/bin:$PATH"
ENV OPENCODE_SERVER_PASSWORD="password"
ENV OPENCODE_PORT=4096

RUN wget -qO- https://packages.microsoft.com/keys/microsoft.asc \
    | gpg --dearmor -o /usr/share/keyrings/packages.microsoft.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/packages.microsoft.gpg] https://packages.microsoft.com/repos/code stable main" \
    > /etc/apt/sources.list.d/vscode.list \
    && apt-get update && apt-get install -y code \
    && rm -rf /var/lib/apt/lists/* \
    && mv /usr/share/code/code /usr/share/code/code.bin \
    && printf '%s\n' \
      '#!/bin/bash' \
      'export DONT_PROMPT_WSL_INSTALL=1' \
      'export ELECTRON_DISABLE_SANDBOX=1' \
      'if [ -n "$ELECTRON_RUN_AS_NODE" ]; then' \
      '  exec /usr/share/code/code.bin "$@"' \
      'fi' \
      'exec /usr/share/code/code.bin --no-sandbox --disable-gpu --disable-dev-shm-usage "$@"' \
      > /usr/share/code/code \
    && chmod +x /usr/share/code/code \
    && ln -sfn /usr/share/code/bin/code /usr/bin/code

WORKDIR /app
COPY --from=api-build /build/package.json ./
COPY --from=api-build /build/node_modules ./node_modules
COPY --from=api-build /build/build ./build

COPY srcDocker/custom-services.d/api /custom-services.d/api
COPY srcDocker/custom-services.d/opencode /custom-services.d/opencode
RUN sed -i 's/\r$//' /custom-services.d/api /custom-services.d/opencode \
    && chmod +x /custom-services.d/api /custom-services.d/opencode \
    && chown -R abc:abc /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV EXPRESS_PORT=2001
ENV FILE_STORAGE_PATH=/config
ENV LIBREOFFICE_BIN=soffice
ENV CUSTOM_USER=abc
ENV PASSWORD=agentworkspace
ENV DONT_PROMPT_WSL_INSTALL=1
ENV ELECTRON_DISABLE_SANDBOX=1
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Ensure opencode is available to abc user + install puppeteer for browser automation
# Copy binary out of /config volume so it survives host mount
RUN npm install -g puppeteer 2>/dev/null || true \
    && mkdir -p /usr/local/bin \
    && if [ -x /root/.opencode/bin/opencode ]; then cp /root/.opencode/bin/opencode /usr/local/bin/opencode; elif [ -x /config/.opencode/bin/opencode ]; then cp /config/.opencode/bin/opencode /usr/local/bin/opencode; fi \
    && chmod +x /usr/local/bin/opencode 2>/dev/null || true \
    && chmod -R 755 /root/.opencode 2>/dev/null || true \
    && chmod -R 755 /config/.opencode 2>/dev/null || true \
    && ls -lh /usr/local/bin/opencode 2>&1 || echo "opencode not found at /usr/local/bin"

EXPOSE 2001 3000 3001 4096

# Entrypoint/CMD come from linuxserver webtop (s6-overlay).

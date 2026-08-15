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
RUN sed -i 's/\r$//' /custom-services.d/api \
    && chmod +x /custom-services.d/api \
    && chown -R abc:abc /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV EXPRESS_PORT=2001
ENV FILE_STORAGE_PATH=/config
ENV LIBREOFFICE_BIN=soffice
ENV DONT_PROMPT_WSL_INSTALL=1
ENV ELECTRON_DISABLE_SANDBOX=1

EXPOSE 2001 3000 3001

# Entrypoint/CMD come from linuxserver webtop (s6-overlay).

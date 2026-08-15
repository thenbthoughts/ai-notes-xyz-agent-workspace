# ai-notes-xyz-agent-workspace

Git: https://github.com/thenbthoughts/ai-notes-xyz-agent-workspace

One Docker container: Ubuntu XFCE desktop in the browser, plus a token-protected Express API for files, zip, shell, and LibreOffice convert.

Base image: `linuxserver/webtop:ubuntu-xfce`.

Desktop apps: Chromium (Google Chrome), LibreOffice, VS Code.

## Table of contents

- [Quick start](#quick-start)
- [Docs](#docs)
  - [Docker and volumes](docs/docker.md)
  - [API](docs/api.md)
  - [Files on disk](docs/files.md)
  - [Deploy with Coolify](docs/coolify.md)
- [Project layout](#project-layout)

## Quick start

```bash
# optional: put API_TOKEN in .env
docker compose up -d --build
```

| What | URL |
| ---- | --- |
| Desktop HTTP | http://localhost:3010 |
| Desktop HTTPS | https://localhost:3011 |
| API | http://localhost:2001/api/ |

Web login: `abc` / `agentworkspace`. Accept the self-signed cert on HTTPS.

```bash
docker compose down
```

## Docs

- [Docker and volumes](docs/docker.md)
- [API](docs/api.md)
- [Files on disk](docs/files.md)
- [Deploy with Coolify](docs/coolify.md)

## Project layout

```text
Dockerfile                 # webtop image
docker-compose.yml
srcDocker/                 # container extras (s6 API service)
src/                       # Express API
volume/                    # host bind mount → /config
docs/
```

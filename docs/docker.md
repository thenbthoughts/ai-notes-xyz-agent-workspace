# Docker

## Image

[`Dockerfile`](../Dockerfile) builds from `linuxserver/webtop:ubuntu-xfce` and adds:

- Google Chrome (`chromium` aliases)
- LibreOffice
- VS Code (sandbox flags for Docker)
- Node.js 24, Python 3, git, ffmpeg, zip, jq, sqlite3, ImageMagick, xdotool, scrot, xclip

The Express API is compiled in a `node:24` stage, then copied to `/app`.

## Compose

[`docker-compose.yml`](../docker-compose.yml):

| Host | Container |
| ---- | --------- |
| `./volume` | `/config` (desktop home + files) |
| `2001` | API (`2001` in the container) |
| `3010` | desktop HTTP (`3000` in the container) |
| `3011` | desktop HTTPS (`3001` in the container) |

`shm_size: 1gb` is required for a stable browser desktop.

To run this on a Coolify server, see [Deploy with Coolify](coolify.md).

```bash
docker compose up -d --build
docker compose down
docker compose --env-file .env up -d --build
```

## srcDocker

[`srcDocker/custom-services.d/api`](../srcDocker/custom-services.d/api) is a linuxserver s6 service. It creates:

```text
/config/ai-notes-xyz-agent-workspace/shell
/config/ai-notes-xyz-agent-workspace/features
```

then starts the API as user `abc` on port **2001**.

## Settings

| Name | What it does |
| ---- | ------------- |
| `EXPRESS_PORT` | API port. Default **2001**. |
| `API_TOKEN` | Secret for `X-API-Token`. Empty → protected routes return **503**. |
| `FILE_STORAGE_PATH` | File sandbox root. In Docker: **`/config`**. |
| `CUSTOM_USER` / `PASSWORD` | HTTP basic auth for the web desktop. Defaults `abc` / `abc`. |
| `PUID` / `PGID` / `TZ` | linuxserver user / timezone. |
| `LIBREOFFICE_BIN` | Binary for convert (default `soffice`). |

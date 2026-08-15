# Deploy with Coolify

Git: https://github.com/thenbthoughts/ai-notes-xyz-agent-workspace

Deploy this repo on [Coolify](https://coolify.io/) as a **Dockerfile** application. Coolify builds the `Dockerfile`, injects env vars, and can put HTTPS in front of the API and the web desktop.

## Table of contents

- [Docs](#docs)
- [What you get](#what-you-get)
- [Server requirements](#server-requirements)
- [Create the application](#create-the-application)
- [Environment variables](#environment-variables)
- [Ports and domains](#ports-and-domains)
- [Persistent storage](#persistent-storage)
- [Shared memory](#shared-memory)
- [Health check](#health-check)
- [Deploy](#deploy)
- [Notes](#notes)

## Docs

- [Docker and volumes](docker.md)
- [API](api.md)
- [Files on disk](files.md)

## What you get

One container, three internal ports (`EXPOSE` in the Dockerfile):

| Port | Service |
| ---- | ------- |
| **2001** | Express API (`/api`) |
| **3000** | XFCE web desktop (HTTP / Selkies) |
| **3001** | XFCE web desktop (container self-signed HTTPS) |

Use **3000** behind Coolify’s proxy. Coolify already terminates TLS, so do not point a public domain at **3001**.

## Server requirements

- Coolify on a Docker host with at least **8 GB RAM** (Webtop + Chrome + LibreOffice + VS Code)
- **20 GB** free disk; the first build can take 10–20 minutes

## Create the application

1. In Coolify: **Projects** → your project → **+ New** → **Resource**.
2. Choose a **Git** source and use https://github.com/thenbthoughts/ai-notes-xyz-agent-workspace (`main`).
3. Set the build pack to **Dockerfile**.
4. Dockerfile location: `Dockerfile` (repo root). Base directory: `/` (repo root).
5. Do not set a custom start command. The linuxserver webtop image already starts via s6 (`/init`); that launches the desktop and the API.

## Environment variables

In the application **Environment Variables** (Coolify passes these into the container at runtime):

| Name | Required | Notes |
| ---- | -------- | ----- |
| `API_TOKEN` | Yes for protected API routes | Same value the client sends as `X-API-Token`. Empty → those routes return **503**. Mark as secret. |
| `CUSTOM_USER` | No | Desktop HTTP basic auth username. Default `abc`. |
| `PASSWORD` | Yes on a public server | Desktop HTTP basic auth password. Default `agentworkspace`. Mark as secret. |
| `TZ` | No | Example: `Asia/Kolkata`. |
| `PUID` / `PGID` | No | linuxserver user ids. Defaults `1000` / `1000`. |
| `TITLE` | No | Desktop title. Default `ai-notes-xyz-agent-workspace`. |
| `HOST` | No | API bind address. Dockerfile default `0.0.0.0`. |
| `EXPRESS_PORT` | No | API port. Dockerfile default **2001**. |
| `FILE_STORAGE_PATH` | No | File sandbox root. Leave **`/config`**. |
| `LIBREOFFICE_BIN` | No | Convert binary. Default `soffice`. |

Do not commit secrets. Redeploy after changing env vars so the container is recreated.

Do not use the default `abc` / `agentworkspace` on a public server.

## Ports and domains

**General → Ports Exposes:** `2001,3000`

(Leave **3001** off the proxy.)

**Domains** — Coolify can attach more than one host; put the container port after the URL when it is not the first exposed port:

| Domain example | Meaning |
| -------------- | ------- |
| `https://workspace-api.example.com:2001` | API, e.g. `https://workspace-api.example.com/api/` |
| `https://workspace.example.com:3000` | XFCE desktop in the browser |

If the UI only shows one “Ports Exposes” field as `2001`, add `3000` there first, then add the second domain with `:3000`.

Selkies needs **WebSockets**. Coolify’s Traefik/Caddy proxy allows them by default; if the desktop loads but the stream stays black, check that WS upgrades are not stripped.

You do not need host port mappings (`2001:2001`, `3010:3000`) when the Coolify proxy is used.

## Persistent storage

**Storages** → add a mount (a named volume is fine):

| Destination in container | What it holds |
| ------------------------ | ------------- |
| `/config` | Desktop home + API files (`FILE_STORAGE_PATH`) |

That is `./volume` in local Docker. API paths stay under `/config/ai-notes-xyz-agent-workspace/shell` and `.../features`. See [files.md](files.md).

Keep volumes when deleting the Coolify resource if you still need the files.

## Shared memory

The web desktop needs **1 GB** of `/dev/shm`. Set it in the application:

**Advanced** (or **Custom Docker Options**): `--shm-size=1gb`

Without this, the browser desktop is often unstable or black.

## Health check

Point Coolify’s health check at the API, not the desktop:

- Port: **2001**
- Path: `/api/` or `/api/shell-engine/about`

A check on `/` is the webtop GUI, not the API. Port **3000** is the desktop stream.

## Deploy

1. Save env vars, ports, domains, storages, and `--shm-size=1gb`.
2. Click **Deploy** and wait for the image build (first build is slow).
3. Open the API domain `/api/` (welcome text) and `/api/shell-engine/about`.
4. Open the desktop domain and log in with `CUSTOM_USER` (default `abc`) and `PASSWORD` (default `agentworkspace`).
5. Call protected routes with header `X-API-Token`.

API reference: [api.md](api.md).

## Notes

- Do not expose this stack on the public internet without a strong `API_TOKEN`. `/api/shell-engine/run-shell/execute` runs shell commands inside the container.
- Set a strong `PASSWORD` in Coolify. Do not leave the default `agentworkspace` password if the instance is reachable beyond a trusted network.
- For local Docker, see [docker.md](docker.md).

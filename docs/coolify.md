# Deploy with Coolify

Coolify is a panel that builds and runs Docker apps on your own server. You point it at this repo, it builds the image, then you open the desktop and API in the browser.

This image is large (Webtop + Chrome + LibreOffice + VS Code). Use a server with at least **8 GB RAM** and **20 GB** free disk. The first build can take 10–20 minutes.

## 1. Put the code on Git

Push `ai-notes-xyz-agent-workspace` to GitHub (or GitLab / Gitea). Coolify will clone it and run `docker-compose.yml`.

Do not commit `.env`. Secrets go in Coolify, not in git.

## 2. Create the app in Coolify

1. Open Coolify.
2. Open a project → **Add Resource**.
3. Choose **Docker Compose** (from a git repository).
4. Connect the repo and branch.
5. Coolify should find `docker-compose.yml` in the project root.
6. Save.

## 3. Set environment variables

In the resource, open **Environment Variables** and add at least:

| Name | Example | Why |
| ---- | ------- | --- |
| `API_TOKEN` | a long random string | Protects the API (`X-API-Token`) |
| `CUSTOM_USER` | your desktop login | Webtop login name |
| `PASSWORD` | a strong password | Webtop login password |
| `TZ` | `Asia/Kolkata` | Clock inside the desktop |

Leave `FILE_STORAGE_PATH=/config` as in compose.

Do not use the default `abc` / `abc` on a public server.

## 4. Keep files after redeploy

The desktop home is `/config` inside the container.

In Coolify, add **persistent storage** so `/config` is not wiped on each deploy:

- Destination path: `/config`
- Source: a Coolify volume (or keep `./volume` if your server bind-mount works)

If Coolify asks whether to keep volumes when you delete the app, choose **Keep** if you still need the files.

## 5. Domains

Coolify’s reverse proxy should talk to **HTTP**, not the container’s self-signed HTTPS.

Add two domains (or one domain and one subdomain):

| What | Container port | Example |
| ---- | -------------- | ------- |
| Desktop | `3000` HTTP / `3001` HTTPS (host **3010** / **3011**) | `https://desk.example.com` |
| API | `2001` | `https://api.example.com` |

Coolify already gives you HTTPS. Point the desktop proxy at container port **3000**, and the API proxy at **2001**.

After deploy:

- Desktop: open the desk URL, log in with `CUSTOM_USER` / `PASSWORD`
- API: `https://api.example.com/api/shell-engine/about`

## 6. Deploy

Click **Deploy**. Wait until the build finishes and the container is running.

If the desktop is blank or Chrome crashes, the server may be short on RAM, or `shm_size: 1gb` was dropped. That value is already in `docker-compose.yml` and should stay.

## If something fails

- Build killed: not enough disk or RAM
- API returns 503: `API_TOKEN` is empty
- API returns 401: wrong `X-API-Token` header
- Desktop 401 in the browser: you still need the Webtop username and password
- Files gone after redeploy: `/config` was not a persistent volume

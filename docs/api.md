# API

All routes are under `/api`. Protected routes need header `X-API-Token: <your API_TOKEN>`.

Default Docker URL: `http://localhost:2001`.

## Open

- **GET** `/api/` — welcome text
- **GET** `/api/shell-engine/about` — `{ "app": "ai-notes-xyz-agent-workspace" }`

## Needs token

- **GET** `/api/shell-engine/about/private` — `{ "app": "...", "validateToken": true }`

### Files (`/api/shell-engine/file`)

Paths must stay under `ai-notes-xyz-agent-workspace/shell/` or `ai-notes-xyz-agent-workspace/features/`. No absolute paths, no `..`.

- **POST** `/write` — multipart: `file` + `relativePath` (max 50MB)
- **GET** `/list?relativeDir=ai-notes-xyz-agent-workspace&maxFiles=50&maxDepth=5`
- **GET** `/ls?relativeDir=ai-notes-xyz-agent-workspace`
- **GET** `/read?relativePath=ai-notes-xyz-agent-workspace/features/notes.odt`
- **POST** `/delete` — JSON `{ "relativePath": "..." }` (workspace roots cannot be deleted)

### Zip (`/api/shell-engine/zip`)

Same path rules. Needs system `zip` / `unzip`. Archive cap 80MB.

### Shell

- **POST** `/api/shell-engine/run-shell/execute` — JSON `{ "command", "timeoutMs?" }`

Runs as the container user. Protect with a strong `API_TOKEN`.

### LibreOffice

- **POST** `/api/shell-engine/libreoffice/convert` — JSON:
  - `relativePath` — input file
  - `format` — `pdf` (default), `docx`, `odt`, `xlsx`, `pptx`, …
  - `outputRelativeDir` — optional
  - `timeoutMs` — optional (default 60000, max 180000)

- **POST** `/api/shell-engine/libreoffice/open` — JSON `{ "relativePath" }` — open the file in desktop LibreOffice.

## Local API only (no Docker desktop)

```bash
npm install
npm run build
npm start
```

Or `npm run dev`. Needs LibreOffice on PATH if you use `/convert`.

## Examples

```bash
TOKEN=YOUR_TOKEN_HERE
API=http://localhost:2001

curl -s "$API/api/shell-engine/about"

curl -s -H "X-API-Token: $TOKEN" "$API/api/shell-engine/about/private"

curl -s -X POST -H "X-API-Token: $TOKEN" \
  -F "file=@./notes.odt" \
  -F "relativePath=ai-notes-xyz-agent-workspace/features/notes.odt" \
  "$API/api/shell-engine/file/write"

curl -s -X POST -H "Content-Type: application/json" -H "X-API-Token: $TOKEN" \
  -d '{"relativePath":"ai-notes-xyz-agent-workspace/features/notes.odt","format":"pdf"}' \
  "$API/api/shell-engine/libreoffice/convert"

curl -s -X POST -H "Content-Type: application/json" -H "X-API-Token: $TOKEN" \
  -d '{"command":"soffice --version","timeoutMs":10000}' \
  "$API/api/shell-engine/run-shell/execute"
```

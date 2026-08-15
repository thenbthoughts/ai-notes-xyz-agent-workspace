# Files

Host bind mount: `./volume` → container `/config`.

Agent files:

```text
./volume/ai-notes-xyz-agent-workspace/shell      # general files, zip, shell work
./volume/ai-notes-xyz-agent-workspace/features   # LibreOffice / convert documents
```

In the desktop file manager those paths are:

```text
/config/ai-notes-xyz-agent-workspace/shell
/config/ai-notes-xyz-agent-workspace/features
```

`Desktop` and `ssl` under `/config` are Webtop system folders. Do not use them for API file routes.

API `relativePath` values are relative to `FILE_STORAGE_PATH` (`/config` in Docker), for example:

```text
ai-notes-xyz-agent-workspace/features/notes.odt
ai-notes-xyz-agent-workspace/shell/out.zip
```

# dsh-session-cleaner

A DeepSeek Harness Web GUI plugin: manage and delete conversation records from the settings page.

[中文](README.md)

## Features

- **Delete a whole session**: archives the session and physically removes its durable log (JSONL directory), and cleans up that session's message-feedback data.
- **Delete individual records**: conversations are grouped by user message; deleting a user message cascades to all assistant replies and tool messages it triggered.
- **Grouped browsing**: in the settings page "会话管理" (Session Manager), click a user message to expand the assistant/tool messages it triggered; each child message can be deleted individually.
- **Safety guard**: running sessions and the current session cannot be deleted (enforced on the Host side).

## Requirements

- [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) Web GUI (`dsh web`).

## Installation (first-class plugin, loads automatically on startup)

This repository is a **dual-face plugin package**: the node half runs in the host process (`/api/session-cleaner` routes), and the browser half loads into the Web GUI through the `dsh.client` declaration.

```powershell
# 1. Install into the profile (link path for local development; package name after npm publish)
dsh plugin --profile web add link:C:\path\to\dsh-session-cleaner

# 2. Restart dsh web
dsh web
```

After installation the plugin loads automatically with every DSH startup — **no re-install needed**. Entry point: **Settings → 会话管理** (Session Manager).

Code updates need no rebuild (plain JavaScript); just restart `dsh web`.

### How it works

- `cordis.patch.yml` (the `dsh.bundle.patch` manifest) inserts one `session-cleaner` plugin row into the profile composition.
- The `dsh.client` declaration in `package.json` loads the browser half from `/plugins/<id>/client.js`; `exports["./client"]` points at the bundle.
- The node half registers `/api/session-cleaner/*` routes (loopback-only) through `webServer`; the browser half calls them via `fetch`.

## Uninstall / update

```powershell
dsh plugin --profile web remove @haoranwang0921/dsh-session-cleaner
```

Or edit `$DSH_HOME/cordis.patch.yml` / the profile's `cordis.patch.yml` to disable or delete the `session-cleaner` row.

## Deletion semantics (important)

DSH session logs are **append-only**:

- **Deleting a whole session**: physically removes the session's log directory — its records are gone for good (except content-addressed shared attachments).
- **Deleting a single message**: removes the target from the **model context** via the surface-replace mechanism (same semantics as `/compact`), but the original events remain in the log and in the human transcript; the message disappears from this plugin's list.

## File layout

- `lib/index.js` — node half (Host): the `/api/session-cleaner/*` routes and deletion logic.
- `lib/client.js` — browser half: the settings-page "Session Manager" grouped view.
- `cordis.patch.yml` — bundle patch (inserts the plugin row into the profile).
- `dynamic/` — the legacy dynamic Cordis plugin form (`cordis_define` / `cordis_run` loading, lost on DSH restart), kept for reference.
- `LICENSE` — Apache-2.0.

## Disclaimer

Deletion is irreversible. Confirm the target session/message before acting; the author is not responsible for data loss.

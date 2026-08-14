# dsh-session-cleaner

A DeepSeek Harness dynamic Cordis plugin: manage and delete conversation records from the Web GUI settings page.

[中文](README.md)

## Features

- **Delete a whole session**: archives the session and physically removes its durable log (JSONL directory), and cleans up that session's message-feedback data.
- **Delete individual records**: conversations are grouped by user message; deleting a user message cascades to all assistant replies and tool messages it triggered.
- **Grouped browsing**: in the settings page "会话管理" (Session Manager), click a user message to expand the assistant/tool messages it triggered; each child message can be deleted individually.
- **Safety guard**: running sessions and the current session cannot be deleted (enforced on the Host side).

## Requirements

- [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) Web GUI (`dsh web`).
- This plugin loads through DSH's **dynamic Cordis plugin** mechanism (`cordis_define` / `cordis_run`) — no DSH source changes. It is a per-process extension and must be reloaded after a DSH restart.

## Installation

### Prerequisites

- The DeepSeek Harness Web GUI is running (`dsh web`).
- This repository is cloned (or you have the contents of `host.js` / `client.js` at hand).
- The agent in the target session has the dynamic Cordis plugin tools (`cordis_define` / `cordis_run` / `cordis_inspect_*`).

### Option 1: let the DSH agent install it (recommended)

Send the following prompt in a new session:

```text
Use the dynamic Cordis plugin tools to install https://github.com/haoranwang0921/dsh-session-cleaner :
1. Read host.js and client.js from the repository (web_fetch, or git clone into the workspace and read).
2. Run cordis_inspect_list and cordis_inspect_query to confirm the runtime Host/Client services and Slots (follow the cordis-plugin-development skill flow).
3. Use cordis_define to create a new plugin: code.host = the body of host.js, code.client = the body of client.js.
4. Run the plugin with cordis_run; if it returns awaiting-approval, approve it on the Run card.
5. After success, report the plugin ID and point the user to "Settings → 会话管理" (Session Manager).
```

The agent completes creation, activation, and approval following the `cordis-plugin-development` skill.

### Option 2: install manually through the tools

1. Read `host.js` and `client.js`; take each file's `return { ... }` function body (the header comments are plain comments and may be included).
2. Call `cordis_define`:
   - `plugin.kind: "new"`, an `idPrefix` of your choice, 3–6 lowercase letters (e.g. `sessd`);
   - `code.host` = the body of `host.js`; `code.client` = the body of `client.js`.
3. Note the returned `pluginId` and `packageId`, then call `cordis_run` (mode `run`).
4. If it returns `awaiting-approval`, approve the run on the Run card.
5. Open **Settings → 会话管理** (Session Manager).

### Updating to a new version

- After changing the code, use `cordis_define` (`plugin.kind: "existing"` + the original `pluginId`) to append a new Package, then switch with `cordis_run` mode `update`.
- Rollback: `cordis_run` mode `run` + `currentPackageId`.
- Disable: `cordis_stop`; remove permanently: `cordis_undefine`.

> Note: a dynamic plugin is a temporary per-process extension; after a DSH restart, reload it by repeating the steps above.

## Deletion semantics (important)

DSH session logs are **append-only**:

- **Deleting a whole session**: physically removes the session's log directory — its records are gone for good (except content-addressed shared attachments).
- **Deleting a single message**: removes the target from the **model context** via the surface-replace mechanism (same semantics as `/compact`), but the original events remain in the log and in the human transcript; the message disappears from this plugin's list.

## File layout

- `host.js` — Host half: the `delete-session` / `list-messages` / `delete-message` RPC handlers.
- `client.js` — Browser half: the settings-page "Session Manager" grouped view and styles.
- `LICENSE` — Apache-2.0.

## Disclaimer

Deletion is irreversible. Confirm the target session/message before acting; the author is not responsible for data loss.

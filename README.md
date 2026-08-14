# dsh-session-cleaner

DeepSeek Harness 动态 Cordis 插件：在 Web GUI 设置页中管理并删除对话记录。

[English](README.en.md)

## 功能

- **删除整个会话**：归档会话并物理删除其持久化日志（JSONL 目录），同时清理该会话的消息反馈数据。
- **删除单条对话记录**：按用户消息分组展示对话内容；删除一条用户消息会级联删除它引发的所有助手回复与工具消息。
- **分组查看**：设置页「会话管理」中，点击一条用户消息可展开其引发的助手/工具消息，子消息可单独删除。
- **安全边界**：运行中的会话与当前会话不可删除（Host 端校验）。

## 运行环境

- [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) Web GUI（`dsh web`）
- 本插件通过 DSH 的**动态 Cordis 插件**机制加载（`cordis_define` / `cordis_run`），无需修改 DSH 源码，进程重启后需重新加载。

## 安装

### 前提

- 已启动 DeepSeek Harness Web GUI（`dsh web`）。
- 克隆本仓库（或记下 `host.js` / `client.js` 的内容）。
- 目标会话的代理可用动态 Cordis 插件工具（`cordis_define` / `cordis_run` / `cordis_inspect_*`）。

### 方式一：让 DSH 代理自动安装（推荐）

在新会话中发送以下提示词：

```text
请使用动态 Cordis 插件工具安装 https://github.com/haoranwang0921/dsh-session-cleaner ：
1. 读取仓库中的 host.js 与 client.js（用 web_fetch 或 git 克隆到工作区后 read）。
2. 调用 cordis_inspect_list 与 cordis_inspect_query 确认运行时的 Host/Client 服务与 Slots（按 cordis-plugin-development 技能的流程）。
3. 用 cordis_define 新建插件：code.host 为 host.js 的函数体，code.client 为 client.js 的函数体。
4. cordis_run 运行插件；若返回 awaiting-approval，在 Run 卡片上批准。
5. 运行成功后报告插件 ID，并说明前往「设置 → 会话管理」使用。
```

代理会按 `cordis-plugin-development` 技能的标准流程完成创建、运行与授权。

### 方式二：手动通过工具安装

1. 读取 `host.js` 与 `client.js`，取每个文件中 `return { ... }` 函数体部分（文件头注释是普通注释，包含无妨）。
2. 调用 `cordis_define`：
   - `plugin.kind: "new"`，`idPrefix` 自选 3–6 位小写字母（如 `sessd`）；
   - `code.host` = `host.js` 的函数体；`code.client` = `client.js` 的函数体。
3. 记录返回的 `pluginId` 与 `packageId`，调用 `cordis_run`（mode `run`）。
4. 若返回 `awaiting-approval`，在 Run 卡片上批准本次运行。
5. 打开 **设置 → 会话管理** 使用。

### 更新到新版本

- 修改代码后，用 `cordis_define`（`plugin.kind: "existing"` + 原 `pluginId`）追加新 Package，再用 `cordis_run` mode `update` 切换。
- 回滚：`cordis_run` mode `run` + `currentPackageId`。
- 停用：`cordis_stop`；永久删除：`cordis_undefine`。

> 注意：动态插件是进程内临时扩展，DSH 重启后需要重新加载（重新执行上面的步骤）。

## 删除语义（重要）

DSH 会话日志是 **append-only** 的：

- **删除整个会话**：物理删除该会话的日志目录，记录彻底移除（内容寻址的共享附件除外）。
- **删除单条消息**：通过 surface replace 机制把目标消息从**模型上下文**移除（与 `/compact` 压缩同款语义），但原始事件仍保留在日志与人类转录中；本插件列表中该消息会消失。

## 文件结构

- `host.js` — Host 端：`delete-session` / `list-messages` / `delete-message` 三个 RPC handler。
- `client.js` — 浏览器端：设置页「会话管理」分组视图与样式。
- `LICENSE` — Apache-2.0。

## 免责声明

删除操作不可逆。请在操作前确认目标会话/消息；作者不对数据丢失负责。

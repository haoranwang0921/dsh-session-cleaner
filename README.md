# dsh-session-cleaner

DeepSeek Harness 动态 Cordis 插件：在 Web GUI 设置页中管理并删除对话记录。

## 功能

- **删除整个会话**：归档会话并物理删除其持久化日志（JSONL 目录），同时清理该会话的消息反馈数据。
- **删除单条对话记录**：按用户消息分组展示对话内容；删除一条用户消息会级联删除它引发的所有助手回复与工具消息。
- **分组查看**：设置页「会话管理」中，点击一条用户消息可展开其引发的助手/工具消息，子消息可单独删除。
- **安全边界**：运行中的会话与当前会话不可删除（Host 端校验）。

## 运行环境

- [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) Web GUI（`dsh web`）
- 本插件通过 DSH 的**动态 Cordis 插件**机制加载（`cordis_define` / `cordis_run`），无需修改 DSH 源码，进程重启后需重新加载。

## 安装

1. 启动 DSH Web GUI。
2. 在会话中使用动态插件工具提交本仓库的 `host.js` 与 `client.js` 作为 `code.host` / `code.client`。
3. 批准插件运行（Run 卡片上授权）。
4. 打开 **设置 → 会话管理** 使用。

> 也可以先请求 `cordis-plugin-development` 技能，再让代理按上述文件内容创建并运行插件。

## 删除语义（重要）

DSH 会话日志是 **append-only** 的：

- **删除整个会话**：物理删除该会话的日志目录，记录彻底移除（内容寻址的共享附件除外）。
- **删除单条消息**：通过 surface replace 机制把目标消息从**模型上下文**移除（与 `/compact` 压缩同款语义），但原始事件仍保留在日志与人类转录中；本插件列表中该消息会消失。

## 文件结构

- `host.js` — Host 端：`delete-session` / `list-messages` / `delete-message` 三个 RPC handler。
- `client.js` — 浏览器端：设置页「会话管理」分组视图与样式。
- `LICENSE` — MIT。

## 免责声明

删除操作不可逆。请在操作前确认目标会话/消息；作者不对数据丢失负责。

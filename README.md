# dsh-session-cleaner

DeepSeek Harness Web GUI 插件：在设置页中管理并删除对话记录。

[English](README.en.md)

## 功能

- **删除整个会话**：归档会话并物理删除其持久化日志（JSONL 目录），同时清理该会话的消息反馈数据。
- **删除单条对话记录**：按用户消息分组展示对话内容；删除一条用户消息会级联删除它引发的所有助手回复与工具消息。
- **分组查看**：设置页「会话管理」中，点击一条用户消息可展开其引发的助手/工具消息，子消息可单独删除。
- **安全边界**：运行中的会话与当前会话不可删除（Host 端校验）。

## 运行环境

- [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) Web GUI（`dsh web`）。

## 安装（正式插件，随 DSH 启动自动加载）

本仓库是一个 **dual-face 插件包**：node half 运行在宿主进程（`/api/session-cleaner` 路由），browser half 通过 `dsh.client` 声明加载进 Web GUI。

```powershell
# 1. 安装到 profile（本地开发用 link 路径；或发布 npm 后用包名）
dsh plugin --profile web add link:C:\path\to\dsh-session-cleaner

# 2. 重启 dsh web
dsh web
```

安装后插件随 DSH 启动自动加载，**无需每次重新安装**。使用入口：**设置 → 会话管理**。

更新代码后无需重新构建（本仓库为纯 JS），重启 `dsh web` 即可。

### 工作原理

- `cordis.patch.yml`（`dsh.bundle.patch`）向 profile 组合插入一行 `session-cleaner` 插件。
- `package.json` 的 `dsh.client` 声明让浏览器半从 `/plugins/<id>/client.js` 加载；`exports["./client"]` 指向 bundle。
- node half 通过 `webServer` 注册 `/api/session-cleaner/*` 路由（仅回环访问），浏览器半通过 `fetch` 调用。

## 卸载 / 更新

```powershell
dsh plugin --profile web remove @haoranwang0921/dsh-session-cleaner
```

或直接编辑 `$DSH_HOME/cordis.patch.yml` / profile 的 `cordis.patch.yml`，把 `session-cleaner` 行禁用或删除。

## 删除语义（重要）

DSH 会话日志是 **append-only** 的：

- **删除整个会话**：物理删除该会话的日志目录，记录彻底移除（内容寻址的共享附件除外）。
- **删除单条消息**：通过 surface replace 机制把目标消息从**模型上下文**移除（与 `/compact` 压缩同款语义），但原始事件仍保留在日志与人类转录中；本插件列表中该消息会消失。

## 文件结构

- `lib/index.js` — node half（Host 端）：`/api/session-cleaner/*` 路由与删除逻辑。
- `lib/client.js` — browser half：设置页「会话管理」分组视图。
- `cordis.patch.yml` — bundle patch（向 profile 插入插件行）。
- `dynamic/` — 旧版动态 Cordis 插件格式（`cordis_define` / `cordis_run` 加载，DSH 重启后需重新加载），保留作参考。
- `LICENSE` — Apache-2.0。

## 免责声明

删除操作不可逆。请在操作前确认目标会话/消息；作者不对数据丢失负责。

# dsh-session-cleaner 改进计划

> 基于 2026-08-22 对全模块源码的逐行审查（`lib/index.js`、`lib/client.js`、`dynamic/host.js`、`dynamic/client.js`、`cordis.patch.yml`）。
> 优先级定义：P0 = 正确性/安全 bug，尽快修；P1 = 显著改善健壮性与体验；P2 = 打磨项。

## 0. 审查发现的实际 Bug（先修这些）

| # | 问题 | 位置 | 说明 |
|---|------|------|------|
| B1 | **删除接口无 CSRF 防护** | `lib/index.js:63-75` | `guard()` 只校验回环 + POST，不校验 `Content-Type`。恶意网页可用 `text/plain` 简单请求跨站打到 `127.0.0.1:3080` 的删除接口（简单请求不触发预检），受害者浏览器即可被驱使删会话。 |
| B2 | **物理删除无路径围栏** | `lib/index.js:112-126` | 仅检查 `dir` 非空/非 `/`/非 `.`，未校验该目录确实位于会话数据根目录之内。若 `persistence.locate` 返回异常路径，可能误删任意目录。且 `locate` 失败时静默跳过删除——会话被归档但磁盘记录残留，用户毫不知情。 |
| B3 | **归档失败被静默吞掉** | `lib/index.js:107` | `try { await registry.archiveSession(id) } catch {}`：归档失败后仍继续物理删除日志 → 侧边栏仍显示该会话但内容已被删，状态不一致且无任何提示。 |
| B4 | **非 live 追加的 seq 计算错误隐患** | `lib/index.js:262`、`dynamic/host.js:176` | `seq: events.length` 假设事件编号从 0 连续递增。若日志存在编号空洞或起始偏移，replace 事件的 seq 会与现有节点冲突，破坏 surface 折叠。应取 `max(existing seq)+1` 或由 persistence 提供下一个 seq。 |
| B5 | **运行中会话可被单条删除并发写** | `lib/index.js:185-275` | `delete-session` 拦截运行中会话，但 `delete-message` 不拦截：对 live 会话直接 `live.append(...)` 与 agent 循环并发追加，存在竞态。要么统一拦截，要么走会话自身的串行写入通道。 |
| B6 | **双实现已经漂移** | `lib/*` vs `dynamic/*` | legacy `dynamic/` 与正式 `lib/` 是两份手工拷贝的实现，已出现实际分歧：占位消息 `source.plugin` 一边是 `'sessdel'`（`dynamic/host.js:154,163`）、另一边是 `'dsh-session-cleaner'`（`lib/index.js:240,249`）；客户端过滤条件也随之不同（`lib/client.js:126` 过滤前者会失效于 dynamic 版本的数据）。 |

---

## 1. 清理逻辑优化

### 1.1 物理删除加路径围栏（P0，对应 B2）
- **目标**：只有确认目标目录位于会话数据根目录（如 `$DSH_HOME/sessions/<id>/`）之下才执行删除；`locate` 失败不再静默，返回带警告的成功响应或明确错误。
- **涉及文件**：`lib/index.js`（`handleDeleteSession`）。
- **预期效果**：杜绝误删任意目录；「归档成功但磁盘残留」从静默变为显式可见（响应含 `warnings` 字段，前端展示）。

### 1.2 归档失败不再吞错（P0，对应 B3）
- **目标**：`archiveSession` 失败时中止删除流程并返回 500（或降级为「仅归档」模式由用户选择），同时记录日志。
- **涉及文件**：`lib/index.js`。
- **预期效果**：不再产生「侧边栏还在、日志已删」的不一致状态。

### 1.3 统一单条删除对运行中会话的策略（P0，对应 B5）
- **目标**：`delete-message` 对 live 会话默认拒绝（与 `delete-session` 语义一致），或在文档明确声明支持并改用会话串行写入 API。
- **涉及文件**：`lib/index.js`（`handleDeleteMessage`）、`README.md`（删除语义章节）。
- **预期效果**：消除并发写竞态；行为可预期。

### 1.4 回收站式删除（软删除）（P1）
- **目标**：整会话删除先把日志目录改名/移动到 `.trash/<timestamp>-<sessionId>/`，保留 N 天后再真正清除；提供「恢复」能力。
- **涉及文件**：`lib/index.js`、`lib/client.js`（增加回收站入口）、新增 `lib/trash.js`。
- **预期效果**：缓解 README 免责声明里「删除不可逆」的风险，误删可救。

### 1.5 批量删除会话（P2）
- **目标**：`delete-sessions`（复数）路由接受 `sessionIds[]`，前端列表加多选框；逐个执行并汇总每条的成功/失败结果。
- **涉及文件**：`lib/index.js`、`lib/client.js`。
- **预期效果**：清理几十个旧会话不用逐个点。

### 1.6 收敛双实现（P1，对应 B6）
- **目标**：`dynamic/` 目录标记为 deprecated 并在下一版删除，或抽出共享核心模块让两边只保留薄壳；统一占位消息的 `source.plugin` 标识为单一常量。
- **涉及文件**：`dynamic/host.js`、`dynamic/client.js`、`lib/index.js`、`lib/client.js`、`README.md`。
- **预期效果**：消除两份拷贝的持续漂移；客户端过滤逻辑只依赖一个常量。

## 2. 错误处理增强

### 2.1 请求体校验细化（P1）
- **目标**：区分三种失败——超限（413 `body-too-large`）、JSON 解析失败（400 `bad-json`）、空 body（400 `empty-body`）；超限时停止消费流并销毁连接。校验 `Content-Type: application/json`（同时修复 B1）。
- **涉及文件**：`lib/index.js`（`readJsonBody`、`guard`）。
- **预期效果**：前端能给出准确错误提示；CSRF 简单请求被拒。

### 2.2 空 catch 最小化（P1）
- **目标**：所有 `catch {}` 至少改为 `catch (e) { log.warn(...) }`；feedback sidecar 清理失败汇总进响应的 `warnings` 数组而非丢弃。
- **涉及文件**：`lib/index.js`（4 处空 catch）。
- **预期效果**：故障可诊断；部分失败对用户透明。

### 2.3 错误信息规范化（P2）
- **目标**：统一 `String(error)` 为 `error instanceof Error ? error.message : String(error)`；错误响应固定结构 `{ ok, error, message, detail? }`。
- **涉及文件**：`lib/index.js`。
- **预期效果**：日志与前端展示不再出现 `[object Object]` 或冗余堆栈文本。

### 2.4 handler 级异常兜底（P1）
- **目标**：每个 route handler 外层包 try/catch，未捕获异常返回 500 JSON 而不是让连接挂起/崩溃；注册 `server` 错误监听。
- **涉及文件**：`lib/index.js`（routes 定义处）。
- **预期效果**：任何未知异常都不会造成无响应请求。

## 3. 性能与资源占用改进

### 3.1 消除 O(n²) 事件查找（P1）
- **目标**：`list-messages` / `delete-message` 中反复 `events.find(e => e.seq === s)` 改为构建一次 `Map<seq, event>` 后 O(1) 查找。
- **涉及文件**：`lib/index.js:166-181, 212, 222-227`。
- **预期效果**：长会话（数千事件）展开耗时从秒级降到毫秒级。

### 3.2 整会话删除改异步 rm（P1）
- **目标**：`rmSync` 换成 `fs.promises.rm`，避免大目录删除阻塞宿主进程事件循环（宿主还服务其他 API 路由）。
- **涉及文件**：`lib/index.js:16, 117`。
- **预期效果**：删除大会话期间 Web GUI 不卡顿。

### 3.3 list-messages 分页/懒加载（P2）
- **目标**：`inspect` 结果按需分页（`offset/limit` 参数），preview 截断在流式读取阶段完成；前端滚动加载。
- **涉及文件**：`lib/index.js`、`lib/client.js`。
- **预期效果**：超长会话首次展开内存占用可控。

### 3.4 feedback 批量清理（P2）
- **目标**：sidecar 反馈逐条 `await` 删除改为受控并发（如 `Promise.allSettled` 分批），失败项计入 warnings。
- **涉及文件**：`lib/index.js:129-141`。
- **预期效果**：反馈条目多的会话删除耗时线性下降。

### 3.5 客户端缓存失效策略（P2）
- **目标**：`messages[id]` 缓存增加 TTL 或在会话 `updatedAt` 变化时自动失效重新拉取。
- **涉及文件**：`lib/client.js:117-121`。
- **预期效果**：不再展示陈旧消息列表。

## 4. 配置参数灵活性提升

当前状态：**零配置**。所有阈值硬编码。建议引入插件 config（经 `cordis.patch.yml` 的 plugin `config` 字段传入 `apply(ctx)`）：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `previewMaxLength` | 120 | 消息预览截断长度 |
| `maxBodyBytes` | 1 MiB | 请求体上限 |
| `trash.enabled` / `trash.retentionDays` | false / 7 | 回收站开关与保留期（配合 1.4） |
| `allowDeleteLiveSessionMessages` | false | 是否允许对运行中会话做单条删除（配合 1.3） |
| `routePrefix` | `/api/session-cleaner` | 路由前缀 |
| `guidance.enabled` | true | 是否注入 system prompt 引导段 |

- **涉及文件**：`lib/index.js`（读取 config + 默认值合并）、`cordis.patch.yml`（示例注释）、`README.md`（配置文档）。
- **预期效果**：用户无需改源码即可调整行为；默认值保持当前语义，向后兼容。

## 5. 日志与可观测性完善

当前状态：**node half 完全没有日志**（唯一一处 `console.error` 在 legacy `dynamic/host.js:219`）。

### 5.1 结构化操作日志（P1）
- **目标**：每次删除操作记录一条结构化日志：时间、操作类型（session/message）、目标 sessionId/seq、级联数量、耗时 ms、结果（ok/warnings/errors）。优先接入 Cordis 的 logger 能力，退而求其次用带前缀的 `console`。
- **涉及文件**：`lib/index.js`。
- **预期效果**：「谁在什么时候删了什么」可追溯，出问题有第一手证据。

### 5.2 操作审计计数器（P2）
- **目标**：内存计数器（总删除会话数/消息数/失败数），暴露 `GET /api/session-cleaner/stats`；前端设置页显示累计统计。
- **涉及文件**：`lib/index.js`、`lib/client.js`。
- **预期效果**：一眼看到插件工作量与健康度。

### 5.3 dry-run 模式（P2）
- **目标**：请求带 `{ dryRun: true }` 时只计算将被删除的范围（会话大小、消息数、磁盘字节数）并返回，不执行删除；前端「删除」按钮旁提供「预览」。
- **涉及文件**：`lib/index.js`、`lib/client.js`。
- **预期效果**：删除前可评估影响范围，降低误删焦虑。

## 6. 单元测试覆盖补充

当前状态：**零测试**（仓库内无任何 `*.test.ts/js`、无 vitest 配置）。

### 6.1 纯函数单测（P0，最先做）
- **目标**：覆盖 `foldSurfaceNodes`（append / replace 正常折叠 / start-end 缺失退化 / 嵌套 replace / 乱序 seq）、`messagePreview`（空内容、非文本块、120 字截断）、`sourceKindOf` / `sourcePluginOf`（缺失、非对象、类型不对）。
- **涉及文件**：新增 `test/unit.test.js`（或将纯函数抽到 `lib/core.js` 以便导入）；根 `package.json` 加 `"test": "vitest run"` 与 devDependency。
- **预期效果**：surface 折叠这一最核心、最容易出隐性 bug 的逻辑有了回归保护网。

### 6.2 HTTP handler 集成测（P1）
- **目标**：用 mock `ctx`（fake `webServer.register` 捕获 handler + fake `sessions`/`sessionPersistence`/`workspaceRegistry`/`messageFeedback`）对三个路由做行为测试：
  - `delete-session`：正常删除 / live 会话 409 / 不存在 404 / persistence 异常 500 / 归档失败中止（验证 B3 修复）/ 路径围栏拒绝越界目录（验证 B2 修复）；
  - `delete-message`：级联范围正确 / 非 surface 409 / 非 user·assistant 类型 400 / seq 计算正确（验证 B4 修复）/ live 拦截（验证 B5 修复）；
  - `guard`：非回环 403 / GET 405 / 非 JSON Content-Type 拒绝（验证 B1 修复）/ body 超限 413。
- **涉及文件**：新增 `test/routes.test.js`。
- **预期效果**：每个 bug 修复都有对应测试锁定，防回归。

### 6.3 测试基建（P1）
- **目标**：接入 vitest（与主仓一致），`pnpm test` 可跑；CI（GitHub Actions）跑 lint + test。
- **涉及文件**：`package.json`、新增 `vitest.config.js`、`.github/workflows/ci.yml`。
- **预期效果**：为 awesome-dsh-plugin 收录后的社区贡献建立质量门禁；顺带补 commit 数。

---

## 建议实施顺序

1. **第一批（P0，bug 修复 + 锁测试）**：B1–B5 → 6.1 + 6.2 中对应的回归测试 → 6.3 基建。
2. **第二批（P1）**：1.4 回收站、1.6 收敛双实现、2.x 错误处理、3.1/3.2 性能、4 配置化、5.1 日志。
3. **第三批（P2）**：批量删除、分页、统计面板、dry-run、其余打磨项。

每批完成后 bump 版本号（1.0.0 → 1.1.0 → 1.2.0）并在 README 更新变更说明——同时天然为 GitHub 仓库补充 commit（当前 6 个，收录门槛 ≥10）。

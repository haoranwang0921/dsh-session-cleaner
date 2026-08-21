/**
 * dsh-session-cleaner — node half (host process).
 *
 * Dual-face plugin for the dsh web GUI: manages and deletes conversation
 * records from the settings page. This half runs in the host process and
 * exposes the /api/session-cleaner HTTP routes the browser half calls.
 *
 * Deletion semantics:
 * - Whole session: archive + physically remove the durable JSONL directory.
 * - Single message: surface-replace (compact-style) — removed from the model
 *   context; the append-only log keeps the original events for the human
 *   transcript. Deleting a user message cascades to its assistant replies and
 *   tool results.
 */

import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Model-facing announcement, in the deployment's product-copy language. */
const GUIDANCE = '本机已安装 dsh-session-cleaner 插件（DSH Web GUI 会话管理）：设置页「会话管理」入口，在 dsh-session-cleaner 仓库维护。能力：删除整个会话（归档并物理删除日志）；按用户消息分组浏览会话内容，删除单条对话记录（删除用户消息会级联删除其引发的助手与工具消息）。限制：运行中/当前会话不可删除；单条删除只从模型上下文移除，人类转录保留原文。用户提到「删除对话记录 / 会话管理 / 删除单条消息」时即指本插件，请据此协作。'

export const name = 'dsh-session-cleaner'

export const inject = ['webServer']

export function apply(ctx) {
  const routes = [
    {
      kind: 'exact',
      path: '/api/session-cleaner/delete-session',
      handler: (req, res) => { void handleDeleteSession(ctx, req, res) },
    },
    {
      kind: 'exact',
      path: '/api/session-cleaner/list-messages',
      handler: (req, res) => { void handleListMessages(ctx, req, res) },
    },
    {
      kind: 'exact',
      path: '/api/session-cleaner/delete-message',
      handler: (req, res) => { void handleDeleteMessage(ctx, req, res) },
    },
  ]

  ctx.effect(() => {
    const disposers = routes.map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-session-cleaner: api routes')

  const prompt = ctx.get('systemPrompt')
  if (prompt !== undefined) {
    ctx.effect(() => prompt.section({
      name: 'plugin:dsh-session-cleaner',
      order: 150,
      text: GUIDANCE,
    }), 'dsh-session-cleaner: guidance section')
  }
}

/** Loopback-only fence plus method/content checks: POST JSON for every route.
 *
 * Requiring `content-type: application/json` also blocks cross-site "simple
 * requests": a malicious web page can drive the victim browser against
 * 127.0.0.1 with a text/plain POST without a CORS preflight, so method and
 * loopback checks alone are not sufficient CSRF protection.
 */
async function guard(req, res) {
  const remote = req.socket?.remoteAddress ?? ''
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  if (!loopback) {
    writeJson(res, 403, { ok: false, error: 'forbidden', message: '仅允许本机回环请求' })
    return false
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'method', message: '仅支持 POST' })
    return false
  }
  const contentType = String(req.headers['content-type'] ?? '')
  if (!contentType.toLowerCase().includes('application/json')) {
    writeJson(res, 415, { ok: false, error: 'unsupported-media-type', message: 'Content-Type 必须为 application/json' })
    return false
  }
  return true
}

async function handleDeleteSession(ctx, req, res) {
  if (!(await guard(req, res))) return
  const body = await readJsonBody(req)
  if (body === undefined) return writeJson(res, 400, { ok: false, error: 'bad-body', message: '请求体必须是 JSON' })
  const sessionId = String(body.sessionId ?? '')
  if (sessionId === '') return writeJson(res, 400, { ok: false, error: 'missing-session-id', message: '缺少会话 ID' })

  const sessions = ctx.get('sessions')
  if (sessions !== undefined && sessions.get(sessionId) !== undefined) {
    return writeJson(res, 409, { ok: false, error: 'live-session', message: '该会话正在运行，无法删除；请先关闭或等待其结束' })
  }

  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) {
    return writeJson(res, 503, { ok: false, error: 'no-persistence', message: '会话持久化服务不可用' })
  }
  let meta
  try {
    const headers = await persistence.list()
    meta = headers.find(h => h.id === sessionId)
  } catch (error) {
    return writeJson(res, 500, { ok: false, error: 'list-failed', message: String(error) })
  }
  if (meta === undefined) {
    return writeJson(res, 404, { ok: false, error: 'not-found', message: '未找到该会话的持久化记录' })
  }

  // Archive first so the session disappears from the sidebar immediately.
  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined) {
    try { await registry.archiveSession(sessionId) } catch {}
  }

  // Physically remove the session-owned directory (contains the JSONL log).
  let location
  try { location = persistence.locate(meta) } catch { location = undefined }
  if (location !== undefined && location.path !== undefined) {
    const dir = dirname(String(location.path))
    if (dir !== '' && dir !== '/' && dir !== '.') {
      try {
        // Async so a large directory removal does not block the host event
        // loop (the host serves other API routes concurrently).
        await rm(dir, { recursive: true, force: true })
      } catch (error) {
        return writeJson(res, 500, {
          ok: false,
          error: 'delete-failed',
          message: '删除日志文件失败：' + String(error) + '；会话已归档但记录仍在磁盘上',
        })
      }
    }
  }

  // Best-effort: clean up the session's message-feedback sidecar.
  const feedback = ctx.get('messageFeedback')
  if (feedback !== undefined) {
    try {
      const listed = await feedback.list({ sessionId })
      if (listed && listed.ok === true && Array.isArray(listed.value.items)) {
        for (const item of listed.value.items) {
          try {
            await feedback.delete({ sessionId, messageId: item.messageId, ifVersion: item.version })
          } catch {}
        }
      }
    } catch {}
  }

  return writeJson(res, 200, { ok: true, sessionId })
}

async function handleListMessages(ctx, req, res) {
  if (!(await guard(req, res))) return
  const body = await readJsonBody(req)
  if (body === undefined) return writeJson(res, 400, { ok: false, error: 'bad-body', message: '请求体必须是 JSON' })
  const sessionId = String(body.sessionId ?? '')
  if (sessionId === '') return writeJson(res, 400, { ok: false, error: 'missing-session-id', message: '缺少会话 ID' })

  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) {
    return writeJson(res, 503, { ok: false, error: 'no-persistence', message: '会话持久化服务不可用' })
  }
  let inspection
  try {
    inspection = await persistence.inspect(sessionId)
  } catch (error) {
    return writeJson(res, 500, { ok: false, error: 'read-failed', message: String(error) })
  }

  const events = inspection.events ?? []
  const bySeq = indexEventsBySeq(events)
  const nodes = foldSurfaceNodes(events)
  const messages = nodes.map(seq => {
    const event = bySeq.get(seq)
    if (event === undefined) return null
    const role = event.type === 'user/message' ? 'user'
      : event.type === 'assistant/message' ? 'assistant'
        : event.type === 'tool/result' ? 'tool' : 'other'
    return {
      seq: event.seq,
      type: event.type,
      role,
      preview: messagePreview(event),
      time: event.time,
      source: sourceKindOf(event),
      sourcePlugin: sourcePluginOf(event),
    }
  }).filter(m => m !== null)
  return writeJson(res, 200, { ok: true, sessionId, messages })
}

async function handleDeleteMessage(ctx, req, res) {
  if (!(await guard(req, res))) return
  const body = await readJsonBody(req)
  if (body === undefined) return writeJson(res, 400, { ok: false, error: 'bad-body', message: '请求体必须是 JSON' })
  const sessionId = String(body.sessionId ?? '')
  const seq = Number(body.seq)
  if (sessionId === '') return writeJson(res, 400, { ok: false, error: 'missing-session-id', message: '缺少会话 ID' })
  if (!Number.isSafeInteger(seq) || seq < 0) return writeJson(res, 400, { ok: false, error: 'bad-seq', message: '消息序号无效' })

  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  // Live sessions are off-limits for message deletion too: appending a
  // surface-replace event while the agent loop is writing would race with it
  // (same policy as delete-session).
  if (sessions !== undefined && sessions.get(sessionId) !== undefined) {
    return writeJson(res, 409, { ok: false, error: 'live-session', message: '该会话正在运行，无法删除其中的消息；请先关闭或等待其结束' })
  }
  if (persistence === undefined) {
    return writeJson(res, 503, { ok: false, error: 'no-persistence', message: '会话持久化服务不可用' })
  }
  let inspection
  try {
    inspection = await persistence.inspect(sessionId)
  } catch (error) {
    return writeJson(res, 500, { ok: false, error: 'read-failed', message: String(error) })
  }

  const events = inspection.events ?? []
  const bySeq = indexEventsBySeq(events)
  const nodes = foldSurfaceNodes(events)
  const idx = nodes.indexOf(seq)
  if (idx === -1) {
    return writeJson(res, 409, { ok: false, error: 'not-on-surface', message: '该消息不在当前对话表面（可能已被删除）' })
  }
  const target = bySeq.get(seq)
  if (target === undefined || (target.type !== 'user/message' && target.type !== 'assistant/message')) {
    return writeJson(res, 400, { ok: false, error: 'unsupported-type', message: '只能删除用户或助手消息' })
  }

  // Cascade: deleting a user message shadows every surface node after it up
  // to the next user message (its assistant replies and tool results).
  let shadowedSeqs
  if (target.type === 'user/message') {
    shadowedSeqs = [seq]
    for (let i = idx + 1; i < nodes.length; i++) {
      const s = nodes[i]
      const ev = bySeq.get(s)
      if (ev !== undefined && ev.type === 'user/message') break
      shadowedSeqs.push(s)
    }
  } else {
    shadowedSeqs = [seq]
  }
  const start = seq
  const end = shadowedSeqs[shadowedSeqs.length - 1]

  const now = Date.now()
  const placeholder = target.type === 'user/message'
    ? {
        id: 'sessdel-' + now + '-' + seq,
        role: 'user',
        content: [{ type: 'text', text: '（此条对话记录已删除）' }],
        source: { kind: 'plugin', plugin: 'dsh-session-cleaner', form: 'notice', summary: '此条对话记录已删除' },
      }
    : {
        turn: target.data.turn,
        step: target.data.step,
        message: {
          id: 'sessdel-' + now + '-' + seq,
          role: 'assistant',
          content: [{ type: 'text', text: '（此条对话记录已删除）' }],
          source: { kind: 'model', provider: 'dsh-session-cleaner', model: 'deleted' },
        },
      }
  const intent = { surfaceOp: { op: 'replace', start, end }, sourceEventSeqs: shadowedSeqs }

  try {
    await persistence.append(sessionId, [{
      type: target.type,
      seq: events.reduce((max, e) => (typeof e.seq === 'number' && e.seq > max ? e.seq : max), -1) + 1,
      time: now,
      data: placeholder,
      surfaceOp: intent.surfaceOp,
      sourceEventSeqs: intent.sourceEventSeqs,
    }])
  } catch (error) {
    return writeJson(res, 500, { ok: false, error: 'append-failed', message: '删除失败：' + String(error) })
  }

  return writeJson(res, 200, { ok: true, sessionId, seq, shadowed: shadowedSeqs })
}

/**
 * Fold the surface: the event seqs currently on the model-visible surface, in
 * surface order. Replace nodes occupy the position of the range they shadow
 * (same semantics as the core surface fold).
 */
function foldSurfaceNodes(events) {
  const nodes = []
  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'tool/result') continue
    const op = event.surfaceOp
    if (op === undefined || op === 'append') {
      nodes.push(event.seq)
      continue
    }
    if (op !== null && typeof op === 'object' && op.op === 'replace') {
      const startIdx = nodes.indexOf(op.start)
      const endIdx = nodes.indexOf(op.end)
      if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
        nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
      } else {
        nodes.push(event.seq)
      }
    }
  }
  return nodes
}

/** O(1) seq -> event lookup index (replaces repeated events.find scans). */
function indexEventsBySeq(events) {
  const bySeq = new Map()
  for (const event of events) bySeq.set(event.seq, event)
  return bySeq
}

export { foldSurfaceNodes, indexEventsBySeq, messagePreview, sourceKindOf, sourcePluginOf }

function messagePreview(event) {
  const blocks = event.data && event.data.message && Array.isArray(event.data.message.content)
    ? event.data.message.content
    : event.data && Array.isArray(event.data.content) ? event.data.content : []
  const text = blocks
    .map(block => block && block.type === 'text' && typeof block.text === 'string' ? block.text : '')
    .join(' ')
    .trim()
  if (text === '') return ''
  return text.length > 120 ? text.slice(0, 120) + '…' : text
}

/** The message's source.kind (string or null) — never undefined. */
function sourceKindOf(event) {
  const holder = event.data && event.data.message && event.data.message.source
    ? event.data.message.source
    : event.data && event.data.source ? event.data.source : null
  if (holder !== null && typeof holder === 'object' && typeof holder.kind === 'string') {
    return holder.kind
  }
  return null
}

/** The message's source.plugin (string or null) — never undefined. */
function sourcePluginOf(event) {
  const holder = event.data && event.data.message && event.data.message.source
    ? event.data.message.source
    : event.data && event.data.source ? event.data.source : null
  if (holder !== null && typeof holder === 'object' && typeof holder.plugin === 'string') {
    return holder.plugin
  }
  return null
}

/** Read a bounded JSON body; undefined on absence or parse failure. */
async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) return undefined
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

// dsh-session-cleaner — Host half
// DeepSeek Harness dynamic Cordis plugin. This file is the `code.host` body:
// it is evaluated as the body of an async function and must `return` a plugin.
return {
  apply(ctx) {
    harness.handle('delete-session', async (args) => {
      const sessionId = String(args && typeof args === 'object' ? args.sessionId ?? '' : '')
      if (sessionId === '') return { ok: false, error: 'missing-session-id', message: '缺少会话 ID' }

      const sessions = ctx.get('sessions')
      if (sessions !== undefined && sessions.get(sessionId) !== undefined) {
        return { ok: false, error: 'live-session', message: '该会话正在运行，无法删除；请先关闭或等待其结束' }
      }

      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) {
        return { ok: false, error: 'no-persistence', message: '会话持久化服务不可用' }
      }
      let meta
      try {
        const headers = await persistence.list()
        meta = headers.find(h => h.id === sessionId)
      } catch (error) {
        return { ok: false, error: 'list-failed', message: String(error) }
      }
      if (meta === undefined) {
        return { ok: false, error: 'not-found', message: '未找到该会话的持久化记录' }
      }

      const registry = ctx.get('workspaceRegistry')
      if (registry !== undefined) {
        try { await registry.archiveSession(sessionId) } catch {}
      }

      let location
      try { location = persistence.locate(meta) } catch { location = undefined }
      if (location !== undefined && location.path !== undefined) {
        const filePath = String(location.path)
        const dir = filePath.replace(/[\\/][^\\/]*$/, '')
        if (dir !== '' && dir !== '/' && dir !== '.') {
          const subprocess = ctx.get('subprocess')
          if (subprocess === undefined) {
            return { ok: false, error: 'no-subprocess', message: '子进程服务不可用，无法删除日志文件' }
          }
          const code = await runDelete(subprocess, dir)
          if (code !== 0) {
            return { ok: false, error: 'delete-failed', message: '删除日志文件失败（退出码 ' + code + '），会话已归档但记录仍在磁盘上' }
          }
        }
      }

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

      return { ok: true, sessionId }
    })

    harness.handle('list-messages', async (args) => {
      const sessionId = String(args && typeof args === 'object' ? args.sessionId ?? '' : '')
      if (sessionId === '') return { ok: false, error: 'missing-session-id', message: '缺少会话 ID' }
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) {
        return { ok: false, error: 'no-persistence', message: '会话持久化服务不可用' }
      }
      let inspection
      try {
        inspection = await persistence.inspect(sessionId)
      } catch (error) {
        return { ok: false, error: 'read-failed', message: String(error) }
      }
      const events = inspection.events || []
      const nodes = foldSurfaceNodes(events)
      const messages = nodes.map(seq => {
        const event = events.find(e => e.seq === seq)
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
      return { ok: true, sessionId, messages }
    })

    harness.handle('delete-message', async (args) => {
      const sessionId = String(args && typeof args === 'object' ? args.sessionId ?? '' : '')
      const seq = args && typeof args === 'object' ? Number(args.seq) : NaN
      if (sessionId === '') return { ok: false, error: 'missing-session-id', message: '缺少会话 ID' }
      if (!Number.isSafeInteger(seq) || seq < 0) return { ok: false, error: 'bad-seq', message: '消息序号无效' }

      const sessions = ctx.get('sessions')
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) {
        return { ok: false, error: 'no-persistence', message: '会话持久化服务不可用' }
      }
      let inspection
      try {
        inspection = await persistence.inspect(sessionId)
      } catch (error) {
        return { ok: false, error: 'read-failed', message: String(error) }
      }
      const events = inspection.events || []
      const nodes = foldSurfaceNodes(events)
      const idx = nodes.indexOf(seq)
      if (idx === -1) {
        return { ok: false, error: 'not-on-surface', message: '该消息不在当前对话表面（可能已被删除）' }
      }
      const target = events.find(e => e.seq === seq)
      if (target === undefined || (target.type !== 'user/message' && target.type !== 'assistant/message')) {
        return { ok: false, error: 'unsupported-type', message: '只能删除用户或助手消息' }
      }

      // 级联范围：删除用户消息时，把其后直到下一条用户消息之前的所有表面节点
      // （助手回复、工具结果）一起 shadowed。
      let shadowedSeqs
      if (target.type === 'user/message') {
        shadowedSeqs = [seq]
        for (let i = idx + 1; i < nodes.length; i++) {
          const s = nodes[i]
          const ev = events.find(e => e.seq === s)
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
            source: { kind: 'plugin', plugin: 'sessdel', form: 'notice', summary: '此条对话记录已删除' },
          }
        : {
            turn: target.data.turn,
            step: target.data.step,
            message: {
              id: 'sessdel-' + now + '-' + seq,
              role: 'assistant',
              content: [{ type: 'text', text: '（此条对话记录已删除）' }],
              source: { kind: 'model', provider: 'sessdel', model: 'deleted' },
            },
          }
      const intent = { surfaceOp: { op: 'replace', start, end }, sourceEventSeqs: shadowedSeqs }

      try {
        const live = sessions !== undefined ? sessions.get(sessionId) : undefined
        if (live !== undefined) {
          live.append(target.type, placeholder, intent)
          await sessions.flush(live)
        } else {
          const event = {
            type: target.type,
            // Seq must not collide with existing events even if the log has gaps.
            seq: events.reduce((max, e) => (typeof e.seq === 'number' && e.seq > max ? e.seq : max), -1) + 1,
            time: now,
            data: placeholder,
            surfaceOp: intent.surfaceOp,
            sourceEventSeqs: intent.sourceEventSeqs,
          }
          await persistence.append(sessionId, [event])
        }
      } catch (error) {
        return { ok: false, error: 'append-failed', message: '删除失败：' + String(error) }
      }

      return { ok: true, sessionId, seq, shadowed: shadowedSeqs }
    })

    async function runDelete(subprocess, dir) {
      let argv
      let nodePath
      try { nodePath = await subprocess.resolveExecutable('node') } catch { nodePath = undefined }
      if (nodePath !== undefined) {
        argv = [nodePath, '-e', "require('fs').rmSync(process.argv[1], { recursive: true, force: true })", dir]
      } else {
        let windows = false
        try { await subprocess.resolveExecutable('cmd.exe'); windows = true } catch { windows = false }
        if (windows) {
          const ps = await subprocess.resolveExecutable('powershell.exe')
          const quoted = "'" + dir.replace(/'/g, "''") + "'"
          argv = [ps, '-NoProfile', '-NonInteractive', '-Command', 'Remove-Item -LiteralPath ' + quoted + ' -Recurse -Force -ErrorAction SilentlyContinue']
        } else {
          const rm = await subprocess.resolveExecutable('rm')
          argv = [rm, '-rf', '--', dir]
        }
      }
      const handle = subprocess.spawn({
        argv,
        cwd: '/',
        stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
        graceMs: 30000,
      })
      try {
        const outcome = await handle.done
        return outcome.exitCode === null ? 1 : outcome.exitCode
      } catch (error) {
        console.error('session-delete spawn failed', error)
        return -1
      }
    }

    // 折叠表面：返回当前仍在模型表面上的事件 seq（按表面顺序）。
    // replace 节点原位替换被 shadowed 的范围（与 foldSurface 语义一致）。
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

    function messagePreview(event) {
      const blocks = event.data && event.data.message && Array.isArray(event.data.message.content)
        ? event.data.message.content
        : event.data && Array.isArray(event.data.content) ? event.data.content : []
      const text = blocks.map(block => block && block.type === 'text' && typeof block.text === 'string' ? block.text : '').join(' ').trim()
      if (text === '') return ''
      return text.length > 120 ? text.slice(0, 120) + '…' : text
    }

    // 读取消息的 source.kind（字符串或 null），永不返回 undefined。
    function sourceKindOf(event) {
      const holder = event.data && event.data.message && event.data.message.source
        ? event.data.message.source
        : event.data && event.data.source
          ? event.data.source
          : null
      if (holder !== null && typeof holder === 'object' && typeof holder.kind === 'string') {
        return holder.kind
      }
      return null
    }

    // 读取消息的 source.plugin（字符串或 null），永不返回 undefined。
    function sourcePluginOf(event) {
      const holder = event.data && event.data.message && event.data.message.source
        ? event.data.message.source
        : event.data && event.data.source
          ? event.data.source
          : null
      if (holder !== null && typeof holder === 'object' && typeof holder.plugin === 'string') {
        return holder.plugin
      }
      return null
    }
  },
}

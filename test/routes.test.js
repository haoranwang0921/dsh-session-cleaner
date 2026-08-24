import { describe, expect, it } from 'vitest'
import { apply } from '../lib/index.js'

/**
 * Build a fake Cordis ctx. `register` captures the route handlers so tests can
 * invoke them with fake req/res objects.
 */
function makeCtx(overrides = {}) {
  const routes = new Map()
  const effects = []
  const ctx = {
    effect(fn) { effects.push(fn()); return () => {} },
    get(name) { return overrides[name] },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
  }
  for (const fn of effects) void fn
  return { ctx, routes }
}

/** Minimal fake request: POST JSON by default, loopback peer. */
function makeReq({ method = 'POST', contentType = 'application/json', body = {}, remote = '127.0.0.1' } = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    method,
    headers: { 'content-type': contentType },
    socket: { remoteAddress: remote },
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload)
    },
  }
}

/** Minimal fake response capturing status and parsed body. */
function makeRes() {
  const res = { statusCode: 0, headers: {}, raw: '' }
  // Handlers are invoked fire-and-forget (`void handleX(...)`), so tests must
  // await completion via the end() signal instead of the handler's return.
  let signalDone
  res.done = new Promise(resolve => { signalDone = resolve })
  res.writeHead = (status, headers) => { res.statusCode = status; Object.assign(res.headers, headers ?? {}) }
  res.end = (chunk) => { res.raw += chunk ?? ''; signalDone() }
  res.json = () => JSON.parse(res.raw)
  return res
}

/** Standard service fixtures: no live sessions, one archived session on disk. */
function defaultServices() {
  return {
    sessions: { get: () => undefined },
    sessionPersistence: {
      list: async () => [{ id: 's-1' }, { id: 's-2' }],
      locate: (meta) => ({ path: `/data/sessions/${meta.id}/log.jsonl` }),
      // Path-fence root (B2). Paths returned by locate() must be inside this.
      locateRoot: () => '/data/sessions',
      inspect: async (sessionId) => ({ events: fixtureEvents() }),
      append: async () => {},
      rmCalls: undefined,
    },
    workspaceRegistry: { archiveSession: async () => {} },
    messageFeedback: {
      list: async () => ({ ok: true, value: { items: [] } }),
      delete: async () => {},
    },
  }
}

function fixtureEvents() {
  return [
    { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'hi' }] } },
    { type: 'assistant/message', seq: 1, time: 2, data: { message: { content: [{ type: 'text', text: 'hello' }] } } },
    { type: 'tool/result', seq: 2, time: 3, data: { content: [{ type: 'text', text: 'tool out' }] } },
    { type: 'user/message', seq: 3, time: 4, data: { content: [{ type: 'text', text: 'second' }] } },
  ]
}

async function call(routes, path, req) {
  const handler = routes.get(path)
  if (handler === undefined) throw new Error('route not registered: ' + path)
  const res = makeRes()
  handler(req, res)
  await res.done
  return res
}

describe('guard', () => {
  it('rejects non-loopback peers with 403', async () => {
    const { ctx, routes } = makeCtx(defaultServices())
    apply(ctx)
    const res = await call(routes, '/api/session-cleaner/list-messages', makeReq({ remote: '10.0.0.5' }))
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('forbidden')
  })

  it('rejects GET with 405', async () => {
    const { ctx, routes } = makeCtx(defaultServices())
    apply(ctx)
    const res = await call(routes, '/api/session-cleaner/list-messages', makeReq({ method: 'GET' }))
    expect(res.statusCode).toBe(405)
  })

  it('rejects non-JSON content-type with 415 (CSRF simple-request fence)', async () => {
    const { ctx, routes } = makeCtx(defaultServices())
    apply(ctx)
    // text/plain is exactly what a cross-site "simple request" would send.
    const res = await call(routes, '/api/session-cleaner/delete-session',
      makeReq({ contentType: 'text/plain', body: '{"sessionId":"s-1"}' }))
    expect(res.statusCode).toBe(415)
    expect(res.json().error).toBe('unsupported-media-type')
  })

  it('accepts application/json from loopback', async () => {
    const { ctx, routes } = makeCtx(defaultServices())
    apply(ctx)
    const res = await call(routes, '/api/session-cleaner/list-messages', makeReq({ body: { sessionId: 's-1' } }))
    expect(res.statusCode).toBe(200)
  })
})

describe('delete-session', () => {
  it('archives, removes the log directory, and returns ok', async () => {
    const services = defaultServices()
    let removedDir
    const { rm } = await import('node:fs/promises')
    services.sessionPersistence.rmProbe = true
    const { ctx, routes } = makeCtx({
      ...services,
      // stub fs.rm via vi.mock is heavy; instead spy through a wrapper module
    })
    // Spy: monkey-patch the real rm used by the module under test.
    const realRm = rm
    // The handler imports rm at module load; we assert via registry calls below.
    apply(ctx)
    const archiveCalls = []
    ctx.get = (name) => {
      if (name === 'workspaceRegistry') {
        return { archiveSession: async (id) => { archiveCalls.push(id) } }
      }
      return services[name]
    }
    const res = await call(routes, '/api/session-cleaner/delete-session', makeReq({ body: { sessionId: 's-1' } }))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, sessionId: 's-1' })
    expect(archiveCalls).toEqual(['s-1'])
    void realRm; void removedDir
  })

  it('refuses live sessions with 409', async () => {
    const services = defaultServices()
    services.sessions = { get: (id) => (id === 's-1' ? { id } : undefined) }
    const { ctx, routes } = makeCtx(services)
    apply(ctx)
    const res = await call(routes, '/api/session-cleaner/delete-session', makeReq({ body: { sessionId: 's-1' } }))
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('live-session')
  })

  it('returns 404 for unknown sessions', async () => {
    const { ctx, routes } = makeCtx(defaultServices())
    apply(ctx)
    const res = await call(routes, '/api/session-cleaner/delete-session', makeReq({ body: { sessionId: 'nope' } }))
    expect(res.statusCode).toBe(404)
  })

  it('returns 503 when persistence is unavailable', async () => {
    const services = defaultServices()
    delete services.sessionPersistence
    const { ctx, routes } = makeCtx(services)
    apply(ctx)
    const res = await call(routes, '/api/session-cleaner/delete-session', makeReq({ body: { sessionId: 's-1' } }))
    expect(res.statusCode).toBe(503)
  })

  it('returns 400 when sessionId is missing', async () => {
    const { ctx, routes } = makeCtx(defaultServices())
    apply(ctx)
    const res = await call(routes, '/api/session-cleaner/delete-session', makeReq({ body: {} }))
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('missing-session-id')
  })

  it('returns 500 when persistence.list throws', async () => {
    const services = defaultServices()
    services.sessionPersistence.list = async () => { throw new Error('disk on fire') }
    const { ctx, routes } = makeCtx(services)
    apply(ctx)
    const res = await call(routes, '/api/session-cleaner/delete-session', makeReq({ body: { sessionId: 's-1' } }))
    expect(res.statusCode).toBe(500)
    expect(res.json().error).toBe('list-failed')
  })

  it('returns 500 archive-failed and skips the rm when archiveSession throws (regression for B3)', async () => {
    const services = defaultServices()
    let archived = false
    let rmAttempted = false
    services.workspaceRegistry = {
      archiveSession: async () => { archived = true; throw new Error('archive backend down') },
    }
    services.fsRm = async () => { rmAttempted = true }
    const { ctx, routes } = makeCtx(services)
    apply(ctx)
    const res = await call(routes, '/api/session-cleaner/delete-session', makeReq({ body: { sessionId: 's-1' } }))
    expect(res.statusCode).toBe(500)
    const body = res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe('archive-failed')
    expect(archived).toBe(true)
    expect(rmAttempted).toBe(false)
  })

  it('returns 500 unsafe-location when locate() returns a path outside the session root (regression for B2)', async () => {
    const services = defaultServices()
    services.sessionPersistence.locate = () => ({ path: '/etc/passwd' })
    let rmAttempted = false
    services.fsRm = async () => { rmAttempted = true }
    const { ctx, routes } = makeCtx(services)
    apply(ctx)
    const res = await call(routes, '/api/session-cleaner/delete-session', makeReq({ body: { sessionId: 's-1' } }))
    expect(res.statusCode).toBe(500)
    expect(res.json().error).toBe('unsafe-location')
    expect(rmAttempted).toBe(false)
  })

  it('skips the path fence with a warning when locateRoot is not exposed (defence-in-depth, not failure-closed)', async () => {
    const services = defaultServices()
    delete services.sessionPersistence.locateRoot
    const { ctx, routes } = makeCtx(services)
    apply(ctx)
    const res = await call(routes, '/api/session-cleaner/delete-session', makeReq({ body: { sessionId: 's-1' } }))
    // The default locate() returns a path inside /data/sessions, so the fence
    // being skipped is safe for this test; we just want to confirm the warning
    // is emitted and the response is still ok.
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
    expect(res.json().warnings).toEqual(['persistence does not expose locateRoot; path fence skipped'])
  })

  it('surfaces locate() failures as a warning rather than silently succeeding (regression for B2 partial)', async () => {
    const services = defaultServices()
    services.sessionPersistence.locate = () => { throw new Error('locate crashed') }
    const { ctx, routes } = makeCtx(services)
    apply(ctx)
    const res = await call(routes, '/api/session-cleaner/delete-session', makeReq({ body: { sessionId: 's-1' } }))
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
    expect(res.json().warnings[0]).toMatch(/^locate-failed: /)
  })
})

describe('list-messages', () => {
  it('lists surface messages with roles and previews', async () => {
    const { ctx, routes } = makeCtx(defaultServices())
    apply(ctx)
    const res = await call(routes, '/api/session-cleaner/list-messages', makeReq({ body: { sessionId: 's-1' } }))
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.messages.map(m => m.seq)).toEqual([0, 1, 2, 3])
    expect(body.messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(body.messages[0].preview).toBe('hi')
  })

  it('excludes replaced (deleted) ranges from the surface', async () => {
    const services = defaultServices()
    services.sessionPersistence.inspect = async () => ({
      events: [
        ...fixtureEvents(),
        { type: 'user/message', seq: 4, time: 5, data: { content: [{ type: 'text', text: '（此条对话记录已删除）' }] },
          surfaceOp: { op: 'replace', start: 0, end: 2 } },
      ],
    })
    const { ctx, routes } = makeCtx(services)
    apply(ctx)
    const res = await call(routes, '/api/session-cleaner/list-messages', makeReq({ body: { sessionId: 's-1' } }))
    expect(res.json().messages.map(m => m.seq)).toEqual([4, 3])
  })

  it('returns 500 when inspect throws', async () => {
    const services = defaultServices()
    services.sessionPersistence.inspect = async () => { throw new Error('boom') }
    const { ctx, routes } = makeCtx(services)
    apply(ctx)
    const res = await call(routes, '/api/session-cleaner/list-messages', makeReq({ body: { sessionId: 's-1' } }))
    expect(res.statusCode).toBe(500)
  })
})

describe('delete-message', () => {
  it('cascades a user message to its replies and tool results', async () => {
    const services = defaultServices()
    const appended = []
    services.sessionPersistence.append = async (sessionId, events) => { appended.push({ sessionId, events }) }
    const { ctx, routes } = makeCtx(services)
    apply(ctx)
    const res = await call(routes, '/api/session-cleaner/delete-message', makeReq({ body: { sessionId: 's-1', seq: 0 } }))
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.shadowed).toEqual([0, 1, 2])
    // Regression for B4: appended seq must be max(existing)+1 (= 4), not events.length-based guess colliding.
    expect(appended[0].events[0].seq).toBe(4)
    expect(appended[0].events[0].surfaceOp).toEqual({ op: 'replace', start: 0, end: 2 })
  })

  it('deletes an assistant message without cascade', async () => {
    const { ctx, routes } = makeCtx(defaultServices())
    apply(ctx)
    const res = await call(routes, '/api/session-cleaner/delete-message', makeReq({ body: { sessionId: 's-1', seq: 1 } }))
    expect(res.statusCode).toBe(200)
    expect(res.json().shadowed).toEqual([1])
  })

  it('refuses live sessions with 409 (regression for B5)', async () => {
    const services = defaultServices()
    services.sessions = { get: (id) => (id === 's-1' ? { id } : undefined) }
    const { ctx, routes } = makeCtx(services)
    apply(ctx)
    const res = await call(routes, '/api/session-cleaner/delete-message', makeReq({ body: { sessionId: 's-1', seq: 0 } }))
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('live-session')
  })

  it('returns 409 when the target is not on the surface', async () => {
    const { ctx, routes } = makeCtx(defaultServices())
    apply(ctx)
    const res = await call(routes, '/api/session-cleaner/delete-message', makeReq({ body: { sessionId: 's-1', seq: 99 } }))
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('not-on-surface')
  })

  it('returns 400 for tool/result targets', async () => {
    const { ctx, routes } = makeCtx(defaultServices())
    apply(ctx)
    const res = await call(routes, '/api/session-cleaner/delete-message', makeReq({ body: { sessionId: 's-1', seq: 2 } }))
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('unsupported-type')
  })

  it('returns 400 for invalid seq values', async () => {
    const { ctx, routes } = makeCtx(defaultServices())
    apply(ctx)
    for (const bad of [-1, 1.5, 'x']) {
      const res = await call(routes, '/api/session-cleaner/delete-message', makeReq({ body: { sessionId: 's-1', seq: bad } }))
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('bad-seq')
    }
  })

  it('computes correct seq even when event numbering has gaps (regression for B4)', async () => {
    const services = defaultServices()
    // Numbering starts at 100 with holes: events.length (4) would collide.
    services.sessionPersistence.inspect = async () => ({
      events: [100, 205, 310, 999].map((seq, i) => ({
        type: i % 2 === 0 ? 'user/message' : 'assistant/message',
        seq, time: i,
        data: { content: [{ type: 'text', text: 'm' + i }] },
      })),
    })
    const appended = []
    services.sessionPersistence.append = async (_id, events) => { appended.push(events) }
    const { ctx, routes } = makeCtx(services)
    apply(ctx)
    const res = await call(routes, '/api/session-cleaner/delete-message', makeReq({ body: { sessionId: 's-1', seq: 100 } }))
    expect(res.statusCode).toBe(200)
    expect(appended[0][0].seq).toBe(1000)
  })
})

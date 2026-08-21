import { describe, expect, it } from 'vitest'
import { foldSurfaceNodes, indexEventsBySeq, messagePreview, sourceKindOf, sourcePluginOf } from '../lib/index.js'

/** Shorthand: an append event of the given type/seq. */
function ev(type, seq, data = {}, surfaceOp) {
  const event = { type, seq, time: seq * 1000, data }
  if (surfaceOp !== undefined) event.surfaceOp = surfaceOp
  return event
}

describe('foldSurfaceNodes', () => {
  it('returns append-only nodes in order', () => {
    const events = [
      ev('user/message', 0),
      ev('assistant/message', 1),
      ev('tool/result', 2),
    ]
    expect(foldSurfaceNodes(events)).toEqual([0, 1, 2])
  })

  it('ignores non-message event types', () => {
    const events = [
      ev('user/message', 0),
      ev('system/event', 1),
      ev('assistant/message', 2),
    ]
    expect(foldSurfaceNodes(events)).toEqual([0, 2])
  })

  it('collapses a replaced range into a single node at its position', () => {
    const events = [
      ev('user/message', 0),
      ev('assistant/message', 1),
      ev('tool/result', 2),
      // replace [0..1] with node 3
      ev('user/message', 3, {}, { op: 'replace', start: 0, end: 1 }),
    ]
    expect(foldSurfaceNodes(events)).toEqual([3, 2])
  })

  it('handles nested replaces (delete inside already-replaced range)', () => {
    const events = [
      ev('user/message', 0),
      ev('assistant/message', 1),
      ev('user/message', 2, {}, { op: 'replace', start: 0, end: 1 }),
      // delete the replacement itself
      ev('user/message', 3, {}, { op: 'replace', start: 2, end: 2 }),
    ]
    expect(foldSurfaceNodes(events)).toEqual([3])
  })

  it('falls back to appending when replace endpoints are missing', () => {
    const events = [
      ev('user/message', 0),
      // start=5 does not exist on the surface -> degrade to append
      ev('user/message', 1, {}, { op: 'replace', start: 5, end: 6 }),
    ]
    expect(foldSurfaceNodes(events)).toEqual([0, 1])
  })

  it('degrades to append when start > end (inverted range)', () => {
    const events = [
      ev('user/message', 0),
      ev('assistant/message', 1),
      ev('user/message', 2, {}, { op: 'replace', start: 1, end: 0 }),
    ]
    expect(foldSurfaceNodes(events)).toEqual([0, 1, 2])
  })

  it('skips events with an invalid (null) surfaceOp — the core validator rejects them, so they never occur in legal logs', () => {
    const events = [ev('user/message', 0, {}, null)]
    expect(foldSurfaceNodes(events)).toEqual([])
  })
})

describe('indexEventsBySeq', () => {
  it('maps every seq to its event with O(1) lookup', () => {
    const events = [ev('user/message', 0), ev('assistant/message', 7), ev('tool/result', 42)]
    const bySeq = indexEventsBySeq(events)
    expect(bySeq.get(0)).toBe(events[0])
    expect(bySeq.get(7)).toBe(events[1])
    expect(bySeq.get(42)).toBe(events[2])
    expect(bySeq.get(99)).toBeUndefined()
  })
})

describe('messagePreview', () => {
  it('joins text blocks from data.message.content', () => {
    const event = { data: { message: { content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] } } }
    expect(messagePreview(event)).toBe('hello world')
  })

  it('falls back to data.content when message is absent', () => {
    const event = { data: { content: [{ type: 'text', text: 'direct' }] } }
    expect(messagePreview(event)).toBe('direct')
  })

  it('skips non-text blocks and empty data', () => {
    expect(messagePreview({ data: { content: [{ type: 'image', url: 'x' }] } })).toBe('')
    expect(messagePreview({})).toBe('')
    expect(messagePreview({ data: undefined })).toBe('')
  })

  it('truncates long text to 120 chars plus ellipsis', () => {
    const long = 'a'.repeat(200)
    const preview = messagePreview({ data: { content: [{ type: 'text', text: long }] } })
    expect(preview.length).toBe(121)
    expect(preview.endsWith('…')).toBe(true)
    expect(preview.startsWith('a'.repeat(120))).toBe(true)
  })

  it('keeps text of exactly 120 chars untruncated', () => {
    const exact = 'b'.repeat(120)
    expect(messagePreview({ data: { content: [{ type: 'text', text: exact }] } })).toBe(exact)
  })
})

describe('sourceKindOf / sourcePluginOf', () => {
  it('reads from data.message.source first', () => {
    const event = { data: { message: { source: { kind: 'model', plugin: 'inner' } }, source: { kind: 'outer' } } }
    expect(sourceKindOf(event)).toBe('model')
    expect(sourcePluginOf(event)).toBe('inner')
  })

  it('falls back to data.source', () => {
    const event = { data: { source: { kind: 'plugin', plugin: 'dsh-session-cleaner' } } }
    expect(sourceKindOf(event)).toBe('plugin')
    expect(sourcePluginOf(event)).toBe('dsh-session-cleaner')
  })

  it('never returns undefined for missing/malformed sources', () => {
    expect(sourceKindOf({})).toBeNull()
    expect(sourcePluginOf({})).toBeNull()
    expect(sourceKindOf({ data: { source: 'not-an-object' } })).toBeNull()
    expect(sourcePluginOf({ data: { message: { source: 42 } } })).toBeNull()
    expect(sourceKindOf({ data: { source: { kind: 123 } } })).toBeNull()
  })
})

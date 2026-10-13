import { describe, it, expect } from 'vitest'
import { creatorKey, creatorState, prefsFromConfig, prefsToConfig, withCreatorState, type CreatorPrefs } from './creatorPrefs'

const empty: CreatorPrefs = { mediuxFollows: [], posterdbFollows: [], hidden: [] }

describe('creator prefs', () =>
{
  it('keys creators by site and ignores case', () =>
  {
    expect(creatorKey('mediux', ' Alice ')).toBe('mediux:alice')
    expect(creatorKey('posterdb', 'Alice')).not.toBe(creatorKey('mediux', 'Alice'))
  })

  it('keeps the same name on two sites independent', () =>
  {
    const p = withCreatorState(empty, 'mediux', 'Alice', 'followed')
    expect(creatorState(p, 'mediux', 'alice')).toBe('followed')
    expect(creatorState(p, 'posterdb', 'Alice')).toBe('none')
  })

  it('makes follow and hide mutually exclusive', () =>
  {
    const followed = withCreatorState(empty, 'posterdb', 'Bob', 'followed')
    const hidden = withCreatorState(followed, 'posterdb', 'bob', 'hidden')
    expect(creatorState(hidden, 'posterdb', 'Bob')).toBe('hidden')
    expect(hidden.posterdbFollows).toEqual([])
    const back = withCreatorState(hidden, 'posterdb', 'Bob', 'followed')
    expect(back.hidden).toEqual([])
    expect(back.posterdbFollows).toEqual(['Bob'])
  })

  it('clears a creator without touching anyone else', () =>
  {
    let p = withCreatorState(empty, 'mediux', 'Alice', 'followed')
    p = withCreatorState(p, 'mediux', 'Carol', 'hidden')
    p = withCreatorState(p, 'mediux', 'ALICE', 'none')
    expect(p.mediuxFollows).toEqual([])
    expect(p.hidden).toEqual([{ source: 'mediux', username: 'Carol' }])
  })

  it('does not duplicate a creator who is followed twice', () =>
  {
    const p = withCreatorState(withCreatorState(empty, 'mediux', 'Alice', 'followed'), 'mediux', 'alice', 'followed')
    expect(p.mediuxFollows).toEqual(['Alice'])
  })

  it('round-trips through config, keeping the existing MediUX key', () =>
  {
    const cfg = { mediuxSubscriptions: ['Alice'], hiddenCreators: [{ source: 'posterdb' as const, username: 'Dan' }] }
    const p = prefsFromConfig(cfg)
    expect(p.posterdbFollows).toEqual([])
    expect(prefsToConfig(p)).toEqual({ ...cfg, posterdbSubscriptions: [] })
  })
})

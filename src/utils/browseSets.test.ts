import { describe, it, expect } from 'vitest'
import type { PosterSetSummary, SetSource } from '../../electron/ipc/types'
import { browseOutcome } from '../../electron/services/browseSets'

function summary(id: string, source: SetSource): PosterSetSummary
{
  return { id, source, setName: `Set ${id}`, uploader: 'alice', posterCount: 1, backdropCount: 0, titleCardCount: 0, posters: [] }
}

const m = summary('1', 'mediux')
const p = summary('1', 'posterdb')

describe('browseOutcome', () =>
{
  it('lists MediUX before ThePosterDB when both answered', () =>
  {
    expect(browseOutcome({ hasTmdb: true, mediux: { sets: [m] }, posterdb: { sets: [p] } })).toEqual({ sets: [m, p] })
  })

  it('reports nothing found as an empty list, not an error', () =>
  {
    expect(browseOutcome({ hasTmdb: true, mediux: { sets: [] }, posterdb: { sets: [] } })).toEqual({ sets: [] })
  })

  it('notes a missing TMDB id beside ThePosterDB results', () =>
  {
    expect(browseOutcome({ hasTmdb: false, mediux: { sets: [] }, posterdb: { sets: [p] } })).toEqual({ sets: [p], tmdbMissing: true })
  })

  it('blocks the panel only when nothing was found without a TMDB id', () =>
  {
    expect(browseOutcome({ hasTmdb: false, mediux: { sets: [] }, posterdb: { sets: [] } })).toEqual({ sets: [], tmdbMissing: true, error: 'no_tmdb' })
  })

  it('keeps a site that failed as a note and never as no_tmdb', () =>
  {
    const out = browseOutcome({ hasTmdb: false, mediux: { sets: [] }, posterdb: { sets: [], error: 'offline' } })
    expect(out).toEqual({ sets: [], tmdbMissing: true, sourceErrors: { posterdb: 'offline' } })
    const both = browseOutcome({ hasTmdb: true, mediux: { sets: [], error: 'down' }, posterdb: { sets: [p] } })
    expect(both).toEqual({ sets: [p], sourceErrors: { mediux: 'down' } })
  })

  it('says nothing about TMDB when MediUX was not asked', () =>
  {
    expect(browseOutcome({ hasTmdb: false, posterdb: { sets: [p] } })).toEqual({ sets: [p] })
    expect(browseOutcome({ hasTmdb: false, posterdb: { sets: [] } })).toEqual({ sets: [] })
  })

  it('leaves ThePosterDB out when only MediUX was asked', () =>
  {
    expect(browseOutcome({ hasTmdb: false, mediux: { sets: [] } })).toEqual({ sets: [], tmdbMissing: true })
    expect(browseOutcome({ hasTmdb: true, mediux: { sets: [m] } })).toEqual({ sets: [m] })
  })
})

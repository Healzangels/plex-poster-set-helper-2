import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseCreatorInput, resetCreatorPrefsForTests, setCreatorState, snapshot, subscribe } from './creatorPrefs'

type ConfigApi = { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> }

function stubConfig(api: ConfigApi): void
{
  vi.stubGlobal('window', { api: { config: api } })
}

function emptyConfig()
{
  return { mediuxSubscriptions: [] as string[], posterdbSubscriptions: [] as string[], hiddenCreators: [] }
}

beforeEach(() => { resetCreatorPrefsForTests() })
afterEach(() =>
{
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('creator prefs store', () =>
{
  it('queues writes so a second change starts from the first one', async () =>
  {
    let release!: () => void
    const firstWrite = new Promise<void>(resolve => { release = resolve })
    const set = vi.fn().mockImplementationOnce(() => firstWrite).mockResolvedValue(undefined)
    const get = vi.fn(async () => emptyConfig())
    stubConfig({ get, set })

    const a = setCreatorState('mediux', 'Alice', 'followed')
    const b = setCreatorState('posterdb', 'Bob', 'hidden')
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(1))
    release()
    await Promise.all([a, b])

    expect(get).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledTimes(2)
    expect(set.mock.calls[1][0]).toEqual({
      mediuxSubscriptions: ['Alice'],
      posterdbSubscriptions: [],
      hiddenCreators: [{ source: 'posterdb', username: 'Bob' }],
    })
    expect(snapshot()).toEqual({ mediuxFollows: ['Alice'], posterdbFollows: [], hidden: [{ source: 'posterdb', username: 'Bob' }] })
  })

  it('shows a change at once and takes it back when the save fails', async () =>
  {
    stubConfig({
      get: vi.fn(async () => ({ ...emptyConfig(), mediuxSubscriptions: ['Carol'] })),
      set: vi.fn().mockRejectedValue(new Error('offline')),
    })
    const seen: string[][] = []
    subscribe(() => { seen.push([...snapshot().mediuxFollows]) })
    await vi.waitFor(() => expect(snapshot().mediuxFollows).toEqual(['Carol']))

    await expect(setCreatorState('mediux', 'Dan', 'followed')).rejects.toThrow('offline')

    expect(seen).toContainEqual(['Carol', 'Dan'])
    expect(snapshot().mediuxFollows).toEqual(['Carol'])
  })

  it('does not write when the creator is already in that state', async () =>
  {
    const set = vi.fn()
    stubConfig({ get: vi.fn(async () => ({ ...emptyConfig(), mediuxSubscriptions: ['Alice'] })), set })

    const prefs = await setCreatorState('mediux', 'alice', 'followed')

    expect(set).not.toHaveBeenCalled()
    expect(prefs.mediuxFollows).toEqual(['Alice'])
  })

  it('retries a failed load while a view is still listening', async () =>
  {
    vi.useFakeTimers()
    const get = vi.fn()
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValue({ ...emptyConfig(), hiddenCreators: [{ source: 'mediux', username: 'Eve' }] })
    stubConfig({ get, set: vi.fn() })

    const unsubscribe = subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(get).toHaveBeenCalledTimes(1)
    expect(snapshot().hidden).toEqual([])

    await vi.advanceTimersByTimeAsync(2_000)

    expect(get).toHaveBeenCalledTimes(2)
    expect(snapshot().hidden).toEqual([{ source: 'mediux', username: 'Eve' }])
    unsubscribe()
  })

  it('shares one read between views that mount together', async () =>
  {
    const get = vi.fn(async () => emptyConfig())
    stubConfig({ get, set: vi.fn() })

    subscribe(() => {})
    subscribe(() => {})
    await vi.waitFor(() => expect(get).toHaveBeenCalled())

    expect(get).toHaveBeenCalledTimes(1)
  })
})

describe('parseCreatorInput', () =>
{
  it('reads a bare username as a MediUX creator', () =>
  {
    expect(parseCreatorInput('  @Alice ')).toEqual({ source: 'mediux', name: 'Alice' })
  })

  it('reads a profile link from either site', () =>
  {
    expect(parseCreatorInput('https://mediux.pro/user/alice?tab=sets')).toEqual({ source: 'mediux', name: 'alice' })
    expect(parseCreatorInput('https://theposterdb.com/user/Bob%20Ross')).toEqual({ source: 'posterdb', name: 'Bob Ross' })
  })

  it('rejects links to anywhere else and empty input', () =>
  {
    expect(parseCreatorInput('https://example.com/user/alice')).toBeNull()
    expect(parseCreatorInput('alice/sets')).toBeNull()
    expect(parseCreatorInput('   ')).toBeNull()
  })
})

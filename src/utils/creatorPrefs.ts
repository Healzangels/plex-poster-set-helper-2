import { useCallback, useSyncExternalStore } from 'react'
import type { AppConfig, HiddenCreator } from '../../electron/ipc/types'
import type { SetSource } from './posterGroups'

/**
 * A creator is followed, hidden, or neither - never both. Following highlights
 * and promotes their sets; hiding tucks them away in the Library Browser.
 */
export type CreatorState = 'followed' | 'hidden' | 'none'

/** Every per-creator choice, as stored in config. */
export interface CreatorPrefs {
  /** Followed MediUX usernames, original casing, in the order followed. */
  mediuxFollows: string[]
  /** Followed ThePosterDB usernames. */
  posterdbFollows: string[]
  hidden: HiddenCreator[]
}

type PrefsConfig = Pick<AppConfig, 'mediuxSubscriptions' | 'posterdbSubscriptions' | 'hiddenCreators'>

/**
 * Identity of a creator across the app. Usernames are matched without regard
 * to case, and only within one site: MediUX "alice" and ThePosterDB "alice"
 * are separate people as far as follow/hide go.
 *
 * @param source - The creator's site.
 * @param username - Their username.
 * @returns The "source:username" key, lowercased.
 */
export function creatorKey(source: SetSource, username: string): string {
  return `${source}:${username.trim().toLowerCase()}`
}

/**
 * Reads creator prefs out of config.
 *
 * @param c - Config (or the relevant slice of it).
 * @returns The prefs, with missing lists treated as empty.
 */
export function prefsFromConfig(c: PrefsConfig): CreatorPrefs {
  return {
    mediuxFollows: c.mediuxSubscriptions ?? [],
    posterdbFollows: c.posterdbSubscriptions ?? [],
    hidden: c.hiddenCreators ?? [],
  }
}

/**
 * Writes creator prefs back to their config keys.
 *
 * @param p - The prefs.
 * @returns The config patch to save.
 */
export function prefsToConfig(p: CreatorPrefs): Required<PrefsConfig> {
  return { mediuxSubscriptions: p.mediuxFollows, posterdbSubscriptions: p.posterdbFollows, hiddenCreators: p.hidden }
}

function follows(p: CreatorPrefs, source: SetSource): string[] {
  return source === 'mediux' ? p.mediuxFollows : p.posterdbFollows
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Looks up a creator's state.
 *
 * @param p - The prefs.
 * @param source - The creator's site.
 * @param username - Their username.
 * @returns followed, hidden, or none.
 */
export function creatorState(p: CreatorPrefs, source: SetSource, username: string): CreatorState {
  if (follows(p, source).some(n => sameName(n, username))) return 'followed'
  if (p.hidden.some(h => h.source === source && sameName(h.username, username))) return 'hidden'
  return 'none'
}

/**
 * Sets a creator's state, keeping follow and hide mutually exclusive: hiding
 * a followed creator unfollows them and vice versa.
 *
 * @param p - Current prefs.
 * @param source - The creator's site.
 * @param username - Their username.
 * @param state - The state to move to.
 * @returns New prefs; the input is not modified.
 */
export function withCreatorState(p: CreatorPrefs, source: SetSource, username: string, state: CreatorState): CreatorPrefs {
  // Already there: keep the stored casing and the position in the list.
  if (creatorState(p, source, username) === state) return p
  const name = username.trim()
  const notThis = (n: string) => !sameName(n, name)
  let mediuxFollows = source === 'mediux' ? p.mediuxFollows.filter(notThis) : p.mediuxFollows
  let posterdbFollows = source === 'posterdb' ? p.posterdbFollows.filter(notThis) : p.posterdbFollows
  let hidden = p.hidden.filter(h => !(h.source === source && sameName(h.username, name)))

  if (state === 'followed') {
    if (source === 'mediux') mediuxFollows = [...mediuxFollows, name]
    else posterdbFollows = [...posterdbFollows, name]
  } else if (state === 'hidden') {
    hidden = [...hidden, { source, username: name }]
  }
  return { mediuxFollows, posterdbFollows, hidden }
}

/**
 * Reads a creator out of the follow box: a bare username (MediUX), or a
 * profile link on either site.
 *
 * @param input - What was typed or pasted.
 * @returns The creator and their site, or null when the input is neither a
 *   username nor a known profile link.
 */
export function parseCreatorInput(input: string): { source: SetSource; name: string } | null {
  const t = input.trim()
  const posterdb = t.match(/theposterdb\.com\/user\/([^/?#]+)/i)
  if (posterdb) return { source: 'posterdb', name: decodeURIComponent(posterdb[1]) }
  const mediux = t.match(/mediux\.pro\/user\/([^/?#]+)/i)
  if (mediux) return { source: 'mediux', name: decodeURIComponent(mediux[1]) }
  const name = t.replace(/^@/, '').trim()
  if (!name || /[/\s]/.test(name) || /^https?:/i.test(name)) return null
  return { source: 'mediux', name }
}

/*
 * One shared copy of the prefs, so a follow or hide made in the Library
 * Browser panel shows up immediately in the Creators tab (and vice versa)
 * without each view re-reading config.
 */
const EMPTY: CreatorPrefs = { mediuxFollows: [], posterdbFollows: [], hidden: [] }
const RETRY_BASE_MS = 2_000
const RETRY_MAX_MS = 30_000

let current: CreatorPrefs | null = null
let loading: Promise<CreatorPrefs> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryDelay = RETRY_BASE_MS
let writes: Promise<unknown> = Promise.resolve()
const listeners = new Set<() => void>()

function publish(p: CreatorPrefs): void {
  current = p
  for (const l of listeners) l()
}

function scheduleRetry(): void {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (listeners.size && !current) void load().catch(() => { /* load schedules the next retry */ })
  }, retryDelay)
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
}

function load(): Promise<CreatorPrefs> {
  loading ??= window.api.config.get()
    .then(c => {
      const p = prefsFromConfig(c)
      retryDelay = RETRY_BASE_MS
      publish(p)
      return p
    })
    .catch((err: unknown) => {
      // Mounted views would otherwise show nothing followed until a remount,
      // so keep trying while anyone is listening.
      if (listeners.size) scheduleRetry()
      throw err
    })
    .finally(() => { loading = null })
  return loading
}

/**
 * The store's current prefs: empty until config has been read.
 *
 * @returns The prefs snapshot.
 */
export function snapshot(): CreatorPrefs {
  return current ?? EMPTY
}

/**
 * Registers for changes and starts the first load.
 *
 * @param listener - Called after every change.
 * @returns Unsubscribes.
 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!current) void load().catch(() => { /* retried by load */ })
  return () => { listeners.delete(listener) }
}

/**
 * Changes a creator's state and saves it. Writes queue behind one another, so
 * each starts from the result of the previous one instead of a snapshot two
 * clicks old; the change shows at once and is taken back if the save fails.
 *
 * @param source - The creator's site.
 * @param username - Their username.
 * @param state - The state to move to.
 * @returns The saved prefs; rejects with the save error.
 */
export function setCreatorState(source: SetSource, username: string, state: CreatorState): Promise<CreatorPrefs> {
  const run = writes.then(async () => {
    const base = current ?? await load()
    const next = withCreatorState(base, source, username, state)
    if (next === base) return base
    publish(next)
    try {
      await window.api.config.set(prefsToConfig(next))
    } catch (err) {
      publish(base)
      throw err
    }
    return next
  })
  writes = run.catch(() => { /* reported to the caller */ })
  return run
}

/** Forgets everything loaded and queued, for tests. */
export function resetCreatorPrefsForTests(): void {
  current = null
  loading = null
  writes = Promise.resolve()
  retryDelay = RETRY_BASE_MS
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  listeners.clear()
}

/**
 * Live creator prefs for a component, kept in sync across every view.
 *
 * @returns The prefs (empty until loaded) plus lookups and a setter.
 */
export function useCreatorPrefs() {
  const prefs = useSyncExternalStore(subscribe, snapshot)
  const stateOf = useCallback((source: SetSource, username: string) => creatorState(prefs, source, username), [prefs])
  return { prefs, stateOf, setState: setCreatorState }
}

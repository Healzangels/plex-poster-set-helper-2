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

/*
 * One shared copy of the prefs, so a follow or hide made in the Library
 * Browser panel shows up immediately in the Creators tab (and vice versa)
 * without each view re-reading config.
 */
let current: CreatorPrefs | null = null
let loading: Promise<CreatorPrefs> | null = null
const listeners = new Set<(p: CreatorPrefs) => void>()

function publish(p: CreatorPrefs) {
  current = p
  for (const l of listeners) l(p)
}

function load(): Promise<CreatorPrefs> {
  loading ??= window.api.config.get().then(c => {
    const p = prefsFromConfig(c)
    publish(p)
    return p
  }).finally(() => { loading = null })
  return loading
}

/**
 * Changes a creator's state and saves it. Re-reads config first, so a follow
 * added elsewhere (e.g. the command palette) is not overwritten.
 *
 * @param source - The creator's site.
 * @param username - Their username.
 * @param state - The state to move to.
 * @returns The saved prefs.
 */
export async function setCreatorState(source: SetSource, username: string, state: CreatorState): Promise<CreatorPrefs> {
  const fresh = prefsFromConfig(await window.api.config.get())
  const next = withCreatorState(fresh, source, username, state)
  publish(next)
  await window.api.config.set(prefsToConfig(next))
  return next
}

const EMPTY: CreatorPrefs = { mediuxFollows: [], posterdbFollows: [], hidden: [] }

function subscribe(listener: () => void): () => void {
  const l = () => listener()
  listeners.add(l)
  if (!current) void load().catch(() => { /* config unavailable */ })
  return () => { listeners.delete(l) }
}

/**
 * Live creator prefs for a component, kept in sync across every view.
 *
 * @returns The prefs (empty until loaded) plus lookups and a setter.
 */
export function useCreatorPrefs() {
  const prefs = useSyncExternalStore(subscribe, () => current ?? EMPTY)
  const stateOf = useCallback((source: SetSource, username: string) => creatorState(prefs, source, username), [prefs])
  return { prefs, stateOf, setState: setCreatorState }
}

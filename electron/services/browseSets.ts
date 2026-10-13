import type { BrowseSetsRes, PosterSetSummary, SetSource } from '../ipc/types'

/** What one site answered for a title. */
export interface SourceResult {
  sets: PosterSetSummary[]
  /** The site could not be searched; `sets` is then empty. */
  error?: string
}

/**
 * Folds the per-site answers of a browse into one response. A site that was
 * not asked is left out entirely; one that failed contributes its reason and
 * no sets. "No TMDB id" blocks the panel only when both sites were asked and
 * neither found anything, so a ThePosterDB title match still shows.
 *
 * @param opts - Whether the title has a TMDB id, plus each site's answer when it was asked.
 * @returns The sets, MediUX first, with the error and notes the panel renders.
 */
export function browseOutcome(opts: {
  hasTmdb: boolean
  mediux?: SourceResult
  posterdb?: SourceResult
}): Pick<BrowseSetsRes, 'sets' | 'error' | 'tmdbMissing' | 'sourceErrors'>
{
  const sets = [...(opts.mediux?.sets ?? []), ...(opts.posterdb?.sets ?? [])]
  const out: Pick<BrowseSetsRes, 'sets' | 'error' | 'tmdbMissing' | 'sourceErrors'> = { sets }

  const sourceErrors: Partial<Record<SetSource, string>> = {}
  if (opts.mediux?.error) sourceErrors.mediux = opts.mediux.error
  if (opts.posterdb?.error) sourceErrors.posterdb = opts.posterdb.error
  if (Object.keys(sourceErrors).length) out.sourceErrors = sourceErrors

  if (opts.mediux && !opts.hasTmdb)
  {
    out.tmdbMissing = true
    if (opts.posterdb && !opts.posterdb.error && !sets.length) out.error = 'no_tmdb'
  }
  return out
}

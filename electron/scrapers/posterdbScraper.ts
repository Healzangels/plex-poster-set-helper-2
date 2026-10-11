import * as cheerio from 'cheerio'
import { BaseScraper, sleepConfig, mapPool } from './baseScraper'
import { Logger } from '../services/logger'
import type { PosterInfo, PosterSetSummary } from '../ipc/types'

const BASE = 'https://theposterdb.com'

/** What the library browser can look up on ThePosterDB. */
export type PosterdbMediaType = 'movie' | 'show' | 'collection'

/** Search section that lists a given media type. */
const SEARCH_SECTION: Record<PosterdbMediaType, string> = {
  movie: 'movies',
  show: 'shows',
  collection: 'collections',
}

/**
 * Media pages list 24 posters each, newest-first by downloads. We stop after
 * this many sets: the tail is long, and every multi-poster set past this point
 * costs another page fetch to expand.
 */
const MAX_BROWSE_SETS = 30
/** Hard bound on media pages walked while collecting those sets. */
const MAX_BROWSE_PAGES = 3
/** Parallel set-page fetches while expanding multi-poster sets. */
const SET_FETCH_CONCURRENCY = 6
/** How long a resolved title -> media-page id mapping stays good. */
const MEDIA_ID_TTL = 6 * 60 * 60 * 1000

/**
 * Classifies a ThePosterDB URL.
 *
 * @param url - URL to inspect.
 * @returns set, poster, user, or unknown.
 */
export function posterdbUrlType(url: string): 'set' | 'poster' | 'user' | 'unknown' {
  if (/theposterdb\.com\/set\/\d+/.test(url)) return 'set'
  if (/theposterdb\.com\/poster\/\d+/.test(url)) return 'poster'
  if (/theposterdb\.com\/user\//.test(url)) return 'user'
  return 'unknown'
}

/**
 * Returns the original-quality image endpoint (matches the Python scraper:
 * /api/assets/{id}).
 *
 * @param posterId - The poster's data-poster-id.
 * @returns The asset URL.
 */
function posterAssetUrl(posterId: string): string {
  return `${BASE}/api/assets/${posterId}`
}

interface RawCard {
  posterId: string
  thumbUrl: string
  title: string
  mediaType: string
  year?: number
  season?: number | 'Cover' | 'Backdrop'
  /** Set the poster belongs to, from the card's poster-count badge. */
  setId?: string
  /** How many posters that set holds, per the same badge. */
  setSize?: number
  uploader?: string
}

/**
 * Extracts the "(YYYY)" year from a poster title.
 *
 * @param text - Raw card title.
 * @returns The year, or undefined.
 */
function parseYear(text: string): number | undefined {
  const m = text.match(/\((\d{4})\)/)
  return m ? parseInt(m[1]) : undefined
}

/**
 * Derives the season for a TV show poster from the title suffix the way
 * ThePosterDB formats it: "Title (Year) - Season N", "- Specials" maps to 0,
 * otherwise it's the show cover poster. Movies/collections have no season.
 *
 * @param text - Raw card title.
 * @returns The season number, 0 for Specials, or 'Cover'.
 */
function parseShowSeason(text: string): number | 'Cover' | undefined {
  if (text.includes(' - ')) {
    const last = text.split(' - ').pop()!.trim()
    if (/specials/i.test(last)) return 0
    const m = last.match(/season\s+(\d+)/i)
    if (m) return parseInt(m[1])
  }
  return 'Cover'
}

/**
 * Parses poster cards from a ThePosterDB page. Each poster is a grid cell
 * containing a `div.overlay` that carries `data-poster-id`, a tooltip anchor
 * whose `title` is the media type (Movie / Show / Collection), and a
 * `p.text-break` title. The overlay is the most stable hook; the rest is read
 * from its grid cell.
 *
 * @param $ - Cheerio handle over the page HTML.
 * @returns One raw card per poster found.
 */
function parseCards($: cheerio.CheerioAPI): RawCard[] {
  const cards: RawCard[] = []

  $('div.overlay[data-poster-id]').each((_, el) => {
    const $overlay = $(el)
    const posterId = $overlay.attr('data-poster-id')
    if (!posterId) return

    let $cell = $overlay.closest('div[class*="col-"]')
    if (!$cell.length) $cell = $overlay.parent()

    // data-poster-type is the modern attribute; the tooltip anchor's title
    // covers older markup
    const mediaType = (
      $overlay.attr('data-poster-type') ||
      $cell.find('a.text-white[data-toggle="tooltip"]').attr('title') ||
      $overlay.find('a[data-toggle="tooltip"]').attr('title') ||
      'Movie'
    ).trim()

    const rawTitle = (
      $cell.find('p.text-break').first().text() ||
      $cell.find('p').first().text() ||
      $cell.find('img').first().attr('alt') ||
      ''
    ).trim()
    if (!rawTitle) return

    const title = rawTitle.split(' (')[0].trim()
    const year = parseYear(rawTitle)
    const season = /show/i.test(mediaType) ? parseShowSeason(rawTitle) : undefined

    // The <img> is a lazy placeholder (missing_poster.jpg); the real artwork is
    // only ever in the <picture>'s <source srcset>. Read that first and fall
    // back to the img attributes for any older markup that lacks a <picture>.
    const srcset =
      $cell.find('picture source[type="image/webp"]').first().attr('srcset') ||
      $cell.find('picture source').first().attr('srcset') ||
      ''
    const imgEl = $cell.find('img').first()
    const rawThumb =
      srcset.split(',')[0].trim().split(/\s+/)[0] ||
      imgEl.attr('data-src') || imgEl.attr('data-lazy-src') || imgEl.attr('src') || ''
    const thumbUrl =
      rawThumb.includes('missing_poster') ? ''
      : rawThumb.startsWith('http') ? rawThumb
      : rawThumb ? `${BASE}${rawThumb}` : ''

    const $setLink = $cell.find('a.set_poster_count[href*="/set/"], a[href*="/set/"]').first()
    const setId = $setLink.attr('href')?.match(/\/set\/(\d+)/)?.[1]
    const setSize = parseInt($setLink.text().trim(), 10)
    const uploader = $cell.find('p.uploaded-by a[href*="/user/"], a[href*="/user/"]').first().text().trim()

    cards.push({
      posterId, thumbUrl, title, mediaType, year, season,
      setId,
      setSize: Number.isFinite(setSize) && setSize > 0 ? setSize : undefined,
      uploader: uploader || undefined,
    })
  })

  return cards
}

/**
 * Converts parsed cards into PosterInfo entries.
 *
 * @param cards - Cards from parseCards().
 * @returns Posters with original-quality URLs and display thumbs.
 */
function cardsToPosters(cards: RawCard[]): PosterInfo[] {
  return cards.map(c => ({
    title: c.title,
    url: posterAssetUrl(c.posterId),
    thumbUrl: c.thumbUrl || posterAssetUrl(c.posterId),
    source: 'posterdb' as const,
    year: c.year,
    season: c.season,
    ...( /collection/i.test(c.mediaType) ? { isCollection: true } : {} ),
  }))
}

/**
 * Folds a title down to something two sites can agree on: case, accents,
 * punctuation and "the/a/an" all vary between Plex and ThePosterDB.
 *
 * @param s - Raw title.
 * @returns The comparable form.
 */
function normalizeTitle(s: string): string {
  return s
    .normalize('NFD').replace(/\p{M}/gu, '')   // strip accents: "Amélie" -> "amelie"
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    // Trim before dropping the article, or a title starting with punctuation
    // keeps a leading space and the article survives.
    .trim()
    .replace(/^(the|a|an) /, '')
}

/** One row of a ThePosterDB search result page. */
export interface SearchHit { mediaId: string; title: string; year?: number }

/**
 * Parses the search page's result rows.
 *
 * @param $ - Cheerio handle over the search HTML.
 * @returns Every "/posters/{id}" hit with its title and year.
 */
function parseSearchHits($: cheerio.CheerioAPI): SearchHit[] {
  const hits: SearchHit[] = []
  $('a[href*="/posters/"]').each((_, el) => {
    const $a = $(el)
    const mediaId = $a.attr('href')?.match(/\/posters\/(\d+)/)?.[1]
    if (!mediaId) return
    // Rows render as "<strong>Title</strong> (Year)"; the year is absent or
    // "N/A" for collections and for titles TPDb has no release date for.
    const title = ($a.find('strong').first().text() || $a.text()).trim()
    if (!title) return
    const year = parseYear($a.text())
    hits.push({ mediaId, title, year })
  })
  return hits
}

/**
 * Normalized titles a hit may carry and still be the thing we asked for. Plex
 * and ThePosterDB disagree on whether a collection's name ends in "Collection"
 * ("Harry Potter" vs "Harry Potter Collection"), so both spellings count.
 *
 * @param title - Plex title.
 * @param type - What kind of item is being browsed.
 * @returns Every acceptable normalized form.
 */
function titleAliases(title: string, type: PosterdbMediaType): string[] {
  const base = normalizeTitle(title)
  if (type !== 'collection') return [base]
  const bare = base.replace(/ collection$/, '')
  return [...new Set([base, bare, `${bare} collection`])]
}

/**
 * Picks the search hit that actually is the title we asked for. Year is the
 * tie-breaker, not a requirement: TPDb often carries no year at all, and a
 * remake with the same name is exactly what the year disambiguates.
 *
 * @param hits - Rows from parseSearchHits().
 * @param wants - Acceptable normalized titles, from titleAliases().
 * @param year - Plex release year, when known.
 * @returns The best hit, or null when nothing matches the title.
 */
function pickSearchHit(hits: SearchHit[], wants: string[], year?: number): SearchHit | null {
  const exact = hits.filter(h => wants.includes(normalizeTitle(h.title)))
  if (!exact.length) return null
  if (year == null) return exact[0]
  return exact.find(h => h.year === year)
    // Within a year either side - Plex and TPDb disagree on late-December and
    // festival-vs-wide release dates often enough to matter.
    ?? exact.find(h => h.year != null && Math.abs(h.year - year) <= 1)
    ?? exact.find(h => h.year == null)
    ?? exact[0]
}

/** A set discovered on a media page, before its full contents are known. */
interface SetStub {
  setId: string
  uploader: string
  /** Poster count from the card's badge - how many posters the set holds. */
  size: number
  /** The card as it appeared on the media page (this title's poster). */
  card: RawCard
}

/**
 * Groups a media page's cards into one stub per set, preserving page order
 * (ThePosterDB sorts media pages by downloads, so the best sets come first).
 *
 * @param cards - Cards parsed from a media page.
 * @returns One stub per distinct set, first card wins.
 */
function stubsFromCards(cards: RawCard[]): SetStub[] {
  const stubs = new Map<string, SetStub>()
  for (const c of cards) {
    if (!c.setId || stubs.has(c.setId)) continue
    stubs.set(c.setId, {
      setId: c.setId,
      uploader: c.uploader ?? 'Unknown',
      size: c.setSize ?? 1,
      card: c,
    })
  }
  return [...stubs.values()]
}

/**
 * Tags a set's posters relative to the title being browsed, mirroring how the
 * MediUX boxset browse classifies them: art for the collection object itself,
 * posters for *this* title, and posters for the other movies in the set.
 *
 * @param posters - Every poster on the set page.
 * @param title - Title being browsed.
 * @param year - Its release year, when known.
 * @param type - What kind of item is being browsed.
 * @returns The same posters with isCollection/isCollectionMember settled.
 */
function classifySetPosters(
  posters: PosterInfo[],
  title: string,
  year: number | undefined,
  type: PosterdbMediaType,
): PosterInfo[] {
  const want = normalizeTitle(title)
  return posters.map(p => {
    // cardsToPosters already flags collection art from the card's media type.
    if (p.isCollection) return p
    const sameTitle = normalizeTitle(p.title) === want
      && (p.year == null || year == null || Math.abs(p.year - year) <= 1)
    // Browsing a Plex Collection: every movie poster in the set is a member.
    // Browsing a title: anything that isn't this title belongs to a sibling.
    if (type === 'collection' || !sameTitle) return { ...p, isCollectionMember: true }
    return p
  })
}

/**
 * Builds the library-browser summary for one set.
 *
 * @param stub - The set as seen on the media page.
 * @param posters - Its classified posters.
 * @param setName - Display name for the set.
 * @param type - What kind of item is being browsed.
 * @returns The summary the panel renders.
 */
function stubToSummary(
  stub: SetStub,
  posters: PosterInfo[],
  setName: string,
  type: PosterdbMediaType,
): PosterSetSummary {
  let posterCount = 0, backdropCount = 0, titleCardCount = 0
  for (const p of posters) {
    if (p.season === 'Backdrop') backdropCount++
    else if (p.episode != null) titleCardCount++
    else posterCount++
  }
  return {
    id: stub.setId,
    source: 'posterdb',
    setName,
    uploader: stub.uploader,
    setUrl: `${BASE}/set/${stub.setId}`,
    posterCount,
    backdropCount,
    titleCardCount,
    previewUrl: stub.card.thumbUrl || posterAssetUrl(stub.card.posterId),
    posters,
    ...(type === 'collection' ? {} : { mediaType: type }),
  }
}

/** Resolved media-page ids, so reopening a title doesn't re-run the search. */
const mediaIdCache = new Map<string, { hit: SearchHit | null; at: number }>()

function mediaCacheKey(title: string, year: number | undefined, type: PosterdbMediaType): string {
  return `${type}|${normalizeTitle(title)}|${year ?? ''}`
}

/** Scrapes ThePosterDB set, single-poster, and user-upload pages via a headless browser. */
export class PosterdbScraper extends BaseScraper {
  /**
   * Routes a ThePosterDB URL to the matching scrape strategy.
   *
   * @param url - Set, poster, or user page URL.
   * @returns Posters found, empty for unrecognised URLs.
   */
  async scrape(url: string): Promise<PosterInfo[]> {
    const type = posterdbUrlType(url)
    Logger.scrape('PosterDB', `Scraping ${type}: ${url}`)

    switch (type) {
      case 'set':    return this.scrapeSet(url)
      case 'poster': return this.scrapeSinglePoster(url)
      case 'user':   return this.scrapeUserUploads(url)
      default:
        Logger.warn('PosterDB', `Unrecognised URL pattern: ${url}`)
        return []
    }
  }

  /**
   * Scrapes every poster on a set page.
   *
   * @param url - Set page URL.
   * @returns Posters found, empty on failure.
   */
  async scrapeSet(url: string): Promise<PosterInfo[]> {
    const { context, page } = await this.newContext()
    try {
      await this.navigate(page, url, 'div.overlay[data-poster-id]')
      const html = await page.content()
      const $ = cheerio.load(html)
      const cards = parseCards($)
      const posters = cardsToPosters(cards)
      Logger.scrape('PosterDB', `Set ${url} - ${posters.length} posters found`)
      return posters
    } catch (err) {
      Logger.error('PosterDB', `scrapeSet failed: ${err instanceof Error ? err.message : err}`)
      return []
    } finally {
      await context.close()
    }
  }

  /**
   * Scrapes a single-poster page by locating its parent set, falling back to
   * the poster itself.
   *
   * @param url - Poster page URL.
   * @returns The parent set's posters, or just this poster.
   */
  async scrapeSinglePoster(url: string): Promise<PosterInfo[]> {
    const { context, page } = await this.newContext()
    try {
      await this.navigate(page, url, 'div.overlay[data-poster-id], a[title="View Set Page"]')
      const html = await page.content()
      const $ = cheerio.load(html)

      // "View Set Page" link (new layout), then older fallbacks
      const setHref =
        $('a[data-toggle="tooltip"][title="View Set Page"]').first().attr('href') ||
        $('a.rounded.view_all').first().attr('href') ||
        $('a[href*="/set/"]').first().attr('href')
      if (!setHref) {
        const cards = parseCards($)
        return cardsToPosters(cards)
      }

      const setUrl = setHref.startsWith('http') ? setHref : `${BASE}${setHref}`
      await context.close()
      await sleepConfig('min')
      return this.scrapeSet(setUrl)
    } catch (err) {
      Logger.error('PosterDB', `scrapeSinglePoster failed: ${err instanceof Error ? err.message : err}`)
      return []
    } finally {
      await context.close().catch(() => {})
    }
  }

  /**
   * Scrapes a user's uploads, paginating until a short page or abort.
   *
   * @param url - User profile URL.
   * @returns All posters across the paginated upload pages.
   */
  async scrapeUserUploads(url: string): Promise<PosterInfo[]> {
    const allPosters: PosterInfo[] = []
    let page = 1
    let hasMore = true

    const baseUrl = url.split('?')[0]
    while (hasMore && !this._aborted) {
      const pageUrl = `${baseUrl}?section=uploads&page=${page}`
      const { context, ctx: pageCtx } = await this._newUserPage()

      try {
        await this.navigate(pageCtx, pageUrl, 'div.overlay[data-poster-id]')
        const html = await pageCtx.content()
        const $ = cheerio.load(html)
        const cards = parseCards($)

        if (!cards.length) {
          hasMore = false
        } else {
          allPosters.push(...cardsToPosters(cards))
          // A full page (24 per page) means more may follow; a short page is the last
          hasMore = cards.length >= 24
          page++
          await sleepConfig('batch')
        }
      } catch (err) {
        Logger.error('PosterDB', `scrapeUserUploads page ${page} failed: ${err instanceof Error ? err.message : err}`)
        hasMore = false
      } finally {
        await context.close()
      }
    }

    Logger.scrape('PosterDB', `User uploads ${url} - ${allPosters.length} total posters`)
    return allPosters
  }

  /** Opens a fresh context/page pair with the page aliased to avoid clashing with the loop counter. */
  private async _newUserPage() {
    const { context, page } = await this.newContext()
    return { context, ctx: page }
  }

  /**
   * Fetches one page and hands its HTML to a parser.
   *
   * @param url - Page to load.
   * @param waitFor - Selector that signals the content rendered.
   * @param parse - Receives the loaded HTML.
   * @returns The parser's result, or null when the page failed to load.
   */
  private async _withPage<T>(
    url: string,
    waitFor: string,
    parse: ($: cheerio.CheerioAPI) => T,
  ): Promise<T | null> {
    const { context, page } = await this.newContext()
    try {
      await this.navigate(page, url, waitFor)
      return parse(cheerio.load(await page.content()))
    } catch (err) {
      Logger.warn('PosterDB', `Page load failed [${url}]: ${err instanceof Error ? err.message : err}`)
      return null
    } finally {
      await context.close().catch(() => {})
    }
  }

  /**
   * Resolves a Plex title to its ThePosterDB media page. ThePosterDB gates
   * external-id search behind TPDb Pro, so this matches on title and year -
   * hence the deliberately strict pickSearchHit().
   *
   * @param title - Plex title.
   * @param year - Release year, when known.
   * @param type - Movie, show, or collection.
   * @returns The matching media page, or null when the title isn't on the site.
   */
  async findMedia(title: string, year: number | undefined, type: PosterdbMediaType): Promise<SearchHit | null> {
    const cacheKey = mediaCacheKey(title, year, type)
    const cached = mediaIdCache.get(cacheKey)
    if (cached && Date.now() - cached.at < MEDIA_ID_TTL) return cached.hit

    const url = `${BASE}/search?term=${encodeURIComponent(title)}&section=${SEARCH_SECTION[type]}`
    const hits = await this._withPage(url, 'a[href*="/posters/"]', parseSearchHits)
    // A failed load is not a "no such title" - leave it uncached so the next
    // open retries instead of showing an empty panel for the next six hours.
    if (hits === null) return null

    const hit = pickSearchHit(hits, titleAliases(title, type), year)
    mediaIdCache.set(cacheKey, { hit, at: Date.now() })
    if (!hit) Logger.scrape('PosterDB', `No ${type} match for "${title}"${year ? ` (${year})` : ''} among ${hits.length} result(s)`)
    return hit
  }

  /**
   * Lists ThePosterDB sets for a title (library browser). Walks the title's
   * media page for the sets it appears in, then expands each multi-poster set
   * from its own page so seasons, backdrops and collection siblings come
   * through - a media page only ever shows one poster per set.
   *
   * @param title - Plex title.
   * @param year - Release year, when known.
   * @param type - Movie, show, or collection.
   * @returns Set summaries, most-downloaded first, capped at MAX_BROWSE_SETS.
   */
  async browseSets(title: string, year: number | undefined, type: PosterdbMediaType): Promise<PosterSetSummary[]> {
    const media = await this.findMedia(title, year, type)
    if (!media || this._aborted) return []

    const stubs: SetStub[] = []
    const seen = new Set<string>()
    for (let page = 1; page <= MAX_BROWSE_PAGES && stubs.length < MAX_BROWSE_SETS && !this._aborted; page++) {
      const url = `${BASE}/posters/${media.mediaId}${page > 1 ? `?page=${page}` : ''}`
      const cards = await this._withPage(url, 'div.overlay[data-poster-id]', parseCards)
      if (!cards?.length) break
      for (const stub of stubsFromCards(cards)) {
        if (seen.has(stub.setId)) continue
        seen.add(stub.setId)
        stubs.push(stub)
      }
      if (cards.length < 24) break     // short page - end of the catalog
      await sleepConfig('min')
    }
    if (this._aborted) return []

    const capped = stubs.length > MAX_BROWSE_SETS
    const wanted = stubs.slice(0, MAX_BROWSE_SETS)

    const summaries = await mapPool(wanted, SET_FETCH_CONCURRENCY, async stub => {
      // A one-poster set is fully described by the card we already have, so the
      // common movie case costs no extra page loads at all.
      if (stub.size <= 1) {
        const posters = classifySetPosters(cardsToPosters([stub.card]), title, year, type)
        return stubToSummary(stub, posters, stub.card.title, type)
      }
      if (this._aborted) return null
      const setUrl = `${BASE}/set/${stub.setId}`
      const parsed = await this._withPage(setUrl, 'div.overlay[data-poster-id]', $ => ({
        cards: parseCards($),
        // "<Set name> Set By <uploader> | The Poster Database (TPDb)"
        name: $('title').first().text().split(/\s+Set By\s+/i)[0].trim(),
      }))
      if (!parsed?.cards.length) return null
      const posters = classifySetPosters(cardsToPosters(parsed.cards), title, year, type)
      return stubToSummary(stub, posters, parsed.name || stub.card.title, type)
    })

    const sets = summaries.filter((s): s is PosterSetSummary => s !== null && s.posters.length > 0)
    Logger.scrape(
      'PosterDB',
      `Browse ${type} "${title}"${year ? ` (${year})` : ''} - ${sets.length} set(s) from /posters/${media.mediaId}${capped ? ` (capped at ${MAX_BROWSE_SETS})` : ''}`,
    )
    return sets
  }
}

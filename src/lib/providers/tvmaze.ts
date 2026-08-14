import { cacheGet, cacheGetStale, cacheSet } from '../db';
import { normalizePlatform, tidyPlatforms } from '../platforms';
import type {
  AiringEntry,
  MediaKind,
  MediaSubtype,
  PlatformId,
  SearchResult,
  TrackedItem,
} from '../types';

/**
 * TVmaze — series et animation, sans aucune cle ni inscription.
 *
 * C'est l'alternative a TMDB. Mesures sur un export Netflix francais reel de
 * 48 titres :
 *
 *   AniList seul ............... 5 rapprochements
 *   TVmaze seul ................ 24 sur 30 testes
 *
 * TVmaze s'en sort aussi bien sur des titres francais parce qu'il indexe les
 * titres alternatifs par pays (`/shows/:id/akas`) : chercher
 * "La Chronique des Bridgerton" renvoie directement "Bridgerton".
 *
 * Deux avantages sur TMDB :
 *   - `airstamp` donne un horaire precis (verifie : 42 episodes sur 42 pour
 *     Stranger Things), la ou TMDB ne fournit qu'une date sans heure ;
 *   - aucune cle, donc aucune donnee personnelle a fournir.
 *
 * Un inconvenient assume : `webChannel`/`network` designent la chaine
 * d'ORIGINE, pas la disponibilite en France. "The Handmaid's Tale" y est
 * rattache a Hulu alors qu'en France il est ailleurs. Pour les productions
 * Netflix — l'essentiel d'un historique Netflix — l'information est juste. Les
 * ecarts se corrigent a la main dans Ma liste, et l'override local est
 * prioritaire.
 */

const BASE = 'https://api.tvmaze.com';
const TTL = 12 * 60 * 60 * 1000;
/** TVmaze tolere ~20 appels par 10 s : 550 ms entre deux requetes suffit. */
export const REQUEST_SPACING_MS = 550;

interface TvmazeShow {
  id: number;
  name: string;
  type: string | null;
  language: string | null;
  status: string | null;
  premiered: string | null;
  /** TVmaze n'expose que ces deux tailles : pas de `large`, contrairement a ce
   *  que ce type declarait — le repli retombait donc toujours sur `medium`. */
  image: { medium: string | null; original: string | null } | null;
  summary: string | null;
  network: { name: string; country?: { code?: string } | null } | null;
  webChannel: { name: string } | null;
}

interface TvmazeEpisode {
  id: number;
  season: number;
  number: number | null;
  name: string | null;
  airdate: string | null;
  airstamp: string | null;
}

async function api<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json' } });
  if (r.status === 429) throw new Error('TVmaze : trop de requêtes, réessaie dans 10 s');
  if (!r.ok) throw new Error(`TVmaze ${r.status} sur ${path}`);
  return (await r.json()) as T;
}

/** Nettoie le HTML des resumes TVmaze. */
function plain(html: string | null): string | null {
  if (!html) return null;
  return html.replace(/<[^>]+>/g, '').trim() || null;
}

/**
 * Anime ou serie ? TVmaze ne le dit pas directement, on le deduit du couple
 * type/langue. Approximatif mais suffisant : le champ ne sert qu'a l'affichage
 * et au classement des homonymes.
 */
function kindOf(show: TvmazeShow): MediaKind {
  const japanese = (show.language ?? '').toLowerCase() === 'japanese';
  return subtypeOf(show) === 'animation' && japanese ? 'anime' : 'series';
}

/**
 * Live action ou animation, d'apres le champ `type` de TVmaze.
 * Verifie : One Piece live = `Scripted`, Arcane et Castlevania = `Animation`.
 */
function subtypeOf(show: TvmazeShow): MediaSubtype {
  return (show.type ?? '').toLowerCase() === 'animation' ? 'animation' : 'live';
}

function platformsOf(show: TvmazeShow): PlatformId[] {
  const names = [show.webChannel?.name, show.network?.name].filter(
    (n): n is string => typeof n === 'string' && n.length > 0
  );
  return tidyPlatforms(names.map(normalizePlatform));
}

function toSearchResult(show: TvmazeShow): SearchResult {
  return {
    provider: 'tvmaze',
    externalId: String(show.id),
    kind: kindOf(show),
    subtype: subtypeOf(show),
    title: show.name,
    originalTitle: null,
    altTitles: [show.name],
    coverUrl: show.image?.medium ?? show.image?.original ?? null,
    platforms: platformsOf(show),
    totalEpisodes: null,
    year: show.premiered ? Number(show.premiered.slice(0, 4)) : null,
    description: plain(show.summary),
  };
}

// --------------------------------------------------------------------------

export async function searchSeries(query: string): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  const cacheKey = `tvmaze:search:${query.toLowerCase()}`;
  const cached = await cacheGet<SearchResult[]>(cacheKey);
  if (cached) return cached;

  const rows = await api<{ score: number; show: TvmazeShow }[]>(
    `/search/shows?q=${encodeURIComponent(query)}`
  );
  const results = rows.map((r) => toSearchResult(r.show));
  await cacheSet(cacheKey, results, TTL);
  return results;
}

/** Titres alternatifs par pays — c'est ce qui permet le rapprochement FR. */
export async function fetchAkas(showId: number): Promise<string[]> {
  const cacheKey = `tvmaze:akas:${showId}`;
  const cached = await cacheGet<string[]>(cacheKey);
  if (cached) return cached;
  try {
    const rows = await api<{ name: string; country: { code: string } | null }[]>(
      `/shows/${showId}/akas`
    );
    const names = rows.map((r) => r.name);
    await cacheSet(cacheKey, names, TTL);
    return names;
  } catch {
    return [];
  }
}

export async function fetchShow(showId: number): Promise<TvmazeShow | null> {
  const cacheKey = `tvmaze:show:${showId}`;
  const cached = await cacheGet<TvmazeShow>(cacheKey);
  if (cached) return cached;
  try {
    const show = await api<TvmazeShow>(`/shows/${showId}`);
    await cacheSet(cacheKey, show, TTL);
    return show;
  } catch {
    return await cacheGetStale<TvmazeShow>(cacheKey);
  }
}

async function fetchEpisodes(showId: number): Promise<TvmazeEpisode[]> {
  const cacheKey = `tvmaze:episodes:${showId}`;
  const cached = await cacheGet<TvmazeEpisode[]>(cacheKey);
  if (cached) return cached;
  try {
    const eps = await api<TvmazeEpisode[]>(`/shows/${showId}/episodes`);
    await cacheSet(cacheKey, eps, TTL);
    return eps;
  } catch (err) {
    const stale = await cacheGetStale<TvmazeEpisode[]>(cacheKey);
    if (stale) return stale;
    throw err;
  }
}

export interface TvmazeEnrichment {
  platforms: PlatformId[];
  totalEpisodes: number | null;
  coverUrl: string | null;
  /** Permet de completer les fiches ajoutees avant l'existence du champ. */
  subtype: MediaSubtype;
}

/** Complete une fiche apres ajout (plateforme d'origine, nombre d'episodes). */
export async function enrich(showId: number): Promise<TvmazeEnrichment | null> {
  const show = await fetchShow(showId);
  if (!show) return null;
  let totalEpisodes: number | null = null;
  try {
    totalEpisodes = (await fetchEpisodes(showId)).length || null;
  } catch {
    // Le nombre d'episodes est un bonus, pas un bloquant.
  }
  return {
    platforms: platformsOf(show),
    totalEpisodes,
    coverUrl: show.image?.medium ?? show.image?.original ?? null,
    subtype: subtypeOf(show),
  };
}

/** Entrees d'agenda pour les series TVmaze suivies sur l'intervalle donne. */
export async function fetchEntries(
  items: TrackedItem[],
  range: { from: number; to: number }
): Promise<AiringEntry[]> {
  const targets = items.filter(
    (i) => (i.provider === 'tvmaze' || i.links?.tvmazeId) && !i.overrides?.hidden
  );
  if (!targets.length) return [];

  const out: AiringEntry[] = [];

  for (const item of targets) {
    const showId = item.links?.tvmazeId ?? Number(item.externalId);
    if (!Number.isFinite(showId)) continue;

    try {
      const [episodes, show] = await Promise.all([fetchEpisodes(showId), fetchShow(showId)]);
      const platforms =
        item.overrides?.platforms ?? (show ? platformsOf(show) : item.platforms ?? []);
      const cover =
        item.overrides?.coverUrl ?? item.coverUrl ?? show?.image?.medium ?? null;

      for (const ep of episodes) {
        // airstamp porte l'horaire precis ; airdate ne donne que le jour.
        const ts = ep.airstamp
          ? new Date(ep.airstamp).getTime()
          : ep.airdate
            ? new Date(`${ep.airdate}T09:00:00`).getTime()
            : NaN;
        if (!Number.isFinite(ts) || ts < range.from || ts > range.to) continue;

        out.push({
          key: `${item.id}:${ep.season}x${ep.number ?? ep.id}`,
          itemId: item.id,
          kind: item.kind,
          subtype: item.subtype ?? null,
          title: item.overrides?.title ?? item.title,
          coverUrl: cover,
          episode: ep.number,
          episodeTitle: ep.name,
          airsAt: ts,
          platforms,
          source: 'tvmaze',
          url: null,
          watched: ep.number !== null && (item.watchedEpisodes ?? []).includes(ep.number),
        });
      }
    } catch {
      // Une serie en echec ne doit pas vider tout l'agenda.
    }
  }

  return out;
}

export type { TvmazeShow, TvmazeEpisode };

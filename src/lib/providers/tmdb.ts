import { cacheGet, cacheGetStale, cacheSet } from '../db';
import { normalizePlatform, tidyPlatforms } from '../platforms';
import type { AiringEntry, PlatformId, SearchResult, TrackedItem } from '../types';

/**
 * TMDB — series live-action, et disponibilite par plateforme en France.
 *
 * C'est ce provider qui permet de sortir du seul perimetre anime : AniList ne
 * connait que l'animation. TMDB apporte deux choses qu'aucune autre source
 * gratuite ne donne ensemble : les dates de diffusion episode par episode, et
 * `watch/providers` filtre sur la region FR (donc Netflix FR, pas Netflix US).
 *
 * Necessite une cle v3 gratuite (themoviedb.org/settings/api). Sans cle, le
 * provider se desactive proprement et l'app reste fonctionnelle en anime seul.
 *
 * Limite connue : TMDB ne donne qu'une DATE de diffusion, sans heure. On place
 * donc les episodes a DEFAULT_DROP_HOUR, ajustable par serie via les overrides.
 */

const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w500';
const TTL = 12 * 60 * 60 * 1000; // 12 h : les dates de diffusion bougent peu.

/** Heure locale par defaut faute d'horaire cote TMDB (Netflix/Disney+ ~9 h). */
const DEFAULT_DROP_HOUR = 9;

interface TmdbSearchItem {
  id: number;
  name: string;
  original_name: string | null;
  poster_path: string | null;
  first_air_date: string | null;
  overview: string | null;
  genre_ids?: number[];
}

/** Identifiant du genre « Animation » chez TMDB, stable et documente. */
const TMDB_ANIMATION_GENRE = 16;

interface TmdbEpisode {
  episode_number: number;
  season_number: number;
  name: string | null;
  air_date: string | null;
}

interface TmdbProviderEntry {
  provider_name: string;
}

interface TmdbTvDetails {
  id: number;
  name: string;
  original_name: string | null;
  poster_path: string | null;
  number_of_episodes: number | null;
  in_production: boolean;
  status: string;
  last_episode_to_air: TmdbEpisode | null;
  next_episode_to_air: TmdbEpisode | null;
  seasons: { season_number: number; episode_count: number }[] | null;
  'watch/providers'?: {
    results?: Record<
      string,
      {
        flatrate?: TmdbProviderEntry[];
        free?: TmdbProviderEntry[];
        ads?: TmdbProviderEntry[];
      }
    >;
  };
}

export function hasTmdbKey(key: string | null | undefined): key is string {
  return typeof key === 'string' && key.trim().length > 0;
}

async function tmdbFetch<T>(path: string, key: string): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}${path}${sep}api_key=${encodeURIComponent(key)}`, {
    headers: { Accept: 'application/json' },
  });
  if (res.status === 401) throw new Error('Cle TMDB invalide');
  if (!res.ok) throw new Error(`TMDB ${res.status} sur ${path}`);
  return (await res.json()) as T;
}

/** Plateformes FR d'une serie, tous modes d'acces confondus. */
function frPlatforms(details: TmdbTvDetails): PlatformId[] {
  const fr = details['watch/providers']?.results?.FR;
  if (!fr) return [];
  const names = [...(fr.flatrate ?? []), ...(fr.free ?? []), ...(fr.ads ?? [])];
  return tidyPlatforms(names.map((p) => normalizePlatform(p.provider_name)));
}

// --------------------------------------------------------------------------

export async function searchSeries(query: string, key: string): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  const data = await tmdbFetch<{ results: TmdbSearchItem[] }>(
    `/search/tv?query=${encodeURIComponent(query)}&language=fr-FR&include_adult=false`,
    key
  );
  return (data.results ?? []).slice(0, 20).map((r) => ({
    provider: 'tmdb' as const,
    externalId: String(r.id),
    kind: 'series' as const,
    subtype: (r.genre_ids ?? []).includes(TMDB_ANIMATION_GENRE)
      ? ('animation' as const)
      : ('live' as const),
    title: r.name,
    originalTitle: r.original_name,
    altTitles: [r.name, r.original_name].filter(
      (t): t is string => typeof t === 'string' && t.length > 0
    ),
    coverUrl: r.poster_path ? `${IMG}${r.poster_path}` : null,
    // Les plateformes demandent un appel /tv/{id} : on enrichit apres l'ajout.
    platforms: [],
    totalEpisodes: null,
    year: r.first_air_date ? Number(r.first_air_date.slice(0, 4)) : null,
    description: r.overview,
  }));
}

export async function fetchDetails(tmdbId: number, key: string): Promise<TmdbTvDetails> {
  const cacheKey = `tmdb:tv:${tmdbId}`;
  const cached = await cacheGet<TmdbTvDetails>(cacheKey);
  if (cached) return cached;
  try {
    const data = await tmdbFetch<TmdbTvDetails>(
      `/tv/${tmdbId}?language=fr-FR&append_to_response=watch/providers`,
      key
    );
    await cacheSet(cacheKey, data, TTL);
    return data;
  } catch (err) {
    const stale = await cacheGetStale<TmdbTvDetails>(cacheKey);
    if (stale) return stale;
    throw err;
  }
}

async function fetchSeasonEpisodes(
  tmdbId: number,
  season: number,
  key: string
): Promise<TmdbEpisode[]> {
  const cacheKey = `tmdb:season:${tmdbId}:${season}`;
  const cached = await cacheGet<TmdbEpisode[]>(cacheKey);
  if (cached) return cached;
  try {
    const data = await tmdbFetch<{ episodes: TmdbEpisode[] }>(
      `/tv/${tmdbId}/season/${season}?language=fr-FR`,
      key
    );
    const episodes = data.episodes ?? [];
    await cacheSet(cacheKey, episodes, TTL);
    return episodes;
  } catch (err) {
    const stale = await cacheGetStale<TmdbEpisode[]>(cacheKey);
    if (stale) return stale;
    return [];
  }
}

/** `YYYY-MM-DD` -> epoch ms a DEFAULT_DROP_HOUR en heure locale. */
function airDateToTimestamp(airDate: string, hour = DEFAULT_DROP_HOUR): number | null {
  const m = airDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, 0, 0, 0);
  const ts = d.getTime();
  return Number.isFinite(ts) ? ts : null;
}

export interface TmdbEnrichment {
  platforms: PlatformId[];
  totalEpisodes: number | null;
  title: string;
  coverUrl: string | null;
}

/** Complete une fiche apres ajout (plateformes FR, nombre d'episodes). */
export async function enrich(tmdbId: number, key: string): Promise<TmdbEnrichment | null> {
  try {
    const d = await fetchDetails(tmdbId, key);
    return {
      platforms: frPlatforms(d),
      totalEpisodes: d.number_of_episodes ?? null,
      title: d.name,
      coverUrl: d.poster_path ? `${IMG}${d.poster_path}` : null,
    };
  } catch {
    return null;
  }
}

/**
 * Entrees d'agenda pour les series TMDB suivies sur l'intervalle donne.
 *
 * On regarde les saisons plausibles plutot que seulement `next_episode_to_air`,
 * pour couvrir les sorties en bloc (une saison Netflix entiere le meme jour).
 */
export async function fetchEntries(
  items: TrackedItem[],
  range: { from: number; to: number },
  key: string
): Promise<AiringEntry[]> {
  const targets = items.filter(
    (i) => (i.provider === 'tmdb' || i.links?.tmdbId) && !i.overrides?.hidden
  );
  if (!targets.length) return [];

  const out: AiringEntry[] = [];

  await Promise.all(
    targets.map(async (item) => {
      const tmdbId = item.links?.tmdbId ?? Number(item.externalId);
      if (!Number.isFinite(tmdbId)) return;

      try {
        const details = await fetchDetails(tmdbId, key);
        const platforms = item.overrides?.platforms ?? frPlatforms(details);
        const cover =
          item.overrides?.coverUrl ??
          item.coverUrl ??
          (details.poster_path ? `${IMG}${details.poster_path}` : null);

        // Saisons a inspecter : celles des episodes recents/a venir, sinon la derniere.
        const seasonNumbers = new Set<number>();
        if (details.last_episode_to_air) seasonNumbers.add(details.last_episode_to_air.season_number);
        if (details.next_episode_to_air) seasonNumbers.add(details.next_episode_to_air.season_number);
        if (!seasonNumbers.size && details.seasons?.length) {
          const real = details.seasons.filter((s) => s.season_number > 0);
          const last = real[real.length - 1] ?? details.seasons[details.seasons.length - 1];
          if (last) seasonNumbers.add(last.season_number);
        }

        const episodes = (
          await Promise.all(
            [...seasonNumbers].map((s) => fetchSeasonEpisodes(tmdbId, s, key))
          )
        ).flat();

        for (const ep of episodes) {
          if (!ep.air_date) continue;
          const ts = airDateToTimestamp(ep.air_date);
          if (ts === null || ts < range.from || ts > range.to) continue;

          out.push({
            key: `${item.id}:${ep.season_number}x${ep.episode_number}`,
            itemId: item.id,
            kind: item.kind,
            subtype: item.subtype ?? null,
            title: item.overrides?.title ?? item.title,
            coverUrl: cover,
            episode: ep.episode_number,
            episodeTitle: ep.name?.trim() || null,
            airsAt: ts,
            platforms,
            source: 'tmdb',
            url: null,
            watched: (item.watchedEpisodes ?? []).includes(ep.episode_number),
          });
        }
      } catch {
        // Une serie qui echoue ne doit pas vider tout l'agenda.
      }
    })
  );

  return out;
}

export type { TmdbTvDetails };

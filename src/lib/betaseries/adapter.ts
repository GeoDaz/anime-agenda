import { normalizePlatform, tidyPlatforms } from '../platforms';
import type { AiringEntry, PlatformId, SearchResult } from '../types';
import type { BsEpisode, BsShow } from './types';

/**
 * Traduction BetaSeries -> contrats internes de l'application.
 *
 * On conserve `SearchResult` et `AiringEntry` : seule la SOURCE change, pas les
 * composants. C'est ce qui permet de remplacer quatre providers sans reecrire
 * l'interface.
 */

/** Film BetaSeries. Champs observes lors du sondage ; volontairement etroit. */
export interface BsMovie {
  id: number;
  title: string;
  original_title?: string | null;
  production_year?: number | null;
  release_date?: string | null;
  poster?: string | null;
  in_account?: boolean;
  user?: { status?: number; in_account?: boolean } | null;
}

/** Plateformes d'une serie, avec repli sur la chaine de diffusion. */
export function platformsOfShow(show: Pick<BsShow, 'platforms' | 'network'>): PlatformId[] {
  const names: string[] = [];
  for (const p of show.platforms?.svods ?? []) if (p?.name) names.push(p.name);
  if (show.platforms?.svod?.name) names.push(show.platforms.svod.name);
  // `network` est la chaine d'origine : utile quand aucune SVOD n'est listee.
  if (!names.length && show.network) names.push(show.network);
  return tidyPlatforms(names.map(normalizePlatform));
}

/**
 * Meilleure image disponible pour une serie.
 * `poster` est le format portrait attendu par les listes ; `box` sert de repli.
 */
export function coverOfShow(show: BsShow): string | null {
  return show.images?.poster ?? show.images?.box ?? show.images?.show ?? null;
}

export function showToSearchResult(show: BsShow): SearchResult {
  return {
    provider: 'betaseries',
    externalId: String(show.id),
    // BetaSeries ne separe pas anime et serie : le pays d'origine est le seul
    // indice disponible, et il suffit pour l'affichage.
    kind: show.country === 'Japon' ? 'anime' : 'series',
    title: show.title,
    originalTitle: show.original_title ?? null,
    altTitles: [show.title, show.original_title].filter(
      (t): t is string => typeof t === 'string' && t.length > 0
    ),
    coverUrl: coverOfShow(show),
    platforms: platformsOfShow(show),
    // `episodes` arrive en chaine : ne pas le traiter comme un nombre.
    totalEpisodes: show.episodes ? Number(show.episodes) || null : null,
    year: show.creation ? Number(show.creation) || null : null,
    description: show.description || null,
  };
}

export function movieToSearchResult(movie: BsMovie): SearchResult {
  return {
    provider: 'betaseries',
    externalId: `m${movie.id}`,
    kind: 'series',
    title: movie.title,
    originalTitle: movie.original_title ?? null,
    altTitles: [movie.title, movie.original_title].filter(
      (t): t is string => typeof t === 'string' && t.length > 0
    ),
    coverUrl: movie.poster ?? null,
    platforms: [],
    totalEpisodes: null,
    year: movie.production_year ?? null,
    description: null,
  };
}

/**
 * Episode BetaSeries -> entree d'agenda.
 *
 * Limite assumee : `date` est une DATE sans heure (`YYYY-MM-DD`). L'API n'expose
 * aucun horaire de diffusion, contrairement a l'`airstamp` de TVmaze ou aux
 * mises en ligne d'ADN. On place donc les episodes en debut de journee et
 * l'agenda affiche des jours, pas des heures.
 */
const DEFAULT_HOUR = 9;

export function episodeToEntry(ep: BsEpisode): AiringEntry | null {
  const m = ep.date?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const airsAt = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    DEFAULT_HOUR,
    0,
    0,
    0
  ).getTime();
  if (!Number.isFinite(airsAt)) return null;

  const showId = ep.show?.id;
  return {
    key: `bs:${ep.id}`,
    itemId: showId ? `betaseries:${showId}` : `betaseries:ep${ep.id}`,
    kind: 'series',
    subtype: null,
    title: ep.show?.title ?? ep.title,
    coverUrl: null,
    episode: ep.episode,
    episodeTitle: ep.title || null,
    airsAt,
    platforms: [],
    source: 'betaseries',
    url: ep.resource_url ?? null,
    // L'etat vient du compte : c'est BetaSeries qui fait autorite, plus le local.
    watched: Boolean(ep.user?.seen),
  };
}

export function episodesToEntries(episodes: BsEpisode[]): AiringEntry[] {
  return episodes
    .map(episodeToEntry)
    .filter((e): e is AiringEntry => e !== null)
    .sort((a, b) => a.airsAt - b.airsAt);
}

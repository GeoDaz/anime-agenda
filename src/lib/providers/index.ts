import { cacheGet, cacheGetStale, cacheSet } from '../db';
import * as bs from '../betaseries/client';
import {
  episodesToEntries,
  movieToSearchResult,
  platformsOfShow,
  showToSearchResult,
  type BsMovie,
} from '../betaseries/adapter';
import { credentialsOf, type BetaSeriesSession } from '../betaseries/session';
import { tidyPlatforms } from '../platforms';
import type { AiringEntry, AppSettings, PlatformId, ResolvedItem, SearchResult, TrackedItem } from '../types';

/**
 * Source unique : BetaSeries.
 *
 * Les quatre providers precedents (AniList, ADN, TVmaze, TMDB) et la couche de
 * traduction Wikidata/Wikipedia ont ete retires. BetaSeries les remplace tous, et
 * rend en plus inutiles des pans entiers de code maison :
 *
 *   rapprochement de titres    -> leur recherche gere deja le multilingue
 *                                 ("Mercredi" trouve "Wednesday")
 *   table de plateformes       -> platforms.svods porte nom, couleur et logo
 *   progression locale         -> episode.user.seen sur le compte
 *   desambiguisation d homonymes -> identifiants distincts
 *                                 (One Piece anime #571, live #27127)
 *
 * Contrepartie mesuree : `date` est une DATE sans heure. L agenda affiche donc
 * des jours et non des horaires, la ou ADN donnait l heure de mise en ligne.
 */

/** Applique les overrides locaux par-dessus la donnee distante. */
export function resolveItem(item: TrackedItem): ResolvedItem {
  const o = item.overrides ?? {};
  return {
    ...item,
    displayTitle: o.title ?? item.title,
    displayCover: o.coverUrl ?? item.coverUrl ?? null,
    displayPlatforms: tidyPlatforms(o.platforms ?? item.platforms ?? []),
  };
}

// --------------------------------------------------------------------------
// Recherche
// --------------------------------------------------------------------------

/**
 * Recherche series + films.
 *
 * Aucun re-filtrage par titre : la mesure a montre que re-verifier les chaines
 * apres coup rejetait 19 titres sur 49 que BetaSeries avait pourtant trouves
 * correctement. On respecte donc leur classement, series d'abord.
 */
export async function searchAll(
  session: BetaSeriesSession,
  query: string
): Promise<SearchResult[]> {
  const creds = credentialsOf(session);
  if (!creds || !query.trim()) return [];

  const [shows, movies] = await Promise.all([
    bs.searchShows(creds, { title: query, nbpp: 20 }).then((r) => r.shows ?? []).catch(() => []),
    bs
      .request<{ movies?: BsMovie[] }>('GET', '/movies/search', creds, {
        query: { title: query, nbpp: 10 },
      })
      .then((r) => r.movies ?? [])
      .catch(() => []),
  ]);

  return [...shows.map(showToSearchResult), ...movies.map(movieToSearchResult)];
}

// --------------------------------------------------------------------------
// Bibliotheque du membre
// --------------------------------------------------------------------------

/**
 * Series suivies, avec le retard restant.
 * `/episodes/list` renvoie directement les series du membre et leurs episodes
 * non vus : c'est la vue la plus utile pour un agenda.
 */
export async function fetchLibrary(session: BetaSeriesSession): Promise<TrackedItem[]> {
  const creds = credentialsOf(session);
  if (!creds?.token) return [];

  const res = await bs.episodesToWatch(creds, { limit: 200 });
  const now = Date.now();

  return (res.shows ?? []).map((s) => ({
    id: `betaseries:${s.id}`,
    kind: 'series' as const,
    subtype: null,
    provider: 'betaseries' as const,
    externalId: String(s.id),
    title: s.title,
    originalTitle: null,
    coverUrl: null,
    platforms: [] as PlatformId[],
    totalEpisodes: null,
    links: { betaseriesId: s.id },
    status: 'watching' as const,
    // La progression fait autorite cote BetaSeries : `remaining` suffit a
    // afficher le retard, sans compter les episodes localement.
    progress: 0,
    watchedEpisodes: [],
    addedAt: now,
    updatedAt: now,
    remaining: s.remaining,
  })) as TrackedItem[];
}

/** Ajoute une serie ou un film au compte. */
export async function addToAccount(
  session: BetaSeriesSession,
  result: SearchResult
): Promise<void> {
  const creds = credentialsOf(session);
  if (!creds?.token) throw new Error('Connexion BetaSeries requise');

  // Les films sont prefixes « m » a l'adaptation, faute d'espace d'identifiants
  // commun entre series et films chez BetaSeries.
  if (result.externalId.startsWith('m')) {
    const id = Number(result.externalId.slice(1));
    await bs.request('POST', '/movies/movie', creds, { body: { id } });
    return;
  }
  await bs.addShow(creds, Number(result.externalId));
}

export async function removeFromAccount(
  session: BetaSeriesSession,
  externalId: string
): Promise<void> {
  const creds = credentialsOf(session);
  if (!creds?.token) throw new Error('Connexion BetaSeries requise');
  if (externalId.startsWith('m')) {
    await bs.request('DELETE', '/movies/movie', creds, { query: { id: Number(externalId.slice(1)) } });
    return;
  }
  await bs.removeShow(creds, Number(externalId));
}

/** Marque un episode vu, directement sur le compte. */
export async function setEpisodeWatched(
  session: BetaSeriesSession,
  episodeId: number,
  watched: boolean
): Promise<void> {
  const creds = credentialsOf(session);
  if (!creds?.token) throw new Error('Connexion BetaSeries requise');
  if (watched) await bs.markWatched(creds, { id: episodeId });
  else await bs.unmarkWatched(creds, episodeId);
}

// --------------------------------------------------------------------------
// Agenda
// --------------------------------------------------------------------------

export interface AgendaResult {
  entries: AiringEntry[];
  warnings: string[];
  usedCache: boolean;
}

const AGENDA_TTL = 30 * 60 * 1000;

/** Mois `YYYY-MM` couverts par un intervalle. Une semaine peut chevaucher deux mois. */
function monthsOf(range: { from: number; to: number }): string[] {
  const out = new Set<string>();
  const cursor = new Date(range.from);
  cursor.setDate(1);
  const last = new Date(range.to);
  while (cursor.getTime() <= last.getTime()) {
    out.add(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return [...out];
}

function applyFilters(entries: AiringEntry[], settings: AppSettings): AiringEntry[] {
  let out = entries;
  if (settings.platformFilter.length) {
    const keep = new Set<PlatformId>(settings.platformFilter);
    out = out.filter((e) => e.platforms.some((p) => keep.has(p)) || e.platforms.length === 0);
  }
  if (settings.hideWatched) out = out.filter((e) => !e.watched);
  return out;
}

/**
 * Agenda de la semaine, depuis le planning du membre.
 *
 * Le planning est demande PAR MOIS et mis en cache : naviguer entre les semaines
 * d'un meme mois ne declenche alors aucun appel. Les filtres sont appliques
 * apres le cache pour rester instantanes.
 */
export async function buildAgenda(
  session: BetaSeriesSession,
  range: { from: number; to: number },
  settings: AppSettings
): Promise<AgendaResult> {
  const creds = credentialsOf(session);
  if (!creds?.token) {
    return {
      entries: [],
      warnings: ['Connecte-toi à BetaSeries pour voir ton planning.'],
      usedCache: false,
    };
  }

  const months = monthsOf(range);
  const key = `bs:planning:${months.join(',')}`;

  const cached = await cacheGet<AiringEntry[]>(key);
  if (cached) {
    const inRange = cached.filter((e) => e.airsAt >= range.from && e.airsAt <= range.to);
    return { entries: applyFilters(inRange, settings), warnings: [], usedCache: true };
  }

  const warnings: string[] = [];
  const all: AiringEntry[] = [];

  for (const month of months) {
    try {
      const res = await bs.memberPlanning(creds, { month });
      all.push(...episodesToEntries(res.episodes ?? []));
    } catch (e) {
      warnings.push(e instanceof Error ? e.message : 'Planning indisponible');
    }
  }

  // Un planning vide alors que tout a echoue n'est pas un resultat : le mettre
  // en cache figerait la panne. On sert alors la derniere version connue.
  if (warnings.length && all.length === 0) {
    const stale = await cacheGetStale<AiringEntry[]>(key);
    if (stale?.length) {
      const inRange = stale.filter((e) => e.airsAt >= range.from && e.airsAt <= range.to);
      return {
        entries: applyFilters(inRange, settings),
        warnings: [...warnings, 'Affichage des dernières données enregistrées.'],
        usedCache: true,
      };
    }
  } else {
    await cacheSet(key, all, AGENDA_TTL);
  }

  const inRange = all.filter((e) => e.airsAt >= range.from && e.airsAt <= range.to);
  return { entries: applyFilters(inRange, settings), warnings, usedCache: false };
}

export { bs, platformsOfShow };

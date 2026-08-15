import { cacheGet, cacheGetStale, cacheSet, clearCacheByPrefix } from '../db';
import { fingerprint } from '../hash';
import * as bs from '../betaseries/client';
import {
  episodesToEntries,
  movieToSearchResult,
  platformsOfShow,
  showToSearchResult,
  toTrackedItem,
  withLibraryDetails,
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

/** Duree de vie de la bibliotheque en cache. */
const LIBRARY_TTL = 10 * 60 * 1000;
const LIBRARY_KEY = 'bs:library';

/**
 * Requete en vol, partagee.
 *
 * `useItems()` est appele par l'agenda, Ma liste, le panneau de recherche et
 * l'import : sans ce partage, ouvrir Ma liste declenchait DEUX telechargements
 * complets en parallele, et chaque retour sur l'onglet en relancait autant.
 */
let libraryInFlight: Promise<TrackedItem[]> | null = null;

/** Force le prochain appel a retourner chercher la liste. */
export async function invalidateLibrary(): Promise<void> {
  libraryInFlight = null;
  await cacheSet(LIBRARY_KEY, null, 0);
}

export async function fetchLibrary(
  session: BetaSeriesSession,
  options: { force?: boolean } = {}
): Promise<TrackedItem[]> {
  const creds = credentialsOf(session);
  if (!creds?.token) return [];

  if (!options.force) {
    const cached = await cacheGet<TrackedItem[]>(LIBRARY_KEY);
    if (cached) return cached;
    if (libraryInFlight) return libraryInFlight;
  }

  libraryInFlight = loadLibrary(creds).finally(() => {
    libraryInFlight = null;
  });
  return libraryInFlight;
}

/**
 * Toutes les series du compte.
 *
 * L implementation precedente utilisait /episodes/list, qui ne renvoie que les
 * series AYANT des episodes non vus : tout ce qui etait termine ou a jour
 * disparaissait de la liste.
 */
/**
 * Toutes les series du compte, en un appel.
 *
 * L'implementation precedente utilisait `/episodes/list`, qui ne renvoie que les
 * series AYANT des episodes non vus : tout ce qui etait termine ou a jour
 * disparaissait de la liste.
 */
async function loadLibrary(creds: NonNullable<ReturnType<typeof credentialsOf>>): Promise<TrackedItem[]> {
  /*
   * Un seul appel, sans pagination.
   *
   * `limit=-1` renvoie la liste complete, verifie identique en contenu et en
   * ordre a un parcours pagine. `limit=200` est d'ailleurs refuse par l'API
   * (« doit être inférieur à 200 »), donc paginer aurait impose des lots de 199.
   *
   * On ne filtre PAS par `status` cote serveur : seules quatre valeurs existent
   * (`current`, `active`, `archived`, `stopped`) et elles ne recouvrent pas les
   * etats de l'app. Le filtrage se fait donc en local, sur la liste complete.
   */
  const res = await bs.memberShows(creds, {
    limit: bs.MEMBER_SHOWS_ALL,
    // Seules 252 series sur 525 portent une date exploitable dans l'echantillon
    // mesure. Pour les autres, l'ordre du serveur sert de repli : « vu
    // recemment » est plus pertinent qu'un classement alphabetique.
    order: 'last_seen',
    /*
     * `summary` reduit la fiche de 37 a 11 champs, et `includes` reintroduit
     * exactement les deux blocs dont l'app a besoin. Mesure sur 525 series :
     *
     *   complet                              3227 Ko en 14 169 ms
     *   summary + includes=user,platforms     433 Ko en    321 ms
     *
     * Soit 44 fois moins de donnees. Et `platforms` est meme mieux couvert
     * ainsi : 525 series sur 525, contre 455 sur la charge complete.
     *
     * Champs perdus : original_title, country, description, genres, network.
     * Aucun n'est affiche ; la recherche locale se limite donc au titre.
     */
    summary: true,
    includes: 'user,platforms',
  });
  const raw = res.shows ?? [];

  // `sortIndex` preserve l'ordre du serveur a travers filtres et recherche, qui
  // ne font que retirer des elements.
  const items = raw.map((r, index) => ({ ...toTrackedItem(r), sortIndex: index }));
  await cacheSet(LIBRARY_KEY, items, LIBRARY_TTL);
  return items;
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
    await invalidateAfterWrite();
    return;
  }
  await bs.addShow(creds, Number(result.externalId));
  await invalidateAfterWrite();
}

export async function removeFromAccount(
  session: BetaSeriesSession,
  externalId: string
): Promise<void> {
  const creds = credentialsOf(session);
  if (!creds?.token) throw new Error('Connexion BetaSeries requise');
  if (externalId.startsWith('m')) {
    await bs.request('DELETE', '/movies/movie', creds, { query: { id: Number(externalId.slice(1)) } });
    await invalidateAfterWrite();
    return;
  }
  await bs.removeShow(creds, Number(externalId));
  await invalidateAfterWrite();
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
  await invalidateAfterWrite();
}

/**
 * Purge ce qui devient faux apres une ecriture sur le compte.
 *
 * La bibliotheque ET le planning changent : ne vider que l une des deux
 * laisserait le calendrier en retard sur la liste.
 */
async function invalidateAfterWrite(): Promise<void> {
  await invalidateLibrary();
  await clearPlanningCache();
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

/** Vide tous les plannings mis en cache, quel que soit le mois. */
export function clearPlanningCache(): Promise<void> {
  return clearCacheByPrefix('bs:planning:');
}

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
  settings: AppSettings,
  /** Bibliotheque deja chargee : seule source de jaquettes et de plateformes. */
  library: TrackedItem[] = []
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
  /*
   * La cle depend de la BIBLIOTHEQUE autant que du mois.
   *
   * Sans cette empreinte, ajouter une serie ne changeait pas la cle : le
   * planning restait servi depuis le cache pendant trente minutes et le
   * calendrier semblait ignorer l ajout. C est une regression introduite lors du
   * passage a BetaSeries — la version precedente incluait deja cette empreinte.
   */
  const signature = fingerprint(
    library
      .map((i) => i.id)
      .sort()
      .join('|')
  );
  const key = `bs:planning:${months.join(',')}:${signature}`;

  const cached = await cacheGet<AiringEntry[]>(key);
  if (cached) {
    const inRange = withLibraryDetails(
      cached.filter((e) => e.airsAt >= range.from && e.airsAt <= range.to),
      library
    );
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
      const inRange = withLibraryDetails(
        stale.filter((e) => e.airsAt >= range.from && e.airsAt <= range.to),
        library
      );
      return {
        entries: applyFilters(inRange, settings),
        warnings: [...warnings, 'Affichage des dernières données enregistrées.'],
        usedCache: true,
      };
    }
  } else {
    await cacheSet(key, all, AGENDA_TTL);
  }

  const inRange = withLibraryDetails(
    all.filter((e) => e.airsAt >= range.from && e.airsAt <= range.to),
    library
  );
  return { entries: applyFilters(inRange, settings), warnings, usedCache: false };
}

export { bs, platformsOfShow };

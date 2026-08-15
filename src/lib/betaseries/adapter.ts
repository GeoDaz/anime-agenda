import { normalizePlatform, tidyPlatforms } from '../platforms';
import type { AiringEntry, PlatformId, SearchResult, TrackedItem } from '../types';
import type { BsEpisode, BsShow, BsShowUserState } from './types';

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

/**
 * Serie du compte -> fiche de l'application.
 *
 * `/shows/member` ne declare aucun schema de reponse (comme 181 des 203
 * operations de cette spec). La lecture est donc volontairement defensive :
 * chaque champ est teste avant usage, et un objet inattendu produit une fiche
 * degradee plutot qu'une exception qui viderait toute la liste.
 *
 * Les noms de champs viennent de ce qui a ete OBSERVE sur `/shows/display`,
 * qui renvoie la meme ressource « show » :
 *   user: { archived, favorited, remaining, status, last, next, ... }
 */
export function toTrackedItem(raw: unknown): TrackedItem {
  const s = (raw ?? {}) as Partial<BsShow> & {
    user?: Partial<BsShowUserState> & { last?: string | null; next?: string | null };
  };
  const id = Number(s.id) || 0;
  const now = Date.now();

  /*
   * `user` contre `userVisited` : un piege verifie.
   *
   * `user` porte la progression de l'utilisateur AUTHENTIFIE, `userVisited`
   * celle du membre consulte. Sans jeton, `user` est integralement vide —
   * mesure sur 525 series : `status` a 0 partout, `remaining` a 0 partout,
   * `last` fige a "S00E00". Lire `user` sans repli afficherait donc une
   * bibliotheque entiere a zero pour cent.
   */
  type UserBlock = Partial<BsShowUserState> & {
    last?: string | null;
    next?: { id?: number | null; code?: string | null; date?: string | null } | null;
  };
  const visited = (s as { userVisited?: UserBlock }).userVisited;
  const own: UserBlock = s.user ?? {};
  // On prend le bloc qui contient reellement quelque chose.
  const user: UserBlock =
    own.status || own.remaining || (own.last && own.last !== 'S00E00') ? own : (visited ?? own);

  const remaining = Number(user.remaining ?? 0) || 0;
  const archived = user.archived === true;

  /*
   * Correspondance des etats.
   *
   * `user.status` est un POURCENTAGE d'avancement (valeurs decimales de 0 a 100),
   * et non un code d'etat : les histogrammes observes le confirment (100 pour la
   * majorite des series terminees, 72.2, 33.33, 12.5…). « En pause » a ete retire
   * faute d'equivalent chez BetaSeries.
   */
  const progression = Number(user.status ?? 0) || 0;
  let status: TrackedItem['status'];
  if (archived) status = 'dropped';
  else if (progression <= 0) status = 'planned';
  else if (progression >= 100 || remaining === 0) status = 'done';
  else status = 'watching';

  /*
   * Date de diffusion.
   *
   * `user.last` est un CODE d'episode ("S01E13"), pas une date : le parser
   * donnerait NaN et un tri silencieusement faux. `user.next` est en revanche un
   * objet portant une vraie `date`, seul champ exploitable pour trier par
   * diffusion.
   */
  const nextDate = user.next?.date;
  const lastAired = typeof nextDate === 'string' ? Date.parse(nextDate) : NaN;

  return {
    id: `betaseries:${id}`,
    kind: s.country === 'Japon' ? 'anime' : 'series',
    subtype: null,
    provider: 'betaseries',
    externalId: String(id),
    title: s.title ?? 'Sans titre',
    originalTitle: s.original_title ?? null,
    coverUrl: s.images ? coverOfShow(s as BsShow) : null,
    platforms: s.platforms || s.network ? platformsOfShow(s as BsShow) : [],
    // Champ numerique renvoye en chaine par l'API : ne pas le traiter tel quel.
    totalEpisodes: s.episodes ? Number(s.episodes) || null : null,
    links: { betaseriesId: id },
    status,
    progress: 0,
    watchedEpisodes: [],
    remaining,
    lastAiredAt: Number.isFinite(lastAired) ? lastAired : null,
    addedAt: now,
    updatedAt: now,
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
    // Le planning ne transporte NI jaquette NI plateforme : l'objet `show`
    // imbrique se limite a { id, thetvdb_id, title, slug, status, description }.
    // Ces deux champs sont completes depuis la bibliotheque, qui les possede,
    // via `withLibraryDetails` — sans requete supplementaire.
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

/**
 * Complete les entrees d'agenda avec la jaquette et les plateformes.
 *
 * Le planning BetaSeries ne les fournit pas, alors que la bibliotheque les
 * porte deja : on rapproche donc par identifiant de serie. C'est fait a
 * l'affichage plutot qu'avant la mise en cache, pour qu'une jaquette mise a jour
 * ou un override local soit pris en compte immediatement.
 *
 * Sans ce complement, l'agenda affichait un carre gris pour chaque episode et le
 * filtre par plateforme ne pouvait rien filtrer.
 */
export function withLibraryDetails(
  entries: AiringEntry[],
  library: { id: string; coverUrl?: string | null; platforms?: PlatformId[]; overrides?: { coverUrl?: string } }[]
): AiringEntry[] {
  if (!library.length) return entries;

  const byId = new Map(library.map((i) => [i.id, i]));
  return entries.map((entry) => {
    const item = byId.get(entry.itemId);
    if (!item) return entry;
    return {
      ...entry,
      coverUrl: entry.coverUrl ?? item.overrides?.coverUrl ?? item.coverUrl ?? null,
      platforms: entry.platforms.length ? entry.platforms : (item.platforms ?? []),
    };
  });
}

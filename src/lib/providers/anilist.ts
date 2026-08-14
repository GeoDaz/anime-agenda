import { cacheGet, cacheGetStale, cacheSet } from '../db';
import { fingerprint } from '../hash';
import { normalizePlatform, tidyPlatforms } from '../platforms';
import type { AiringEntry, PlatformId, SearchResult, TrackedItem } from '../types';

/**
 * AniList — planning de diffusion des animes.
 *
 * Repond avec Access-Control-Allow-Origin: * donc appelable directement depuis
 * le navigateur, sans backend ni cle d'API. `airingSchedules` donne l'horaire de
 * diffusion japonaise a la minute ; les simulcasts FR (Crunchyroll/ADN) tombent
 * en general dans l'heure. Quand ADN nous donne la vraie date FR, elle gagne
 * (cf. l'arbitrage dans providers/index.ts).
 */

const ENDPOINT = 'https://graphql.anilist.co';
const TTL = 30 * 60 * 1000; // 30 min : le planning bouge peu dans la journee.
/**
 * Le planning de diffusion est annonce des semaines a l'avance et ne bouge que
 * rarement (report, episode recapitulatif). Six heures suffisent amplement, et
 * la fenetre etant large, une seule requete couvre tout un mois de navigation.
 */
const AIRING_TTL = 6 * 60 * 60 * 1000;

interface AniListMedia {
  id: number;
  title: { romaji: string | null; english: string | null; native: string | null };
  coverImage: { large: string | null } | null;
  episodes: number | null;
  seasonYear: number | null;
  description: string | null;
  format: string | null;
  externalLinks: { site: string; url: string; type: string | null }[] | null;
}

interface AniListSchedule {
  episode: number;
  airingAt: number;
  media: AniListMedia;
}

/**
 * Erreur de quota, distincte d'un simple echec reseau.
 *
 * AniList plafonne a 30 requetes/minute (verifie : `x-ratelimit-limit: 30`).
 * L'appelant doit pouvoir distinguer "cette serie est introuvable" de "je n'ai
 * pas pu chercher" — sinon l'UI affiche "aucune correspondance" pour un
 * probleme de debit, ce qui est trompeur.
 */
export class AniListRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Quota AniList atteint, réessai dans ${Math.ceil(retryAfterMs / 1000)} s`);
    this.name = 'AniListRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') ?? '60');
    throw new AniListRateLimitError((Number.isFinite(retryAfter) ? retryAfter : 60) * 1000);
  }
  if (!res.ok) throw new Error(`AniList ${res.status}`);

  const json = await res.json();
  if (json.errors?.length) throw new Error(`AniList: ${json.errors[0].message}`);
  return json.data as T;
}

function platformsOf(media: AniListMedia): PlatformId[] {
  const list = (media.externalLinks ?? [])
    .filter((l) => l.type === 'STREAMING')
    .map((l) => normalizePlatform(l.site));
  return tidyPlatforms(list);
}

function toSearchResult(media: AniListMedia): SearchResult {
  return {
    provider: 'anilist',
    externalId: String(media.id),
    kind: 'anime',
    // AniList ne reference que de l'animation : jamais de live action.
    subtype: 'animation',
    title: media.title.romaji ?? media.title.english ?? media.title.native ?? 'Sans titre',
    originalTitle: media.title.native ?? null,
    // Le titre anglais est souvent le SEUL a correspondre a ce que l'utilisateur
    // connait ("The Eminence in Shadow" pour "Kage no Jitsuryokusha...").
    altTitles: [media.title.english, media.title.romaji, media.title.native].filter(
      (t): t is string => typeof t === 'string' && t.length > 0
    ),
    coverUrl: media.coverImage?.large ?? null,
    platforms: platformsOf(media),
    totalEpisodes: media.episodes,
    year: media.seasonYear,
    description: media.description?.replace(/<[^>]+>/g, '').slice(0, 400) ?? null,
  };
}

const MEDIA_FIELDS = `
  id
  title { romaji english native }
  coverImage { large }
  episodes
  seasonYear
  description
  format
  externalLinks { site url type }
`;

// --------------------------------------------------------------------------

export async function searchAnime(query: string): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  const data = await gql<{ Page: { media: AniListMedia[] } }>(
    `query ($q: String) {
      Page(perPage: 20) {
        media(type: ANIME, search: $q, sort: SEARCH_MATCH, isAdult: false) { ${MEDIA_FIELDS} }
      }
    }`,
    { q: query }
  );
  return data.Page.media.map(toSearchResult);
}

/** Nombre de recherches regroupees dans une seule requete GraphQL. */
export const SEARCH_BATCH_SIZE = 8;

/**
 * Plusieurs recherches en UNE requete, via les alias GraphQL.
 *
 * Sans ca, importer 60 titres = 60 requetes, soit le double du quota d'une
 * minute (30/min) : la moitie des lignes repondait 429 et s'affichait
 * "aucune correspondance". Avec des lots de 8, 60 titres tiennent en 8 requetes.
 *
 * Renvoie une Map titre -> resultats, dans l'ordre demande.
 */
export async function searchAnimeBatch(queries: string[]): Promise<Map<string, SearchResult[]>> {
  const out = new Map<string, SearchResult[]>();
  const clean = queries.filter((q) => q.trim().length > 0);
  if (!clean.length) return out;

  const aliases = clean
    .map(
      (q, i) =>
        `q${i}: Page(perPage: 8) { media(type: ANIME, search: ${JSON.stringify(
          q
        )}, sort: SEARCH_MATCH, isAdult: false) { ${MEDIA_FIELDS} } }`
    )
    .join('\n');

  const data = await gql<Record<string, { media: AniListMedia[] }>>(
    `query {\n${aliases}\n}`,
    {}
  );

  clean.forEach((q, i) => {
    const media = data?.[`q${i}`]?.media ?? [];
    out.set(q, media.map(toSearchResult));
  });
  return out;
}

export async function fetchAnimeByIds(ids: number[]): Promise<Map<number, SearchResult>> {
  const out = new Map<number, SearchResult>();
  if (!ids.length) return out;
  // AniList plafonne a 50 par page ; on decoupe.
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const data = await gql<{ Page: { media: AniListMedia[] } }>(
      `query ($ids: [Int]) {
        Page(perPage: 50) { media(type: ANIME, id_in: $ids) { ${MEDIA_FIELDS} } }
      }`,
      { ids: chunk }
    );
    for (const m of data.Page.media) out.set(m.id, toSearchResult(m));
  }
  return out;
}

/**
 * Planning de la semaine pour une liste d'ids AniList.
 * Passe par le cache IndexedDB, avec repli sur une version perimee si le
 * reseau est absent — c'est ce qui rend l'agenda consultable hors-ligne.
 */
export async function fetchAiringForIds(
  anilistIds: number[],
  range: { from: number; to: number }
): Promise<AniListSchedule[]> {
  if (!anilistIds.length) return [];

  /*
   * On telecharge une fenetre LARGE et on decoupe en local.
   *
   * Avant, la cle contenait les bornes exactes de la semaine : changer de
   * semaine ratait le cache et redeclenchait une requete. Desormais les semaines
   * sont regroupees par tranches de 4 semaines (avec une marge d'une semaine de
   * chaque cote), donc naviguer dans le mois ne coute plus rien.
   *
   * La cle passe aussi par un hash : une bibliotheque de 40 series produisait
   * sinon une cle de plusieurs centaines de caracteres.
   */
  const BUCKET = 28 * 24 * 60 * 60 * 1000;
  const MARGIN = 7 * 24 * 60 * 60 * 1000;
  const bucket = Math.floor(range.from / BUCKET);
  const windowFrom = bucket * BUCKET - MARGIN;
  const windowTo = (bucket + 1) * BUCKET + MARGIN;

  const from = Math.floor(windowFrom / 1000);
  const to = Math.ceil(windowTo / 1000);
  const ids = fingerprint([...anilistIds].sort((a, b) => a - b).join(','));
  const cacheKey = `anilist:airing:${bucket}:${ids}`;

  /** Ne renvoie que ce que l'appelant a demande, la fenetre etant plus large. */
  const slice = (all: AniListSchedule[]) =>
    all.filter((s) => s.airingAt * 1000 >= range.from && s.airingAt * 1000 <= range.to);

  const cached = await cacheGet<AniListSchedule[]>(cacheKey);
  if (cached) return slice(cached);

  try {
    const all: AniListSchedule[] = [];
    for (let i = 0; i < anilistIds.length; i += 50) {
      const chunk = anilistIds.slice(i, i + 50);
      let page = 1;
      // Une serie peut avoir plusieurs episodes sur la semaine ; on pagine.
      for (;;) {
        const data = await gql<{
          Page: {
            pageInfo: { hasNextPage: boolean };
            airingSchedules: AniListSchedule[];
          };
        }>(
          `query ($ids: [Int], $from: Int, $to: Int, $page: Int) {
            Page(page: $page, perPage: 50) {
              pageInfo { hasNextPage }
              airingSchedules(
                mediaId_in: $ids
                airingAt_greater: $from
                airingAt_lesser: $to
                sort: TIME
              ) {
                episode
                airingAt
                media { ${MEDIA_FIELDS} }
              }
            }
          }`,
          { ids: chunk, from, to, page }
        );
        all.push(...data.Page.airingSchedules);
        if (!data.Page.pageInfo.hasNextPage) break;
        page++;
      }
    }
    // La fenetre large est mise en cache ; l'appelant n'en voit que sa tranche.
    await cacheSet(cacheKey, all, AIRING_TTL);
    return slice(all);
  } catch (err) {
    const stale = await cacheGetStale<AniListSchedule[]>(cacheKey);
    if (stale) return slice(stale);
    throw err;
  }
}

/** Convertit le planning AniList en entrees d'agenda pour les items suivis. */
export function scheduleToEntries(
  schedules: AniListSchedule[],
  itemsByAnilistId: Map<number, TrackedItem>
): AiringEntry[] {
  const out: AiringEntry[] = [];
  for (const s of schedules) {
    const item = itemsByAnilistId.get(s.media.id);
    if (!item) continue;
    out.push({
      key: `${item.id}:${s.episode}`,
      itemId: item.id,
      kind: item.kind,
      subtype: item.subtype ?? null,
      title: item.overrides?.title ?? item.title,
      coverUrl: item.overrides?.coverUrl ?? item.coverUrl ?? s.media.coverImage?.large ?? null,
      episode: s.episode,
      episodeTitle: null,
      airsAt: s.airingAt * 1000,
      platforms: item.overrides?.platforms ?? tidyPlatforms(platformsOf(s.media)),
      source: 'anilist',
      url: null,
      watched: (item.watchedEpisodes ?? []).includes(s.episode),
    });
  }
  return out;
}

/**
 * Mode decouverte : ce qui sort cette semaine sur les plateformes FR,
 * meme hors bibliotheque. Utile pour reperer les nouveautes a ajouter.
 */
export async function fetchWeeklyDiscovery(range: {
  from: number;
  to: number;
}): Promise<{ schedule: AniListSchedule; platforms: PlatformId[] }[]> {
  const from = Math.floor(range.from / 1000);
  const to = Math.ceil(range.to / 1000);
  const cacheKey = `anilist:discovery:${from}:${to}`;

  const cached = await cacheGet<{ schedule: AniListSchedule; platforms: PlatformId[] }[]>(cacheKey);
  if (cached) return cached;

  const collect = async () => {
    const all: AniListSchedule[] = [];
    let page = 1;
    // On borne a 5 pages : au-dela c'est du bruit (emissions courtes, YouTube).
    while (page <= 5) {
      const data = await gql<{
        Page: { pageInfo: { hasNextPage: boolean }; airingSchedules: AniListSchedule[] };
      }>(
        `query ($from: Int, $to: Int, $page: Int) {
          Page(page: $page, perPage: 50) {
            pageInfo { hasNextPage }
            airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
              episode
              airingAt
              media { ${MEDIA_FIELDS} }
            }
          }
        }`,
        { from, to, page }
      );
      all.push(...data.Page.airingSchedules);
      if (!data.Page.pageInfo.hasNextPage) break;
      page++;
    }
    return all
      .map((schedule) => ({ schedule, platforms: platformsOf(schedule.media) }))
      .filter((r) => r.platforms.some((p) => p !== 'other'));
  };

  try {
    const result = await collect();
    await cacheSet(cacheKey, result, TTL);
    return result;
  } catch (err) {
    const stale =
      await cacheGetStale<{ schedule: AniListSchedule; platforms: PlatformId[] }[]>(cacheKey);
    if (stale) return stale;
    throw err;
  }
}

export type { AniListSchedule, AniListMedia };

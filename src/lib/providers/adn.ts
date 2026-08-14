import { cacheGet, cacheGetStale, cacheSet } from '../db';
import { parseEpisodeNumber, titlesMatch } from '../match';
import type { AiringEntry, SearchResult, TrackedItem } from '../types';

/**
 * ADN (Animation Digital Network) — les vraies dates de sortie francaises.
 *
 * L'API passerelle publique repond en CORS `*` sans authentification pour le
 * calendrier et le catalogue. C'est notre meilleure source pour "quand est-ce
 * que ca sort en France", parce qu'AniList ne donne que l'horaire japonais.
 *
 * Endpoints verifies :
 *   GET /video/calendar?date=YYYY-MM-DD   -> { videos: [...] }
 *   GET /show/catalog?search=...&limit=n  -> { shows: [...] }
 *
 * A noter : le calendrier melange les vraies sorties hebdomadaires et les
 * ajouts de catalogue en masse (ex. 21 episodes de Détective Conan le meme
 * jour). Ce n'est pas un probleme ici puisqu'on ne retient que ce qui
 * correspond a une serie suivie.
 *
 * BASE est isolee pour pouvoir basculer sur une Route Handler Next.js faisant
 * proxy si ADN retirait un jour ses en-tetes CORS.
 */

const BASE = 'https://gw.api.animationdigitalnetwork.com';
const HEADERS: HeadersInit = {
  'X-Target-Distribution': 'fr',
  Accept: 'application/json',
};
const TTL = 60 * 60 * 1000; // 1 h

export interface AdnShow {
  id: number;
  title: string;
  originalTitle: string | null;
  shortTitle: string | null;
  reference: string;
  image: string | null;
  image2x: string | null;
  episodeCount: number;
  simulcast: boolean;
  nextVideoReleaseDate: string | null;
  firstReleaseYear: string | null;
  summary: string | null;
  languages: string[];
}

export interface AdnVideo {
  id: number;
  title: string;
  /** Titre de l'episode en francais, souvent vide. */
  name: string;
  number: string;
  shortNumber: string;
  season: string;
  releaseDate: string;
  url: string;
  image: string | null;
  languages: string[];
  available: boolean;
  show: AdnShow;
}

async function adnFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`ADN ${res.status} sur ${path}`);
  return (await res.json()) as T;
}

/** Le calendrier d'hier ne changera plus : inutile de le redemander chaque heure. */
const PAST_TTL = 30 * 24 * 60 * 60 * 1000;

/**
 * Duree de cache selon l'anciennete du jour demande.
 *
 * Un jour revolu est immuable, donc cache un mois. Aujourd'hui et les jours a
 * venir peuvent encore bouger (ajout d'un simulcast, horaire ajuste) : une heure.
 * C'est ce qui rend la navigation vers les semaines passees gratuite.
 */
function ttlForDate(date: string): number {
  const day = new Date(`${date}T23:59:59`).getTime();
  if (!Number.isFinite(day)) return TTL;
  return day < Date.now() ? PAST_TTL : TTL;
}

/** Calendrier ADN d'un jour donne (format `YYYY-MM-DD`). */
export async function fetchDay(date: string): Promise<AdnVideo[]> {
  const cacheKey = `adn:calendar:${date}`;
  const cached = await cacheGet<AdnVideo[]>(cacheKey);
  if (cached) return cached;

  try {
    const data = await adnFetch<{ videos: AdnVideo[] }>(`/video/calendar?date=${date}`);
    const videos = data.videos ?? [];
    await cacheSet(cacheKey, videos, ttlForDate(date));
    return videos;
  } catch (err) {
    const stale = await cacheGetStale<AdnVideo[]>(cacheKey);
    if (stale) return stale;
    throw err;
  }
}

/** Calendrier sur plusieurs jours. Les jours en echec sont ignores, pas fatals. */
export async function fetchDays(dates: string[]): Promise<AdnVideo[]> {
  const results = await Promise.all(
    dates.map((d) => fetchDay(d).catch(() => [] as AdnVideo[]))
  );
  return results.flat();
}

export async function searchShows(query: string): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  const data = await adnFetch<{ shows: AdnShow[] }>(
    `/show/catalog?search=${encodeURIComponent(query)}&limit=20`
  );
  return (data.shows ?? []).map((show) => ({
    provider: 'adn' as const,
    externalId: String(show.id),
    kind: 'anime' as const,
    // ADN ne distribue que de l'animation japonaise.
    subtype: 'animation' as const,
    title: show.title,
    originalTitle: show.originalTitle,
    coverUrl: show.image2x ?? show.image,
    platforms: ['adn' as const],
    totalEpisodes: show.episodeCount || null,
    year: show.firstReleaseYear ? Number(show.firstReleaseYear) : null,
    description: show.summary,
  }));
}

/**
 * Relie les videos ADN aux series suivies.
 *
 * Priorite au lien deja memorise (`links.adnShowId`) : une fois la
 * correspondance etablie, elle est exacte et gratuite. Sinon on tente le
 * rapprochement par titre, avec le titre FR et le romaji comme candidats.
 */
export function videosToEntries(videos: AdnVideo[], items: TrackedItem[]): AiringEntry[] {
  const byAdnId = new Map<number, TrackedItem>();
  for (const item of items) {
    if (item.links?.adnShowId) byAdnId.set(item.links.adnShowId, item);
    if (item.provider === 'adn' && item.externalId) byAdnId.set(Number(item.externalId), item);
  }

  /**
   * Seuls ces items peuvent recevoir un episode ADN.
   *
   * Sans ce filtre, le rapprochement par titre attribuait les episodes de
   * l'anime "One Piece" a la serie live-action "One Piece" de Netflix : les deux
   * portent exactement le meme nom, donc `titlesMatch` renvoyait vrai et,
   * n'ayant qu'un seul candidat, la regle d'unicite ne protegeait pas.
   *
   * ADN ne diffuse que de l'animation japonaise : un item live-action n'est
   * jamais eligible. Un lien ADN explicite reste prioritaire, puisqu'il vient
   * d'un rapprochement deja valide ou d'un choix de l'utilisateur.
   */
  const eligible = items.filter(
    (i) =>
      i.links?.adnShowId != null ||
      i.provider === 'adn' ||
      (i.kind === 'anime' && i.subtype !== 'live')
  );

  const out: AiringEntry[] = [];

  for (const video of videos) {
    if (!video.show) continue;

    let item = byAdnId.get(video.show.id);

    if (!item) {
      const hits = eligible.filter((candidate) =>
        titlesMatch(
          [candidate.title, candidate.originalTitle, candidate.overrides?.title],
          [video.show.title, video.show.originalTitle, video.show.shortTitle]
        )
      );
      // Meme regle que resolveAdnShowId : en cas d'ambiguite on n'attribue rien.
      if (hits.length === 1) item = hits[0];
    }
    if (!item) continue;

    const episode = parseEpisodeNumber(video.shortNumber ?? video.number);
    const airsAt = new Date(video.releaseDate).getTime();
    if (!Number.isFinite(airsAt)) continue;

    out.push({
      key: `${item.id}:${episode ?? airsAt}`,
      itemId: item.id,
      kind: item.kind,
      subtype: item.subtype ?? null,
      title: item.overrides?.title ?? item.title,
      coverUrl: item.overrides?.coverUrl ?? item.coverUrl ?? video.show.image2x ?? null,
      episode,
      episodeTitle: video.name?.trim() || null,
      airsAt,
      platforms: item.overrides?.platforms ?? ['adn'],
      source: 'adn',
      url: video.url,
      watched: episode !== null && (item.watchedEpisodes ?? []).includes(episode),
    });
  }

  return out;
}

/** Nombre max de series par page impose par l'API (verifie : 101 -> 400). */
const CATALOG_PAGE_SIZE = 100;
const CATALOG_TTL = 24 * 60 * 60 * 1000;

/**
 * Catalogue ADN complet, mis en cache 24 h.
 *
 * Pourquoi tout charger plutot que d'appeler `?search=` : la recherche ADN ne
 * porte QUE sur le titre francais. Chercher "Meitantei Conan" renvoie zero
 * resultat alors que la serie existe sous "Détective Conan" avec
 * `originalTitle: "Meitantei Conan"`. Or c'est justement le romaji qu'AniList
 * nous donne. Le catalogue ne fait que ~580 series, soit 6 requetes : on
 * l'indexe donc en local et on rapproche sur `originalTitle`.
 */
export async function fetchCatalog(): Promise<AdnShow[]> {
  const cacheKey = 'adn:catalog:full';
  const cached = await cacheGet<AdnShow[]>(cacheKey);
  if (cached) return cached;

  try {
    const first = await adnFetch<{ shows: AdnShow[]; total: number }>(
      `/show/catalog?limit=${CATALOG_PAGE_SIZE}&offset=0`
    );
    const total = first.total ?? first.shows?.length ?? 0;
    const shows = [...(first.shows ?? [])];

    const offsets: number[] = [];
    for (let o = CATALOG_PAGE_SIZE; o < total; o += CATALOG_PAGE_SIZE) offsets.push(o);

    const pages = await Promise.all(
      offsets.map((offset) =>
        adnFetch<{ shows: AdnShow[] }>(
          `/show/catalog?limit=${CATALOG_PAGE_SIZE}&offset=${offset}`
        )
          .then((p) => p.shows ?? [])
          .catch(() => [] as AdnShow[])
      )
    );
    for (const page of pages) shows.push(...page);

    await cacheSet(cacheKey, shows, CATALOG_TTL);
    return shows;
  } catch (err) {
    const stale = await cacheGetStale<AdnShow[]>(cacheKey);
    if (stale) return stale;
    throw err;
  }
}

/**
 * Devine l'id ADN d'une serie suivie pour memoriser le lien.
 * Passe par le catalogue en cache : gratuit apres le premier chargement.
 */
export async function resolveAdnShowId(item: {
  title: string;
  originalTitle?: string | null;
}): Promise<number | null> {
  try {
    const catalog = await fetchCatalog();
    const hits = catalog.filter((s) =>
      titlesMatch([item.title, item.originalTitle], [s.title, s.originalTitle, s.shortTitle])
    );
    // Ambiguite = on ne lie rien. Un mauvais lien colle des episodes d'une
    // autre serie dans l'agenda, ce qui est pire que pas de date ADN du tout.
    return hits.length === 1 ? hits[0].id : null;
  } catch {
    return null;
  }
}

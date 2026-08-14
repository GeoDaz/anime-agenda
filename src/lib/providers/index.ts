import { cacheGet, cacheGetStale, cacheSet } from '../db';
import { fingerprint } from '../hash';
import { tidyPlatforms } from '../platforms';
import type {
  AiringEntry,
  AppSettings,
  PlatformId,
  ResolvedItem,
  SearchResult,
  TrackedItem,
} from '../types';
import { datesInRange } from '../week';
import * as adn from './adn';
import * as anilist from './anilist';
import * as titles from './titles';
import * as tmdb from './tmdb';
import * as tvmaze from './tvmaze';

/**
 * Couche d'arbitrage entre providers.
 *
 * Deux regles, dans cet ordre :
 *  1. Les overrides locaux gagnent toujours (resolveItem).
 *  2. Entre providers, la source la plus proche de la realite francaise gagne
 *     pour la DATE, mais les plateformes sont fusionnees (une serie peut sortir
 *     sur Crunchyroll ET ADN).
 */

/** Plus le chiffre est haut, plus la source est fiable pour une date FR. */
const SOURCE_RANK: Record<AiringEntry['source'], number> = {
  adn: 5, // date de mise en ligne FR reelle
  tmdb: 4, // date de diffusion, region FR (mais sans horaire)
  tvmaze: 3, // horaire precis, mais calendrier du pays d'origine
  anilist: 2, // diffusion japonaise, decalage possible
  manual: 1, // estimation de l'utilisateur
};

/** Applique les overrides locaux par-dessus les donnees provider. */
export function resolveItem(item: TrackedItem): ResolvedItem {
  const o = item.overrides ?? {};
  return {
    ...item,
    displayTitle: o.title ?? item.title,
    displayCover: o.coverUrl ?? item.coverUrl ?? null,
    displayPlatforms: tidyPlatforms(o.platforms ?? item.platforms ?? []),
  };
}

/**
 * Fusionne les entrees de toutes les sources.
 * Deduplication sur (serie, episode) : c'est la meme sortie vue par deux APIs.
 */
export function mergeEntries(groups: AiringEntry[][]): AiringEntry[] {
  const byKey = new Map<string, AiringEntry>();

  for (const entry of groups.flat()) {
    const dedupeKey = `${entry.itemId}:${entry.episode ?? entry.airsAt}`;
    const existing = byKey.get(dedupeKey);

    if (!existing) {
      byKey.set(dedupeKey, { ...entry, key: dedupeKey });
      continue;
    }

    const winner = SOURCE_RANK[entry.source] > SOURCE_RANK[existing.source] ? entry : existing;
    const loser = winner === entry ? existing : entry;

    byKey.set(dedupeKey, {
      ...winner,
      key: dedupeKey,
      // Union des plateformes : l'info de chaque source est complementaire.
      platforms: tidyPlatforms([...winner.platforms, ...loser.platforms]),
      // On garde le titre d'episode et le lien de qui en a un.
      episodeTitle: winner.episodeTitle ?? loser.episodeTitle,
      url: winner.url ?? loser.url,
      coverUrl: winner.coverUrl ?? loser.coverUrl,
      watched: winner.watched || loser.watched,
    });
  }

  return [...byKey.values()].sort((a, b) => a.airsAt - b.airsAt);
}

/**
 * Entrees deduites d'un jour de parution saisi a la main.
 * C'est le filet pour les series qu'aucun provider ne couvre correctement.
 */
function manualEntries(items: TrackedItem[], range: { from: number; to: number }): AiringEntry[] {
  const out: AiringEntry[] = [];

  for (const item of items) {
    const weekday = item.overrides?.weekday;
    if (weekday === undefined || weekday === null) continue;

    const [h, m] = (item.overrides?.time ?? '09:00').split(':').map(Number);
    const cursor = new Date(range.from);
    cursor.setHours(0, 0, 0, 0);

    for (let i = 0; i < 8; i++) {
      const day = new Date(cursor);
      day.setDate(day.getDate() + i);
      if (day.getDay() !== weekday) continue;

      day.setHours(Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0, 0, 0);
      const ts = day.getTime();
      if (ts < range.from || ts > range.to) continue;

      const episode = item.progress + 1;
      out.push({
        key: `${item.id}:${episode}`,
        itemId: item.id,
        kind: item.kind,
        subtype: item.subtype ?? null,
        title: item.overrides?.title ?? item.title,
        coverUrl: item.overrides?.coverUrl ?? item.coverUrl ?? null,
        episode,
        episodeTitle: null,
        airsAt: ts,
        platforms: tidyPlatforms(item.overrides?.platforms ?? item.platforms ?? []),
        source: 'manual',
        url: null,
        watched: (item.watchedEpisodes ?? []).includes(episode),
      });
    }
  }

  return out;
}

export interface AgendaResult {
  entries: AiringEntry[];
  /** Erreurs non bloquantes, affichees discretement dans l'UI. */
  warnings: string[];
  /** Vrai si au moins une source a repondu depuis le cache perime. */
  usedCache: boolean;
}

/**
 * Duree de validite d'un agenda deja calcule.
 *
 * 30 minutes : assez court pour qu'un episode ajoute au planning apparaisse dans
 * la demi-heure, assez long pour qu'une session de navigation entre semaines ne
 * declenche plus aucune requete.
 */
const AGENDA_TTL = 30 * 60 * 1000;

/**
 * Cle d'un agenda hebdomadaire.
 *
 * Depend de la semaine ET de l'etat de la bibliotheque : `updatedAt` change des
 * qu'un episode est marque vu ou qu'un override est modifie, ce qui invalide
 * naturellement le cache sans avoir a y penser. Les filtres d'affichage n'y
 * figurent pas : ils sont appliques APRES le cache, pour qu'un changement de
 * filtre reste instantane et gratuit.
 */
function agendaKey(items: TrackedItem[], range: { from: number; to: number }): string {
  const state = items
    .map((i) => `${i.id}@${i.updatedAt}`)
    .sort()
    .join('|');
  return `agenda:${range.from}:${fingerprint(state)}`;
}

/** Applique les filtres d'affichage. Volontairement hors du cache. */
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
 * Construit l'agenda de la semaine.
 *
 * Chaque provider est interroge independamment et une panne n'en fait tomber
 * qu'un : on prefere un agenda partiel a un ecran d'erreur.
 */
export async function buildAgenda(
  items: TrackedItem[],
  range: { from: number; to: number },
  settings: AppSettings
): Promise<AgendaResult> {
  const active = items.filter((i) => !i.overrides?.hidden && i.status !== 'dropped');
  const warnings: string[] = [];

  // --- Cache d'agenda : la copie locale qui menage les APIs ---
  // Revenir sur une semaine deja consultee, ou changer de filtre, ne declenche
  // plus aucun appel externe. Sans ca, chaque affichage refaisait le tour des
  // quatre providers : environ 2 requetes TVmaze par serie suivie, 7 pour le
  // calendrier ADN, plus AniList.
  const key = agendaKey(active, range);
  const cached = await cacheGet<AiringEntry[]>(key);
  if (cached) {
    return { entries: applyFilters(cached, settings), warnings: [], usedCache: true };
  }

  const anilistIds = active
    .map((i) => i.links?.anilistId ?? (i.provider === 'anilist' ? Number(i.externalId) : null))
    .filter((n): n is number => Number.isFinite(n as number));

  const itemsByAnilistId = new Map<number, TrackedItem>();
  for (const item of active) {
    const id = item.links?.anilistId ?? (item.provider === 'anilist' ? Number(item.externalId) : null);
    if (Number.isFinite(id as number)) itemsByAnilistId.set(id as number, item);
  }

  const tasks: Promise<AiringEntry[]>[] = [];

  // --- AniList : planning anime ---
  tasks.push(
    anilistIds.length
      ? anilist
          .fetchAiringForIds(anilistIds, range)
          .then((s) => anilist.scheduleToEntries(s, itemsByAnilistId))
          .catch((e) => {
            warnings.push(`AniList indisponible : ${e.message}`);
            return [];
          })
      : Promise.resolve([])
  );

  // --- ADN : dates FR reelles. Meme condition d'eligibilite que
  //     videosToEntries, pour ne pas telecharger un calendrier inutilisable. ---
  const wantsAdn = active.some(
    (i) =>
      i.links?.adnShowId != null ||
      i.provider === 'adn' ||
      (i.kind === 'anime' && i.subtype !== 'live')
  );
  tasks.push(
    wantsAdn
      ? adn
          .fetchDays(datesInRange(range.from, range.to))
          .then((videos) => adn.videosToEntries(videos, active))
          .catch((e) => {
            warnings.push(`ADN indisponible : ${e.message}`);
            return [];
          })
      : Promise.resolve([])
  );

  // --- TVmaze : series et animation, sans cle. Source par defaut. ---
  const tvmazeItems = active.filter((i) => i.provider === 'tvmaze' || i.links?.tvmazeId);
  if (tvmazeItems.length) {
    tasks.push(
      tvmaze.fetchEntries(tvmazeItems, range).catch((e) => {
        warnings.push(`TVmaze indisponible : ${e.message}`);
        return [];
      })
    );
  }

  // --- TMDB : optionnel, mais seul a donner la disponibilite FR par plateforme ---
  const tmdbItems = active.filter((i) => i.provider === 'tmdb' || i.links?.tmdbId);
  if (tmdbItems.length) {
    if (tmdb.hasTmdbKey(settings.tmdbApiKey)) {
      tasks.push(
        tmdb.fetchEntries(tmdbItems, range, settings.tmdbApiKey).catch((e) => {
          warnings.push(`TMDB indisponible : ${e.message}`);
          return [];
        })
      );
    } else {
      warnings.push(
        `${tmdbItems.length} fiche(s) TMDB sans cle : leurs dates sont ignorees. Ajoute une cle, ou reajoute-les via TVmaze.`
      );
    }
  }

  // --- Saisie manuelle ---
  tasks.push(Promise.resolve(manualEntries(active, range)));

  const groups = await Promise.all(tasks);
  const entries = mergeEntries(groups);

  // Un agenda vide alors que TOUTES les sources ont echoue n'est pas un resultat :
  // le mettre en cache figerait la panne pendant 30 minutes. On tente alors la
  // derniere version connue, meme perimee.
  const everythingFailed = warnings.length > 0 && entries.length === 0;
  if (everythingFailed) {
    const stale = await cacheGetStale<AiringEntry[]>(key);
    if (stale?.length) {
      return {
        entries: applyFilters(stale, settings),
        warnings: [...warnings, 'Affichage des dernières données enregistrées.'],
        usedCache: true,
      };
    }
  } else {
    await cacheSet(key, entries, AGENDA_TTL);
  }

  return { entries: applyFilters(entries, settings), warnings, usedCache: false };
}

/**
 * Recherche de series robuste aux titres francais, sans aucune cle.
 *
 * TVmaze trouve deja beaucoup de titres FR seul, parce qu'il indexe les titres
 * alternatifs par pays (24 sur 30 sur un export Netflix reel). Pour le reste on
 * traduit le titre puis on relance.
 *
 * Point important : quand la traduction a servi, on enregistre le titre
 * francais comme alias du meilleur resultat. Sans ca, le filtre par titre en
 * aval rejetterait "Wednesday" pour une recherche "Mercredi" — la traduction
 * est precisement la preuve du lien.
 */
export async function searchSeriesResilient(frTitle: string): Promise<SearchResult[]> {
  const direct = await tvmaze.searchSeries(frTitle).catch(() => [] as SearchResult[]);
  if (direct.length) return direct;

  for (const english of await titles.translateToEnglish(frTitle)) {
    const viaTranslation = await tvmaze.searchSeries(english).catch(() => [] as SearchResult[]);
    if (!viaTranslation.length) continue;

    return viaTranslation.map((r, i) =>
      // Seul le meilleur resultat herite de l'alias : les suivants restent
      // soumis au rapprochement normal.
      i === 0 ? { ...r, altTitles: [...(r.altTitles ?? []), frTitle] } : r
    );
  }
  return [];
}

export { adn, anilist, titles, tmdb, tvmaze };

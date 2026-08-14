'use client';

import { getAllItems, getItem, putItem } from './db';
import { tidyPlatforms } from './platforms';
import { adn, tmdb, tvmaze } from './providers';
import type { PlatformId, SearchResult, TrackedItem } from './types';

/** uid local stable, independant du provider. */
export function makeId(provider: string, externalId: string): string {
  return `${provider}:${externalId}`;
}

export function itemIdOf(result: SearchResult): string {
  return makeId(result.provider, result.externalId);
}

/**
 * Ajoute une serie a la bibliotheque.
 *
 * L'enrichissement (plateformes FR via TMDB, lien ADN) se fait ici, une seule
 * fois, et le resultat est memorise dans `links`. Un echec d'enrichissement
 * n'empeche jamais l'ajout : la serie est ajoutee, elle sera juste moins
 * precise jusqu'a la prochaine synchro.
 */
export async function addFromSearch(
  result: SearchResult,
  opts: {
    tmdbApiKey?: string | null;
    /** Plateforme d'origine connue (import depuis un export Netflix, etc.). */
    platformHint?: PlatformId | null;
    /** Progression initiale, quand l'import a pu la deduire. */
    progress?: number;
  } = {}
): Promise<TrackedItem> {
  const id = itemIdOf(result);
  const existing = await getItem(id);
  if (existing) return existing;

  const now = Date.now();
  const progress = Math.max(0, Math.round(opts.progress ?? 0));
  const platforms = tidyPlatforms([
    ...(result.platforms ?? []),
    ...(opts.platformHint ? [opts.platformHint] : []),
  ]);

  const item: TrackedItem = {
    id,
    kind: result.kind,
    subtype: result.subtype ?? null,
    provider: result.provider,
    externalId: result.externalId,
    title: result.title,
    originalTitle: result.originalTitle ?? null,
    coverUrl: result.coverUrl ?? null,
    platforms,
    totalEpisodes: result.totalEpisodes ?? null,
    links: {
      anilistId: result.provider === 'anilist' ? Number(result.externalId) : null,
      tmdbId: result.provider === 'tmdb' ? Number(result.externalId) : null,
      tvmazeId: result.provider === 'tvmaze' ? Number(result.externalId) : null,
      adnShowId: result.provider === 'adn' ? Number(result.externalId) : null,
    },
    status: 'watching',
    progress,
    watchedEpisodes: Array.from({ length: progress }, (_, i) => i + 1),
    addedAt: now,
    updatedAt: now,
  };

  await putItem(item);
  // Enrichissement en arriere-plan : l'UI n'attend pas.
  void enrichItem(item, opts.tmdbApiKey ?? null);
  return item;
}

/** Complete une fiche avec ce que les autres providers savent. */
export async function enrichItem(
  item: TrackedItem,
  tmdbApiKey: string | null
): Promise<TrackedItem | null> {
  const links = { ...(item.links ?? {}) };
  let platforms = [...(item.platforms ?? [])];
  let totalEpisodes = item.totalEpisodes ?? null;
  let subtype = item.subtype ?? null;
  let changed = false;

  // Lien ADN : donne acces aux vraies dates FR pour les animes.
  if (item.kind === 'anime' && links.adnShowId == null) {
    const adnId = await adn.resolveAdnShowId({
      title: item.title,
      originalTitle: item.originalTitle,
    });
    if (adnId) {
      links.adnShowId = adnId;
      platforms.push('adn');
      changed = true;
    }
  }

  // Plateforme d'origine et nombre d'episodes via TVmaze (aucune cle requise).
  if (item.provider === 'tvmaze' && item.externalId) {
    const info = await tvmaze.enrich(Number(item.externalId));
    if (info) {
      if (info.platforms.length) platforms.push(...info.platforms);
      if (info.totalEpisodes) totalEpisodes = info.totalEpisodes;
      // Rattrape les fiches ajoutees avant l'existence de `subtype`, ce qui rend
      // « Reenrichir les fiches » suffisant pour corriger l'ancien contenu.
      if (!subtype) subtype = info.subtype;
      changed = true;
    }
  }

  // Plateformes FR via TMDB : plus precis que TVmaze, mais demande une cle.
  if (item.provider === 'tmdb' && tmdb.hasTmdbKey(tmdbApiKey)) {
    const info = await tmdb.enrich(Number(item.externalId), tmdbApiKey);
    if (info) {
      if (info.platforms.length) platforms.push(...info.platforms);
      if (info.totalEpisodes) totalEpisodes = info.totalEpisodes;
      changed = true;
    }
  }

  if (!changed) return null;

  const next: TrackedItem = {
    ...item,
    links,
    platforms: tidyPlatforms(platforms),
    totalEpisodes,
    subtype,
    syncedAt: Date.now(),
  };
  await putItem(next);
  return next;
}

/** Relance l'enrichissement sur toute la bibliotheque (bouton Reglages). */
export async function resyncAll(
  tmdbApiKey: string | null,
  onProgress?: (done: number, total: number) => void
): Promise<number> {
  const items = await getAllItems();
  let updated = 0;
  for (let i = 0; i < items.length; i++) {
    const res = await enrichItem(items[i], tmdbApiKey);
    if (res) updated++;
    onProgress?.(i + 1, items.length);
  }
  return updated;
}

/** Cree une fiche entierement manuelle (aucun provider ne la couvre). */
export async function addManual(input: {
  title: string;
  kind: 'anime' | 'series';
  weekday: number | null;
  time: string | null;
  platforms: TrackedItem['platforms'];
  totalEpisodes?: number | null;
}): Promise<TrackedItem> {
  const now = Date.now();
  // Suffixe temporel : deux series manuelles de meme titre restent distinctes.
  const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const item: TrackedItem = {
    id: makeId('manual', `${slug || 'serie'}-${now.toString(36)}`),
    kind: input.kind,
    provider: 'manual',
    externalId: null,
    title: input.title,
    originalTitle: null,
    coverUrl: null,
    platforms: tidyPlatforms(input.platforms),
    totalEpisodes: input.totalEpisodes ?? null,
    links: {},
    status: 'watching',
    progress: 0,
    watchedEpisodes: [],
    overrides: {
      weekday: input.weekday,
      time: input.time,
    },
    addedAt: now,
    updatedAt: now,
  };
  await putItem(item);
  return item;
}

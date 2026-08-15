'use client';

import { getAllItems, getItem, putItem } from './db';
import { tidyPlatforms } from './platforms';
import { addToAccount, removeFromAccount } from './providers';
import type { BetaSeriesSession } from './betaseries/session';
import type { PlatformId, SearchResult, TrackedItem } from './types';

/**
 * Gestion de la bibliotheque.
 *
 * Changement de fond : les series suivies vivent desormais SUR LE COMPTE
 * BetaSeries, pas en local. Ajouter ou retirer une serie ecrit chez eux, ce qui
 * garde l'app et le site synchronises et supprime toute notion d'enrichissement
 * inter-providers.
 *
 * Seules les fiches purement manuelles restent locales : elles n'existent chez
 * aucun fournisseur, donc rien ne pourrait les heberger ailleurs.
 */

export function makeId(provider: string, externalId: string): string {
  return `${provider}:${externalId}`;
}

export function itemIdOf(result: SearchResult): string {
  return makeId(result.provider, result.externalId);
}

/** Ajoute au compte BetaSeries. */
export async function addFromSearch(
  session: BetaSeriesSession,
  result: SearchResult
): Promise<void> {
  await addToAccount(session, result);
}

/** Retire du compte BetaSeries, ou supprime la fiche locale si elle est manuelle. */
export async function removeItem(session: BetaSeriesSession, item: TrackedItem): Promise<void> {
  if (item.provider === 'manual') {
    const { deleteItem } = await import('./db');
    await deleteItem(item.id);
    return;
  }
  if (item.externalId) await removeFromAccount(session, item.externalId);
}

/**
 * Cree une fiche entierement locale.
 *
 * Utile pour ce que BetaSeries ne reference pas : le rapprochement de ta liste a
 * montre un seul cas sur 49, mais il existe.
 */
export async function addManual(input: {
  title: string;
  kind: 'anime' | 'series';
  weekday: number | null;
  time: string | null;
  platforms: PlatformId[];
  totalEpisodes?: number | null;
}): Promise<TrackedItem> {
  const now = Date.now();
  const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const item: TrackedItem = {
    id: makeId('manual', `${slug || 'serie'}-${now.toString(36)}`),
    kind: input.kind,
    subtype: null,
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
    overrides: { weekday: input.weekday, time: input.time },
    addedAt: now,
    updatedAt: now,
  };
  await putItem(item);
  return item;
}

/** Fiches locales uniquement : les series du compte ne sont pas dupliquees ici. */
export async function localItems(): Promise<TrackedItem[]> {
  return (await getAllItems()).filter((i) => i.provider === 'manual');
}

export { getItem };

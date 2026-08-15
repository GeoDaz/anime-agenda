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
  if (item.externalId) await removeFromAccount(session, item.externalId);
}


export { getItem };

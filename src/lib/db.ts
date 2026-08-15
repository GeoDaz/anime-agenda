'use client';

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AppSettings, LocalOverrides, TrackedItem, WatchStatus } from './types';

interface AgendaDB extends DBSchema {
  items: {
    key: string;
    value: TrackedItem;
    indexes: { 'by-status': string; 'by-kind': string };
  };
  settings: {
    key: string;
    value: unknown;
  };
  /** Cache des reponses provider, pour que l'agenda s'ouvre hors-ligne. */
  cache: {
    key: string;
    value: { key: string; payload: unknown; expiresAt: number };
  };
}

const DB_NAME = 'anime-agenda';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<AgendaDB>> | null = null;

function getDB() {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB indisponible (rendu serveur)');
  }
  if (!dbPromise) {
    dbPromise = openDB<AgendaDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('items')) {
          const store = db.createObjectStore('items', { keyPath: 'id' });
          store.createIndex('by-status', 'status');
          store.createIndex('by-kind', 'kind');
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings');
        }
        if (!db.objectStoreNames.contains('cache')) {
          db.createObjectStore('cache', { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

// --------------------------------------------------------------------------
// Bibliotheque
// --------------------------------------------------------------------------

export async function getAllItems(): Promise<TrackedItem[]> {
  const db = await getDB();
  return db.getAll('items');
}

export async function getItem(id: string): Promise<TrackedItem | undefined> {
  const db = await getDB();
  return db.get('items', id);
}

export async function putItem(item: TrackedItem): Promise<void> {
  const db = await getDB();
  await db.put('items', { ...item, updatedAt: Date.now() });
}

export async function deleteItem(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('items', id);
}

/** Applique une modification partielle en preservant l'etat utilisateur. */
export async function patchItem(
  id: string,
  patch: Partial<TrackedItem>
): Promise<TrackedItem | undefined> {
  const db = await getDB();
  const existing = await db.get('items', id);
  if (!existing) return undefined;
  const next: TrackedItem = { ...existing, ...patch, updatedAt: Date.now() };
  await db.put('items', next);
  return next;
}

export async function setOverrides(id: string, overrides: LocalOverrides): Promise<void> {
  const existing = await getItem(id);
  if (!existing) return;
  // On fusionne, et on nettoie les cles remises a undefined pour "revenir au provider".
  const merged: LocalOverrides = { ...existing.overrides, ...overrides };
  for (const k of Object.keys(merged) as (keyof LocalOverrides)[]) {
    if (merged[k] === undefined || merged[k] === null || merged[k] === '') delete merged[k];
  }
  await patchItem(id, { overrides: merged });
}

export async function setProgress(id: string, progress: number): Promise<void> {
  const item = await getItem(id);
  if (!item) return;
  const clamped = Math.max(0, Math.round(progress));
  const total = item.overrides?.totalEpisodes ?? item.totalEpisodes ?? null;
  const capped = total ? Math.min(clamped, total) : clamped;
  // Les episodes 1..capped sont consideres vus : c'est le cas lineaire courant.
  const watched = Array.from({ length: capped }, (_, i) => i + 1);
  const status: WatchStatus =
    total && capped >= total ? 'done' : capped > 0 ? 'watching' : item.status;
  await patchItem(id, { progress: capped, watchedEpisodes: watched, status });
}

/** Bascule un episode precis (rattrapage dans le desordre). */
export async function toggleEpisode(id: string, episode: number): Promise<void> {
  const item = await getItem(id);
  if (!item) return;
  const set = new Set(item.watchedEpisodes ?? []);
  if (set.has(episode)) set.delete(episode);
  else set.add(episode);
  const list = [...set].sort((a, b) => a - b);
  // `progress` reste le plus haut episode consecutif depuis 1.
  let streak = 0;
  while (set.has(streak + 1)) streak++;
  await patchItem(id, { watchedEpisodes: list, progress: streak });
}

export async function bulkPut(items: TrackedItem[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('items', 'readwrite');
  await Promise.all(items.map((i) => tx.store.put(i)));
  await tx.done;
}

// --------------------------------------------------------------------------
// Reglages
// --------------------------------------------------------------------------

export const DEFAULT_SETTINGS: AppSettings = {
  betaseriesApiKey: null,
  betaseriesToken: null,
  betaseriesLogin: null,
  betaseriesMemberId: null,
  tmdbApiKey: null,
  platformFilter: [],
  hideWatched: false,
  weekStartsOnMonday: true,
  showDiscovery: false,
};

export async function getSettings(): Promise<AppSettings> {
  const db = await getDB();
  const stored = (await db.get('settings', 'app')) as Partial<AppSettings> | undefined;
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const db = await getDB();
  const next = { ...(await getSettings()), ...patch };
  await db.put('settings', next, 'app');
  return next;
}

// --------------------------------------------------------------------------
// Cache reseau (mode hors-ligne)
// --------------------------------------------------------------------------

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const db = await getDB();
    const row = await db.get('cache', key);
    if (!row) return null;
    if (row.expiresAt < Date.now()) return null;
    return row.payload as T;
  } catch {
    return null;
  }
}

/** Version perimee acceptee : sert de filet quand le reseau est absent. */
export async function cacheGetStale<T>(key: string): Promise<T | null> {
  try {
    const db = await getDB();
    const row = await db.get('cache', key);
    return row ? (row.payload as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, payload: unknown, ttlMs: number): Promise<void> {
  try {
    const db = await getDB();
    await db.put('cache', { key, payload, expiresAt: Date.now() + ttlMs });
  } catch {
    // Quota plein ou navigation privee : le cache est un bonus, on ignore.
  }
}

export async function clearCache(): Promise<void> {
  const db = await getDB();
  await db.clear('cache');
}

// --------------------------------------------------------------------------
// Export / import (la sauvegarde, puisque tout est local)
// --------------------------------------------------------------------------

export interface Backup {
  version: 1;
  exportedAt: string;
  settings: AppSettings;
  items: TrackedItem[];
}

export async function exportBackup(): Promise<Backup> {
  const settings = await getSettings();
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    // Les secrets ne partent PAS dans un fichier telechargeable : une sauvegarde
    // se partage ou se depose n'importe ou, et un jeton de session vaut un acces
    // complet au compte. Ils se resaisissent a la reconnexion.
    settings: {
      ...settings,
      betaseriesApiKey: null,
      betaseriesToken: null,
      tmdbApiKey: null,
    },
    items: await getAllItems(),
  };
}

/** Entree du catalogue local : ce que demande le dump de developpement. */
export interface LocalCatalogEntry {
  kind: string;
  title: string;
  altTitles: string[];
  imageUrl: string | null;
  year: number | null;
  sources: string[];
}

/**
 * Reconstitue un catalogue local depuis tout ce que l'app a deja vu.
 *
 * Complement au script `npm run dump` : celui-ci interroge les APIs, celle-ci
 * recycle le cache accumule en naviguant, sans une seule requete reseau. Un PWA
 * ne pouvant pas ecrire dans le dossier du projet, le resultat part en
 * telechargement — c'est la seule voie possible cote navigateur.
 */
export async function buildLocalCatalog(): Promise<LocalCatalogEntry[]> {
  const db = await getDB();
  const byKey = new Map<string, LocalCatalogEntry>();

  const norm = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  const add = (
    kind: string,
    title: string,
    imageUrl: string | null,
    source: string,
    altTitles: string[] = [],
    year: number | null = null
  ) => {
    if (!title || title.length < 2) return;
    const key = `${kind}:${norm(title)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        kind,
        title,
        altTitles: [...new Set(altTitles.filter(Boolean))],
        imageUrl,
        year,
        sources: [source],
      });
      return;
    }
    // Une image deja connue n'est jamais remplacee par un null.
    if (!existing.imageUrl && imageUrl) existing.imageUrl = imageUrl;
    if (!existing.year && year) existing.year = year;
    existing.altTitles = [...new Set([...existing.altTitles, ...altTitles.filter(Boolean)])];
    if (!existing.sources.includes(source)) existing.sources.push(source);
  };

  // 1. La bibliotheque : la source la plus fiable, c'est ce que l'utilisateur suit.
  for (const item of await db.getAll('items')) {
    add(
      item.kind,
      item.overrides?.title ?? item.title,
      item.overrides?.coverUrl ?? item.coverUrl ?? null,
      item.provider,
      [item.originalTitle ?? ''].filter(Boolean) as string[]
    );
  }

  // 2. Le cache reseau : recherches et catalogues deja telecharges.
  for (const row of await db.getAll('cache')) {
    const payload = row.payload;
    if (!Array.isArray(payload)) continue;

    for (const raw of payload) {
      if (!raw || typeof raw !== 'object') continue;
      const o = raw as Record<string, unknown>;

      // Forme SearchResult.
      if (typeof o.title === 'string' && typeof o.provider === 'string') {
        add(
          typeof o.kind === 'string' ? o.kind : 'inconnu',
          o.title,
          typeof o.coverUrl === 'string' ? o.coverUrl : null,
          o.provider,
          Array.isArray(o.altTitles) ? (o.altTitles as string[]) : [],
          typeof o.year === 'number' ? o.year : null
        );
        continue;
      }

      // Forme catalogue ADN : `title` + `image2x`, sans champ provider.
      if (typeof o.title === 'string' && (typeof o.image2x === 'string' || typeof o.image === 'string')) {
        add(
          o.type === 'MOV' ? 'film' : 'anime',
          o.title,
          (o.image2x as string) ?? (o.image as string) ?? null,
          'adn',
          [o.originalTitle as string, o.shortTitle as string].filter(
            (t): t is string => typeof t === 'string'
          )
        );
      }
    }
  }

  return [...byKey.values()].sort((a, b) => a.title.localeCompare(b.title, 'fr'));
}

export async function importBackup(
  backup: Backup,
  mode: 'merge' | 'replace' = 'merge'
): Promise<{ imported: number; skipped: number }> {
  const db = await getDB();
  if (mode === 'replace') await db.clear('items');

  const existing = new Set((await getAllItems()).map((i) => i.id));
  let imported = 0;
  let skipped = 0;

  const tx = db.transaction('items', 'readwrite');
  for (const item of backup.items ?? []) {
    if (mode === 'merge' && existing.has(item.id)) {
      skipped++;
      continue;
    }
    await tx.store.put(item);
    imported++;
  }
  await tx.done;

  if (backup.settings) {
    // On ne reimporte pas la cle TMDB si l'appareil en a deja une.
    const current = await getSettings();
    await saveSettings({
      ...backup.settings,
      tmdbApiKey: current.tmdbApiKey ?? backup.settings.tmdbApiKey,
    });
  }
  return { imported, skipped };
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, getAllItems, getSettings, saveSettings } from './db';
import {
  EMPTY_SESSION,
  isConnected,
  loadSession,
  type BetaSeriesSession,
} from './betaseries/session';
import { fetchLibrary } from './providers';
import type { AppSettings, TrackedItem } from './types';

/**
 * Etat partage minimal, sans librairie de state management.
 *
 * IndexedDB est la source de verite ; ces hooks ne font que la refleter. Un
 * simple bus d'evenements notifie tous les composants montes apres une
 * ecriture, ce qui evite d'avoir a faire remonter des callbacks partout.
 */

const CHANNEL = 'agenda:store-changed';

/** A appeler apres toute ecriture en base pour rafraichir l'UI. */
export function notifyStoreChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHANNEL));
  }
}

function useStoreSubscription(reload: () => void) {
  useEffect(() => {
    const handler = () => reload();
    window.addEventListener(CHANNEL, handler);
    // Une autre onglet/instance a pu ecrire pendant qu'on etait en arriere-plan.
    document.addEventListener('visibilitychange', handler);
    return () => {
      window.removeEventListener(CHANNEL, handler);
      document.removeEventListener('visibilitychange', handler);
    };
  }, [reload]);
}

/**
 * Session BetaSeries, derivee des reglages.
 * Un seul endroit lit ces champs : tout le reste passe par ce hook.
 */
export function useSession() {
  const [session, setSession] = useState<BetaSeriesSession>(EMPTY_SESSION);
  const [ready, setReady] = useState(false);

  const reload = useCallback(() => {
    loadSession()
      .then((s) => {
        setSession(s);
        setReady(true);
      })
      .catch(() => setReady(true));
  }, []);

  useEffect(reload, [reload]);
  useStoreSubscription(reload);

  return { session, ready, connected: isConnected(session), reload };
}

/**
 * Liste des series suivies.
 *
 * Elle vient desormais du COMPTE BetaSeries et non d'IndexedDB : c'est lui qui
 * fait autorite, et c'est ce qui permet de retrouver la meme liste sur le site
 * comme dans l'app. Les fiches purement manuelles restent locales et sont
 * fusionnees ici.
 */
export function useItems() {
  const { session, ready: sessionReady, connected } = useSession();
  const [items, setItems] = useState<TrackedItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!sessionReady) return;
    if (!connected) {
      // Hors connexion au compte, seules les fiches manuelles sont affichables.
      getAllItems()
        .then((rows) => setItems(rows.filter((i) => i.provider === 'manual')))
        .catch((e) => setError(e.message));
      return;
    }
    Promise.all([fetchLibrary(session), getAllItems()])
      .then(([remote, local]) => {
        const manual = local.filter((i) => i.provider === 'manual');
        setItems([...remote, ...manual]);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [session, sessionReady, connected]);

  useEffect(reload, [reload]);
  useStoreSubscription(reload);

  return { items, loading: items === null, error, reload };
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);

  const reload = useCallback(() => {
    getSettings()
      .then((s) => {
        setSettings(s);
        setReady(true);
      })
      .catch(() => setReady(true));
  }, []);

  useEffect(reload, [reload]);
  useStoreSubscription(reload);

  const update = useCallback(async (patch: Partial<AppSettings>) => {
    const next = await saveSettings(patch);
    setSettings(next);
    notifyStoreChanged();
    return next;
  }, []);

  return { settings, ready, update };
}

/** Detecte la perte de reseau pour afficher le bandeau hors-ligne. */
export function useOnline() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  return online;
}

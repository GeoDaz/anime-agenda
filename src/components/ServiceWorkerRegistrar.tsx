'use client';

import { useEffect } from 'react';

/**
 * Enregistre le service worker.
 *
 * Ecrit a la main plutot que via next-pwa : une trentaine de lignes de cache
 * suffisent ici, et ca evite une dependance qui casse a chaque version majeure
 * de Next.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    // Inutile en dev : le SW mettrait en cache des bundles qui changent sans cesse.
    if (process.env.NODE_ENV !== 'production') return;

    const onLoad = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Refus d'enregistrement (navigation privee, http) : l'app marche sans.
      });
    };

    if (document.readyState === 'complete') onLoad();
    else window.addEventListener('load', onLoad);
    return () => window.removeEventListener('load', onLoad);
  }, []);

  return null;
}

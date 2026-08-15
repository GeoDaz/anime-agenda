'use client';

import { useEffect, useRef, useState } from 'react';
import { BetaSeriesLogin } from './BetaSeriesLogin';
import { useSession } from '@/lib/useStore';

/**
 * Etat de connexion et acces au formulaire, depuis n'importe quelle page.
 *
 * Tout depend desormais du compte BetaSeries : la liste, le planning, la
 * progression. Enfouir la connexion dans une seule page laissait l'utilisateur
 * devant un agenda vide sans action evidente. Le bouton vit donc dans l'en-tete,
 * et ouvre le formulaire sur place plutot que de forcer une navigation.
 */
export function AccountButton() {
  const { session, connected, ready } = useSession();
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement;
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
      (restoreFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);

  // Tant que la session n'est pas lue, on n'affiche rien : annoncer
  // « Se connecter » puis basculer aussitot serait un clignotement inutile.
  if (!ready) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="tap flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold"
        style={{
          borderColor: connected ? 'var(--border)' : 'var(--accent)',
          background: connected ? 'transparent' : 'color-mix(in srgb, var(--accent) 14%, transparent)',
          color: connected ? 'var(--text-muted)' : 'var(--accent)',
        }}
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: connected ? '#16a34a' : 'var(--accent)' }}
        />
        {connected ? (session.login ?? 'Connecté') : 'Se connecter'}
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Compte BetaSeries"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center"
          style={{ background: 'rgba(0,0,0,0.6)' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="pb-safe w-full max-w-md rounded-t-2xl border p-4 sm:rounded-2xl"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-base font-bold">Compte BetaSeries</h2>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Fermer"
                className="tap flex h-8 w-8 items-center justify-center rounded-full"
                style={{ background: 'var(--surface-2)' }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M6 6l12 12M18 6L6 18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>

            <BetaSeriesLogin onConnected={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}

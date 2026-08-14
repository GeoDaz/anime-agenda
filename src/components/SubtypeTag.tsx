'use client';

import type { MediaSubtype } from '@/lib/types';

/**
 * Etiquette « Live action », accolee au titre pour lever les homonymies.
 *
 * Cas concret : "One Piece" designe l'anime de 1999 ET la serie Netflix de 2023,
 * au titre rigoureusement identique. Aucun affichage de date ou de plateforme ne
 * suffit a lever le doute d'un coup d'oeil dans l'agenda.
 *
 * Rien n'est affiche pour l'animation : ce serait du bruit sur la majorite des
 * fiches, et l'etiquette perdrait sa valeur de signal. Rien n'est affiche non
 * plus quand `subtype` est inconnu — les fiches ajoutees avant ce champ. Mieux
 * vaut une absence d'etiquette qu'une etiquette devinee : appeler « Live action »
 * une animation occidentale comme Arcane serait faux.
 */
export function SubtypeTag({ subtype }: { subtype?: MediaSubtype | null }) {
  if (subtype !== 'live') return null;
  return (
    <span
      className="inline-flex shrink-0 items-center rounded px-1 py-px align-middle text-[9px] font-bold uppercase tracking-wide ring-1 ring-inset"
      style={{
        background: 'color-mix(in srgb, var(--text) 8%, transparent)',
        color: 'var(--text-muted)',
        // @ts-expect-error -- propriete CSS personnalisee acceptee par React
        '--tw-ring-color': 'var(--border)',
      }}
      title="Série live action, à ne pas confondre avec l’anime du même nom"
    >
      Live action
    </span>
  );
}

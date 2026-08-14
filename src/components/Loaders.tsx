'use client';

/** Petit indicateur d'activite, utilise dans les en-tetes et les boutons. */
export function Spinner({ size = 14, label }: { size?: number; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className="spin shrink-0"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="42"
        strokeDashoffset="14"
        opacity="0.85"
      />
    </svg>
  );
}

/**
 * Barre de progression determinee.
 * `aria-live` volontairement absent : la valeur change des dizaines de fois et
 * saturerait un lecteur d'ecran. Le total est annonce dans le texte a cote.
 */
export function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-label="Progression de la recherche"
      className="h-1 w-full overflow-hidden rounded-full"
      style={{ background: 'var(--surface-2)' }}
    >
      <div
        className="h-full rounded-full transition-[width] duration-300 ease-out"
        style={{ width: `${pct}%`, background: 'var(--accent)' }}
      />
    </div>
  );
}

/** Bloc gris scintillant, aux dimensions d'un contenu a venir. */
export function Skeleton({
  className = '',
  width,
  height,
}: {
  className?: string;
  width?: string | number;
  height?: string | number;
}) {
  return (
    <span
      aria-hidden="true"
      className={`skeleton block ${className}`}
      style={{ width, height }}
    />
  );
}

/**
 * Silhouette d'une proposition de correspondance : jaquette, deux lignes de
 * texte, un bouton. Reprend les dimensions reelles pour eviter que la liste ne
 * saute quand le vrai contenu arrive.
 */
export function MatchSkeleton() {
  return (
    <div className="mt-2 flex items-center gap-2">
      <Skeleton width={40} height={56} className="shrink-0 rounded" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton width="70%" height={9} />
        <Skeleton width="40%" height={8} />
        <Skeleton width={54} height={12} className="rounded-full" />
      </div>
      <Skeleton width={58} height={26} className="shrink-0 rounded-lg" />
    </div>
  );
}

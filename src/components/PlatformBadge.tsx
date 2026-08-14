'use client';

import { PLATFORMS, platformLabel } from '@/lib/platforms';
import type { PlatformId } from '@/lib/types';

export function PlatformBadge({ id }: { id: PlatformId }) {
  const meta = PLATFORMS[id] ?? PLATFORMS.other;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${meta.badgeClass}`}
    >
      {platformLabel(id)}
    </span>
  );
}

export function PlatformBadges({ ids, max = 3 }: { ids: PlatformId[]; max?: number }) {
  if (!ids.length) return null;
  const shown = ids.slice(0, max);
  const rest = ids.length - shown.length;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {shown.map((id) => (
        <PlatformBadge key={id} id={id} />
      ))}
      {rest > 0 && (
        <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
          +{rest}
        </span>
      )}
    </span>
  );
}

/** Puce de filtre, utilisee dans l'agenda et les reglages. */
export function PlatformChip({
  id,
  selected,
  onToggle,
}: {
  id: PlatformId;
  selected: boolean;
  onToggle: () => void;
}) {
  const meta = PLATFORMS[id] ?? PLATFORMS.other;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      className="tap shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition-all"
      style={{
        borderColor: selected ? meta.color : 'var(--border)',
        background: selected ? `color-mix(in srgb, ${meta.color} 18%, transparent)` : 'var(--surface)',
        color: selected ? meta.color : 'var(--text-muted)',
      }}
    >
      {platformLabel(id)}
    </button>
  );
}

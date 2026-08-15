'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/AppShell';
import { EntryCard } from '@/components/EntryCard';
import { PlatformChip } from '@/components/PlatformBadge';
import { toggleEpisode } from '@/lib/db';
import { TRACKED_PLATFORMS } from '@/lib/platforms';
import { buildAgenda } from '@/lib/providers';
import type { AiringEntry, PlatformId } from '@/lib/types';
import { notifyStoreChanged, useItems, useSession, useSettings } from '@/lib/useStore';
import { buildWeek, groupByDay } from '@/lib/week';

export default function AgendaPage() {
  const { items, loading: itemsLoading } = useItems();
  const { settings, ready: settingsReady, update } = useSettings();
  const { session, ready: sessionReady, connected } = useSession();

  const [offset, setOffset] = useState(0);
  const [entries, setEntries] = useState<AiringEntry[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);

  // `now` fige a la premiere frame : evite un decalage de semaine si l'app
  // reste ouverte a cheval sur minuit pendant un rendu.
  const [now] = useState(() => new Date());

  const week = useMemo(
    () => buildWeek(now, offset, settings.weekStartsOnMonday),
    [now, offset, settings.weekStartsOnMonday]
  );

  const load = useCallback(async () => {
    if (!sessionReady || !settingsReady) return;
    setFetching(true);
    try {
      // Le planning vient du compte BetaSeries : la liste locale n'entre plus
      // dans le calcul, c'est le compte qui fait autorite.
      const result = await buildAgenda(
        session,
        { from: week.from, to: week.to },
        settings,
        // Le planning ne porte ni jaquette ni plateforme : la bibliotheque les fournit.
        items ?? []
      );
      setEntries(result.entries);
      setWarnings(result.warnings);
    } catch (e) {
      setWarnings([e instanceof Error ? e.message : 'Erreur inconnue']);
      setEntries([]);
    } finally {
      setFetching(false);
    }
  }, [session, sessionReady, settingsReady, settings, week.from, week.to, items]);

  useEffect(() => {
    void load();
  }, [load]);

  const onToggleWatched = async (entry: AiringEntry) => {
    if (entry.episode === null) return;
    // Optimiste : le pouce ne doit pas attendre IndexedDB.
    setEntries((prev) =>
      prev.map((e) => (e.key === entry.key ? { ...e, watched: !e.watched } : e))
    );
    await toggleEpisode(entry.itemId, entry.episode);
    notifyStoreChanged();
  };

  const togglePlatform = (id: PlatformId) => {
    const current = new Set(settings.platformFilter);
    if (current.has(id)) current.delete(id);
    else current.add(id);
    void update({ platformFilter: [...current] });
  };

  const grouped = useMemo(() => groupByDay(entries, week.days), [entries, week.days]);
  const total = entries.length;

  return (
    <>
      <PageHeader
        title="Cette semaine"
        subtitle={week.label}
        action={
          <div className="flex shrink-0 items-center gap-1 pt-1">
            <ArrowButton label="Semaine précédente" onClick={() => setOffset((o) => o - 1)}>
              ‹
            </ArrowButton>
            {offset !== 0 && (
              <button
                type="button"
                onClick={() => setOffset(0)}
                className="tap rounded-lg px-2 py-1.5 text-xs font-semibold"
                style={{ background: 'var(--surface-2)' }}
              >
                Auj.
              </button>
            )}
            <ArrowButton label="Semaine suivante" onClick={() => setOffset((o) => o + 1)}>
              ›
            </ArrowButton>
          </div>
        }
      />

      {/* Filtres plateformes */}
      <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 pb-3">
        {TRACKED_PLATFORMS.map((id) => (
          <PlatformChip
            key={id}
            id={id}
            selected={settings.platformFilter.includes(id)}
            onToggle={() => togglePlatform(id)}
          />
        ))}
        {settings.platformFilter.length > 0 && (
          <button
            type="button"
            onClick={() => void update({ platformFilter: [] })}
            className="tap shrink-0 px-2 text-xs font-medium underline"
            style={{ color: 'var(--text-muted)' }}
          >
            Tout
          </button>
        )}
      </div>

      {warnings.length > 0 && (
        <div className="mx-4 mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          {warnings.map((w) => (
            <p key={w} className="text-xs text-amber-700 dark:text-amber-300">
              {w}
            </p>
          ))}
        </div>
      )}

      {itemsLoading && <Skeleton />}

      {!itemsLoading && items && items.length === 0 && (
        <EmptyLibrary />
      )}

      {!itemsLoading && items && items.length > 0 && (
        <>
          {fetching && total === 0 && <Skeleton />}

          {!fetching && total === 0 && (
            <p
              className="mx-4 rounded-xl border border-dashed px-4 py-8 text-center text-sm"
              style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
            >
              Aucune sortie cette semaine pour tes séries
              {settings.platformFilter.length > 0 ? ' sur les plateformes filtrées' : ''}.
            </p>
          )}

          <div className="space-y-5 px-4">
            {grouped.map(({ day, entries: dayEntries }) => {
              if (!dayEntries.length) return null;
              return (
                <section key={day.label}>
                  <h2
                    className="sticky top-0 z-10 mb-2 -mx-4 px-4 py-1.5 text-xs font-bold uppercase tracking-wider backdrop-blur-sm"
                    style={{
                      color: day.isToday ? 'var(--accent)' : 'var(--text-muted)',
                      background: 'color-mix(in srgb, var(--bg) 85%, transparent)',
                    }}
                  >
                    {day.label}
                    {day.isToday && ' · aujourd’hui'}
                  </h2>
                  <ul className="space-y-2">
                    {dayEntries.map((entry) => (
                      <EntryCard key={entry.key} entry={entry} onToggleWatched={onToggleWatched} />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

function ArrowButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="tap flex h-9 w-9 items-center justify-center rounded-lg text-lg font-bold"
      style={{ background: 'var(--surface-2)' }}
    >
      {children}
    </button>
  );
}

function Skeleton() {
  return (
    <ul className="space-y-2 px-4" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <li
          key={i}
          className="h-[76px] animate-pulse rounded-xl"
          style={{ background: 'var(--surface-2)' }}
        />
      ))}
    </ul>
  );
}

function EmptyLibrary() {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-base font-semibold">Ta liste est vide</p>
      <p className="mx-auto mt-1 max-w-xs text-sm" style={{ color: 'var(--text-muted)' }}>
        Ajoute les animes et séries que tu suis, l’agenda se remplit tout seul avec leurs dates de
        sortie.
      </p>
      <Link
        href="/bibliotheque/"
        className="tap mt-5 inline-flex rounded-xl px-5 py-2.5 text-sm font-semibold text-white"
        style={{ background: 'var(--accent)' }}
      >
        Ajouter une série
      </Link>
    </div>
  );
}

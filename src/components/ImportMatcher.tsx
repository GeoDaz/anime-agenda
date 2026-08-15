'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { addToAccount, searchAll } from '@/lib/providers';
import type { ImportCandidate } from '@/lib/importers';
import type { PlatformId, SearchResult } from '@/lib/types';
import { notifyStoreChanged, useSession } from '@/lib/useStore';
import { platformLabel } from '@/lib/platforms';
import { PlatformBadges } from './PlatformBadge';
import { MatchSkeleton, ProgressBar, Spinner } from './Loaders';

interface Row {
  candidate: ImportCandidate;
  matches: SearchResult[];
  chosen: number;
  state: 'pending' | 'searching' | 'ready' | 'none' | 'failed' | 'added';
  error?: string;
}

/**
 * Rapprochement d'une liste importee, via BetaSeries.
 *
 * Enormement simplifie par rapport a la version multi-providers : plus de lots
 * AniList pour tenir un quota de 30 requetes/minute, plus de traduction
 * Wikidata/Wikipedia, plus de filtre par similarite de titre.
 *
 * Ce dernier point vient d'une mesure : re-verifier les titres apres coup
 * rejetait 19 entrees sur 49 que BetaSeries avait pourtant correctement
 * rapprochees, parce qu'il gere le multilingue en interne. On lui fait donc
 * confiance et on laisse l'utilisateur arbitrer les cas douteux.
 *
 * Valider ecrit SUR LE COMPTE BetaSeries.
 */
export function ImportMatcher({
  candidates,
  sourcePlatform,
  onClose,
}: {
  candidates: ImportCandidate[];
  sourcePlatform: PlatformId | null;
  onClose: (added: number) => void;
}) {
  const { session, connected } = useSession();

  const LIMIT = 60;
  const truncated = Math.max(0, candidates.length - LIMIT);

  const [rows, setRows] = useState<Row[]>(() =>
    candidates.slice(0, LIMIT).map((candidate) => ({
      candidate,
      matches: [],
      chosen: 0,
      state: 'pending' as const,
    }))
  );
  const [addedCount, setAddedCount] = useState(0);
  const [scanning, setScanning] = useState(true);
  const [busyRows, setBusyRows] = useState<Set<number>>(new Set());
  const [bulkTotal, setBulkTotal] = useState(0);
  const [bulkDone, setBulkDone] = useState(0);

  /**
   * Jeton d'execution plutot qu'un booleen d'annulation : en mode strict, React
   * monte les effets deux fois, et un booleen partage se faisait « desannuler »
   * par le second passage — les deux boucles tournaient alors en parallele et
   * produisaient des doublons de cle.
   */
  const runId = useRef(0);

  const search = useCallback(
    async (title: string) => {
      const found = await searchAll(session, title);
      // Deduplication par identifiant : c'est cette liste qui alimente les cles
      // React, son unicite ne doit dependre d'aucune hypothese sur l'API.
      const seen = new Set<string>();
      return found.filter((r) => {
        if (seen.has(r.externalId)) return false;
        seen.add(r.externalId);
        return true;
      }).slice(0, 4);
    },
    [session]
  );

  useEffect(() => {
    if (!connected) return;
    const myRun = ++runId.current;
    const isStale = () => runId.current !== myRun;

    (async () => {
      for (let i = 0; i < rows.length; i++) {
        if (isStale()) return;
        setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, state: 'searching' } : r)));
        try {
          const matches = await search(rows[i].candidate.title);
          if (isStale()) return;
          setRows((prev) =>
            prev.map((r, idx) =>
              idx === i
                ? { ...r, matches, state: matches.length ? 'ready' : 'none' }
                : r
            )
          );
        } catch (e) {
          if (isStale()) return;
          setRows((prev) =>
            prev.map((r, idx) =>
              idx === i
                ? { ...r, state: 'failed', error: e instanceof Error ? e.message : 'échec' }
                : r
            )
          );
        }
        // Deux requetes par titre (series + films) : on espace raisonnablement.
        await new Promise((res) => setTimeout(res, 300));
      }
      if (!isStale()) setScanning(false);
    })();

    return () => {
      runId.current++;
    };
    // Volontairement sur le montage : `rows` est la liste figee a l'ouverture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, connected]);

  const addRow = async (index: number) => {
    const row = rows[index];
    const match = row.matches[row.chosen];
    if (!match) return;
    setBusyRows((prev) => new Set(prev).add(index));
    try {
      await addToAccount(session, match);
      setRows((prev) => prev.map((r, i) => (i === index ? { ...r, state: 'added' } : r)));
      setAddedCount((c) => c + 1);
    } catch (e) {
      setRows((prev) =>
        prev.map((r, i) =>
          i === index ? { ...r, state: 'failed', error: e instanceof Error ? e.message : 'échec' } : r
        )
      );
    } finally {
      setBusyRows((prev) => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }
  };

  const addAllReady = async () => {
    const targets = rows.map((r, i) => (r.state === 'ready' ? i : -1)).filter((i) => i >= 0);
    setBulkTotal(targets.length);
    setBulkDone(0);
    try {
      for (const i of targets) {
        await addRow(i);
        setBulkDone((d) => d + 1);
      }
    } finally {
      setBulkTotal(0);
      setBulkDone(0);
    }
  };

  const readyCount = rows.filter((r) => r.state === 'ready').length;
  const noneCount = rows.filter((r) => r.state === 'none').length;
  const doneCount = rows.filter((r) => r.state !== 'pending' && r.state !== 'searching').length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Rapprochement des titres importés"
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: 'var(--bg)' }}
    >
      <header
        className="pt-safe space-y-2 border-b px-4 pb-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-bold">
              Import
              {scanning && connected && (
                <span style={{ color: 'var(--accent)' }}>
                  <Spinner size={15} label="Recherche en cours" />
                </span>
              )}
            </h2>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {scanning ? `${doneCount}/${rows.length} · BetaSeries` : `${readyCount} à valider · ${addedCount} ajoutée(s)`}
              {sourcePlatform && ` · source ${platformLabel(sourcePlatform)}`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              runId.current++;
              onClose(addedCount);
            }}
            className="tap shrink-0 rounded-lg px-3 py-2 text-xs font-semibold"
            style={{ background: 'var(--surface-2)' }}
          >
            Terminer
          </button>
        </div>
        {scanning && connected && <ProgressBar done={doneCount} total={rows.length} />}
      </header>

      {!connected && (
        <p className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
          Connecte-toi à BetaSeries pour rapprocher et ajouter ces titres.
        </p>
      )}

      {truncated > 0 && (
        <p className="bg-amber-500/10 px-4 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          {candidates.length} titres détectés, seuls les {LIMIT} plus fréquents sont traités.
        </p>
      )}

      {!scanning && noneCount > 0 && (
        <p className="px-4 py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {noneCount} sans correspondance sur BetaSeries.
        </p>
      )}

      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {rows.map((row, index) => {
          const match = row.matches[row.chosen];
          return (
            <div
              key={`${row.candidate.title}-${index}`}
              className="rounded-xl border p-3"
              style={{
                background: 'var(--surface)',
                borderColor: 'var(--border)',
                opacity: row.state === 'added' ? 0.5 : 1,
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{row.candidate.title}</p>
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {row.candidate.count > 1 ? `${row.candidate.count} occurrences` : '1 occurrence'}
                    {row.candidate.season ? ` · saison ${row.candidate.season}` : ''}
                  </p>
                </div>
                {row.state === 'searching' && (
                  <span className="shrink-0" style={{ color: 'var(--accent)' }}>
                    <Spinner size={13} />
                  </span>
                )}
              </div>

              {(row.state === 'pending' || row.state === 'searching') && <MatchSkeleton />}

              {row.state === 'none' && (
                <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Aucune correspondance sur BetaSeries.
                </p>
              )}

              {row.state === 'failed' && (
                <p className="mt-2 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                  Échec — {row.error}
                </p>
              )}

              {match && row.state !== 'added' && (
                <>
                  <div className="mt-2 flex items-center gap-2">
                    {match.coverUrl && (
                      // eslint-disable-next-line @next/next/no-img-element -- images externes
                      <img
                        src={match.coverUrl}
                        alt=""
                        loading="lazy"
                        className="h-14 w-10 shrink-0 rounded object-cover"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{match.title}</p>
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {match.externalId.startsWith('m') ? 'Film' : 'Série'}
                        {match.year ? ` · ${match.year}` : ''}
                      </p>
                      <div className="mt-1">
                        <PlatformBadges ids={match.platforms} max={2} />
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={busyRows.has(index)}
                      onClick={() => void addRow(index)}
                      className="tap flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold disabled:opacity-60"
                      style={{ background: 'var(--accent)', color: '#fff' }}
                    >
                      {busyRows.has(index) && <Spinner size={11} />}
                      {busyRows.has(index) ? 'Ajout…' : 'Ajouter'}
                    </button>
                  </div>

                  {row.matches.length > 1 && (
                    <div className="mt-2 flex flex-col gap-1">
                      {row.matches.map((alt, i) => (
                        <button
                          key={alt.externalId}
                          type="button"
                          onClick={() =>
                            setRows((prev) =>
                              prev.map((r, idx) => (idx === index ? { ...r, chosen: i } : r))
                            )
                          }
                          className="tap flex items-center gap-1.5 truncate rounded border px-2 py-1 text-left text-[10px]"
                          style={{
                            borderColor: row.chosen === i ? 'var(--accent)' : 'var(--border)',
                            color: row.chosen === i ? 'var(--accent)' : 'var(--text-muted)',
                          }}
                        >
                          <span className="shrink-0 font-semibold">
                            {alt.externalId.startsWith('m') ? 'Film' : 'Série'}
                          </span>
                          {alt.year && <span className="shrink-0 opacity-70">{alt.year}</span>}
                          <span className="truncate">{alt.title}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}

              {row.state === 'added' && (
                <p className="mt-2 text-[11px] font-medium text-green-600 dark:text-green-400">
                  Ajouté sur ton compte BetaSeries
                </p>
              )}
            </div>
          );
        })}
      </div>

      {readyCount > 0 && (
        <footer
          className="pb-safe border-t px-4 pt-3"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
        >
          <button
            type="button"
            onClick={() => void addAllReady()}
            disabled={bulkTotal > 0}
            className="tap flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold text-white disabled:opacity-70"
            style={{ background: 'var(--accent)' }}
          >
            {bulkTotal > 0 ? (
              <>
                <Spinner size={15} />
                Ajout {bulkDone}/{bulkTotal}…
              </>
            ) : (
              `Tout ajouter (${readyCount})`
            )}
          </button>
        </footer>
      )}
    </div>
  );
}

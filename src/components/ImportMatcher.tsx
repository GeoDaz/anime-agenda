'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { addFromSearch, itemIdOf } from '@/lib/library';
import { normalizeTitle, titleSimilarity, titlesMatch } from '@/lib/match';
import { anilist, searchSeriesResilient, tmdb, tvmaze } from '@/lib/providers';
import { platformLabel } from '@/lib/platforms';
import type { ImportCandidate } from '@/lib/importers';
import type { PlatformId, SearchResult } from '@/lib/types';
import { useItems, useSettings } from '@/lib/useStore';
import { PlatformBadges } from './PlatformBadge';
import { MatchSkeleton, ProgressBar, Spinner } from './Loaders';
import { SubtypeTag } from './SubtypeTag';

interface Row {
  candidate: ImportCandidate;
  matches: SearchResult[];
  chosen: number;
  /** `failed` = la recherche n'a pas abouti, a distinguer de `none`. */
  state: 'pending' | 'searching' | 'ready' | 'none' | 'failed' | 'added';
  error?: string;
}

/** Plateformes dont le catalogue est majoritairement live-action. */
const LIVE_ACTION_PLATFORMS: PlatformId[] = ['netflix', 'disneyplus', 'primevideo'];

/** Ce qui est interroge, dit simplement. */
const PHASE_LABEL: Record<'tvmaze' | 'tmdb' | 'anilist', string> = {
  tvmaze: 'TVmaze et traduction des titres',
  tmdb: 'TMDB',
  anilist: 'AniList (animes)',
};

/**
 * Rapprochement semi-automatique d'une liste importee.
 *
 * TVmaze est le moteur PRINCIPAL, pas le secours. Raison mesuree : les exports
 * Netflix francais contiennent des titres traduits qu'AniList ignore
 * completement, puisqu'AniList ne stocke aucun libelle francais.
 *
 *   "Du mouvement de la Terre" -> AniList dit "Orb: On the Movements of the Earth"
 *   "Valkyrie Apocalypse"      -> AniList dit "Record of Ragnarok"
 *   "Maniac par Junji Ito"     -> AniList dit "Junji Ito Maniac"
 *
 * Aucun reglage de seuil ne rapproche ces paires. TVmaze indexe les titres
 * alternatifs par pays, et ce qu'il rate passe par une traduction
 * Wikidata/Wikipedia. AniList reste utile pour les titres deja en romaji et pour
 * le planning de diffusion ; TMDB n'intervient que si une cle est fournie.
 *
 * On ne pousse jamais un ajout sans validation : un mauvais rapprochement se
 * paye longtemps dans l'agenda.
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
  const { settings } = useSettings();
  const { items } = useItems();

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
  const [quotaNotice, setQuotaNotice] = useState<string | null>(null);
  /** Source en cours d'interrogation, pour dire a l'utilisateur ce qui se passe. */
  const [phase, setPhase] = useState<'tvmaze' | 'tmdb' | 'anilist' | null>('tvmaze');
  /** Lignes en cours d'ajout, pour un retour visuel sur le bon bouton. */
  const [busyRows, setBusyRows] = useState<Set<number>>(new Set());
  const [bulkTotal, setBulkTotal] = useState(0);
  const [bulkDone, setBulkDone] = useState(0);
  /**
   * Jeton d'execution, plutot qu'un booleen « annule ».
   *
   * Un booleen partage ne survit pas au double montage du mode strict de React :
   * le nettoyage du premier passage le mettait a `true`, puis le second passage
   * le remettait a `false` — ce qui REANIMAIT la boucle du premier. Les deux
   * tournaient alors en parallele et poussaient les memes resultats, d'ou des
   * doublons de cle React (« two children with the same key `tvmaze:64712` »).
   *
   * Avec un jeton, chaque passage garde son numero : des que le compteur bouge,
   * l'ancienne boucle se sait perimee et s'arrete pour de bon.
   */
  const runId = useRef(0);

  const hasKey = tmdb.hasTmdbKey(settings.tmdbApiKey);
  const preferSeries = sourcePlatform !== null && LIVE_ACTION_PLATFORMS.includes(sourcePlatform);
  const trackedIds = new Set((items ?? []).map((i) => i.id));

  /** Ordonne et filtre les candidats d'un titre donne. */
  const rank = useCallback(
    (found: SearchResult[], title: string): SearchResult[] => {
      const nt = normalizeTitle(title);

      // Deduplication par identifiant, en plus de la correction du jeton
      // d'execution : c'est cette liste qui alimente les cles React, donc son
      // unicite ne doit dependre d'aucune hypothese sur les providers. Une
      // recherche TVmaze peut tres bien renvoyer deux fois la meme serie.
      const seen = new Set<string>();
      const unique = found.filter((r) => {
        const id = itemIdOf(r);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });

      return unique
        // titlesMatch plutot qu'un seuil brut : a 0.45, "The Crown" attrapait
        // "The Everlasting Guilty Crown". On compare tous les libelles connus.
        .filter((r) => titlesMatch([r.title, r.originalTitle, ...(r.altTitles ?? [])], [title]))
        .map((r) => {
          const base = Math.max(
            titleSimilarity(normalizeTitle(r.title), nt),
            ...(r.altTitles ?? []).map((t) => titleSimilarity(normalizeTitle(t), nt))
          );
          const wanted = preferSeries ? 'series' : 'anime';
          const bonus = sourcePlatform === null ? 0 : r.kind === wanted ? 0.15 : -0.15;
          return { r, score: base + bonus };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 4)
        .map(({ r }) => r);
    },
    [preferSeries, sourcePlatform]
  );

  useEffect(() => {
    const myRun = ++runId.current;
    /** Vrai des qu'un autre passage a pris le relais, ou que l'utilisateur a fermé. */
    const isStale = () => runId.current !== myRun;
    const key = settings.tmdbApiKey;

    (async () => {
      const all = rows.map((r) => r.candidate.title);
      // Accumulateurs LOCAUX au passage : deux executions concurrentes ne
      // peuvent plus se melanger, meme si l'une survit un instant a l'autre.
      const collected = new Map<string, SearchResult[]>();
      const failures = new Map<string, string>();

      const push = (title: string, results: SearchResult[]) => {
        collected.set(title, [...(collected.get(title) ?? []), ...results]);
      };

      /**
       * Reclasse une ligne avec tout ce qu'on sait d'elle a cet instant.
       *
       * Appele apres chaque phase et non une seule fois a la fin : sur 48 titres
       * la recherche complete prend plus d'une minute, et laisser les lignes
       * vides pendant tout ce temps donne l'impression que rien ne se passe.
       * Une ligne trouvee par TVmaze s'affiche donc immediatement, et AniList
       * viendra eventuellement enrichir ses alternatives.
       */
      const settle = (index: number, isFinal: boolean) => {
        const title = all[index];
        const found = collected.get(title) ?? [];
        const matches = rank(found, title);

        setRows((prev) =>
          prev.map((row, i) => {
            if (i !== index) return row;
            // Ne jamais ecraser une ligne que l'utilisateur a deja ajoutee.
            if (row.state === 'added') return row;
            if (matches.length) {
              // `chosen` est preserve : sinon un enrichissement tardif annulerait
              // la selection manuelle de l'utilisateur.
              const chosen = Math.min(row.chosen, matches.length - 1);
              return { ...row, matches, chosen, state: 'ready' as const };
            }
            if (!isFinal) return { ...row, state: 'searching' as const };
            const err = failures.get(title);
            // Une recherche qui a echoue n'est pas une serie introuvable.
            return err
              ? { ...row, state: 'failed' as const, error: err }
              : { ...row, state: 'none' as const };
          })
        );
      };

      // --- 1. TVmaze, avec repli par traduction du titre. Aucune cle requise,
      //        et c'est la source qui rapproche le mieux les titres francais. ---
      setPhase('tvmaze');
      for (let i = 0; i < all.length; i++) {
        if (isStale()) return;
        setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, state: 'searching' } : r)));
        try {
          push(all[i], await searchSeriesResilient(all[i]));
        } catch (e) {
          failures.set(all[i], e instanceof Error ? e.message : 'TVmaze indisponible');
        }
        settle(i, false);
        await new Promise((res) => setTimeout(res, tvmaze.REQUEST_SPACING_MS));
      }

      // --- 2. TMDB en complement, uniquement si une cle est fournie ---
      if (tmdb.hasTmdbKey(key)) {
        setPhase('tmdb');
        for (let i = 0; i < all.length; i++) {
          if (isStale()) return;
          try {
            push(all[i], await tmdb.searchSeries(all[i], key));
            settle(i, false);
          } catch (e) {
            if (!collected.get(all[i])?.length) {
              failures.set(all[i], e instanceof Error ? e.message : 'TMDB indisponible');
            }
          }
          await new Promise((res) => setTimeout(res, 120));
        }
      }

      // --- 3. AniList par lots de 8 (quota 30 requetes/minute) ---
      setPhase('anilist');
      for (let start = 0; start < all.length; start += anilist.SEARCH_BATCH_SIZE) {
        if (isStale()) return;
        const chunk = all.slice(start, start + anilist.SEARCH_BATCH_SIZE);
        try {
          const batch = await anilist.searchAnimeBatch(chunk);
          for (const [title, results] of batch) push(title, results);
        } catch (e) {
          if (e instanceof anilist.AniListRateLimitError) {
            setQuotaNotice(e.message);
            // Inutile d'insister : les lots suivants echoueraient aussi.
            for (const t of all.slice(start)) {
              if (!collected.get(t)?.length) failures.set(t, 'Quota AniList atteint');
            }
            break;
          }
          for (const t of chunk) {
            failures.set(t, e instanceof Error ? e.message : 'AniList indisponible');
          }
        }
        for (let i = start; i < Math.min(start + anilist.SEARCH_BATCH_SIZE, all.length); i++) {
          settle(i, false);
        }
        // 8 requetes espacees de 2,2 s = ~27/min, sous le plafond de 30.
        await new Promise((res) => setTimeout(res, 2200));
      }

      if (isStale()) return;

      // Passe finale : ce qui n'a rien trouve devient "introuvable" ou "en echec".
      for (let i = 0; i < all.length; i++) settle(i, true);
      setPhase(null);
      setScanning(false);
    })();

    // Incrementer suffit a perimer ce passage : le suivant prendra un numero
    // encore superieur, donc aucune boucle ne peut etre reanimee.
    return () => {
      runId.current++;
    };
    // Volontairement sur le montage : `rows` est la liste figee a l'ouverture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rank, settings.tmdbApiKey]);

  const addRow = async (index: number) => {
    const row = rows[index];
    const match = row.matches[row.chosen];
    if (!match) return;

    // Les numeros Netflix sont relatifs a la saison : on ne reporte la
    // progression que si elle est sans ambiguite.
    const { episode, season } = row.candidate;
    const progress = episode !== null && (season === null || season === 1) ? episode : 0;

    setBusyRows((prev) => new Set(prev).add(index));
    try {
      await addFromSearch(match, {
        tmdbApiKey: settings.tmdbApiKey,
        platformHint: sourcePlatform,
        progress,
      });
      setRows((prev) => prev.map((r, i) => (i === index ? { ...r, state: 'added' } : r)));
      setAddedCount((c) => c + 1);
    } finally {
      setBusyRows((prev) => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }
  };

  const addAllReady = async () => {
    // Sequentiel : chaque ajout declenche un enrichissement reseau, et les
    // paralleliser saturerait les quotas des providers.
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
  const failedCount = rows.filter((r) => r.state === 'failed').length;
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
              {scanning && (
                <span style={{ color: 'var(--accent)' }}>
                  <Spinner size={15} label="Recherche en cours" />
                </span>
              )}
            </h2>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {scanning
                ? `${doneCount}/${rows.length} · ${PHASE_LABEL[phase ?? 'tvmaze']}`
                : `${readyCount} à valider · ${addedCount} ajoutée(s)`}
              {sourcePlatform && ` · source ${platformLabel(sourcePlatform)}`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              // Perime la recherche en cours avant de fermer.
              runId.current++;
              onClose(addedCount);
            }}
            className="tap shrink-0 rounded-lg px-3 py-2 text-xs font-semibold"
            style={{ background: 'var(--surface-2)' }}
          >
            Terminer
          </button>
        </div>

        {/* La barre reste visible apres coup : elle sert aussi de recapitulatif. */}
        {scanning && <ProgressBar done={doneCount} total={rows.length} />}
      </header>

      {/* TVmaze couvre l'essentiel sans cle. TMDB n'apporte plus qu'un gain de
          precision sur la plateforme francaise, donc on informe sans alarmer. */}
      {!hasKey && (
        <div className="border-b px-4 py-2" style={{ borderColor: 'var(--border)' }}>
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Recherche via TVmaze, Wikidata et Wikipédia — sans clé d’API. Les plateformes indiquées
            sont celles d’origine, corrigeables dans Ma liste.{' '}
            <Link href="/import/" className="underline">
              Une clé TMDB
            </Link>{' '}
            donnerait la disponibilité exacte en France, mais n’est pas nécessaire.
          </p>
        </div>
      )}

      {quotaNotice && (
        <p className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          {quotaNotice} — les lignes marquées « recherche impossible » ne sont pas des séries
          introuvables. Relance l’import dans une minute pour les compléter.
        </p>
      )}

      {truncated > 0 && (
        <p className="bg-amber-500/10 px-4 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          {candidates.length} titres détectés, seuls les {LIMIT} plus fréquents sont traités.{' '}
          {truncated} ignorés.
        </p>
      )}

      {!scanning && (noneCount > 0 || failedCount > 0) && (
        <p className="px-4 py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {noneCount > 0 && `${noneCount} sans correspondance (souvent des films). `}
          {failedCount > 0 && `${failedCount} recherche(s) en échec.`}
        </p>
      )}

      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {rows.map((row, index) => {
          const match = row.matches[row.chosen];
          const already = match && trackedIds.has(itemIdOf(match));
          const ambiguous = new Set(row.matches.map((m) => m.kind)).size > 1;

          return (
            <div
              key={`${row.candidate.title}-${index}`}
              className="rounded-xl border p-3"
              style={{
                background: 'var(--surface)',
                borderColor: ambiguous && row.state === 'ready' ? '#f59e0b66' : 'var(--border)',
                opacity: row.state === 'added' ? 0.5 : 1,
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{row.candidate.title}</p>
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {row.candidate.count > 1 ? `${row.candidate.count} occurrences` : '1 occurrence'}
                    {row.candidate.season ? ` · saison ${row.candidate.season}` : ''}
                    {row.candidate.episode ? ` · ép. ${row.candidate.episode}` : ''}
                  </p>
                </div>
                {row.state === 'searching' && (
                  <span className="shrink-0" style={{ color: 'var(--accent)' }}>
                    <Spinner size={13} />
                  </span>
                )}
              </div>

              {/* Silhouette pendant l'attente : evite que la liste ne saute quand
                  le vrai contenu arrive, et montre qu'il se passe quelque chose. */}
              {(row.state === 'pending' || row.state === 'searching') && <MatchSkeleton />}

              {row.state === 'none' && (
                <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Aucune correspondance trouvée.
                </p>
              )}

              {row.state === 'failed' && (
                <p className="mt-2 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                  Recherche impossible — {row.error}
                </p>
              )}

              {ambiguous && row.state === 'ready' && (
                <p className="mt-2 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                  Anime et live-action portent ce titre — vérifie la sélection.
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
                      <p className="flex items-baseline gap-1.5 truncate text-xs font-medium">
                        <span className="truncate">{match.title}</span>
                        <SubtypeTag subtype={match.subtype} />
                      </p>
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {match.kind === 'anime' ? 'Anime' : 'Série live-action'}
                        {match.year ? ` · ${match.year}` : ''}
                        {match.provider === 'tmdb' ? ' · TMDB' : ' · AniList'}
                      </p>
                      <div className="mt-1">
                        <PlatformBadges ids={match.platforms} max={2} />
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={!!already || busyRows.has(index)}
                      onClick={() => void addRow(index)}
                      className="tap flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold disabled:opacity-60"
                      style={{
                        background: already ? 'var(--surface-2)' : 'var(--accent)',
                        color: already ? 'var(--text-muted)' : '#fff',
                      }}
                    >
                      {busyRows.has(index) && <Spinner size={11} />}
                      {already ? 'Suivi' : busyRows.has(index) ? 'Ajout…' : 'Ajouter'}
                    </button>
                  </div>

                  {row.matches.length > 1 && (
                    <div className="mt-2 flex flex-col gap-1">
                      {row.matches.map((alt, i) => (
                        <button
                          key={itemIdOf(alt)}
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
                            {alt.kind === 'anime' ? 'Anime' : 'Série'}
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
                  Ajouté à ta liste
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

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PlatformBadges } from './PlatformBadge';
import { SubtypeTag } from './SubtypeTag';
import { Skeleton, Spinner } from './Loaders';
import { CoverLightbox } from './CoverLightbox';
import { adn, anilist, searchSeriesResilient, tmdb } from '@/lib/providers';
import { addFromSearch, itemIdOf } from '@/lib/library';
import { normalizeTitle, titleSimilarity } from '@/lib/match';
import type { SearchResult } from '@/lib/types';
import { notifyStoreChanged, useItems, useSettings } from '@/lib/useStore';

type Scope = 'all' | 'anime' | 'series';

/**
 * Recherche et ajout de series, integre dans Ma liste.
 *
 * Etait une page a part entiere ; regroupe ici pour que tout ce qui touche a la
 * bibliotheque vive au meme endroit, et que la barre de navigation reste courte.
 */
export function SearchPanel({ onAdded }: { onAdded?: () => void }) {
  const { items } = useItems();
  const { settings } = useSettings();

  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  /** Jaquette affichee en grand, `null` quand la visionneuse est fermee. */
  const [zoomed, setZoomed] = useState<{ src: string; title: string } | null>(null);

  const trackedIds = new Set((items ?? []).map((i) => i.id));
  // Un compteur de requete evite qu'une reponse lente ecrase une saisie plus recente.
  const requestId = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Le panneau s'ouvre a la demande : autant placer le curseur directement.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const runSearch = useCallback(
    async (q: string, currentScope: Scope) => {
      const rid = ++requestId.current;
      if (!q.trim()) {
        setResults([]);
        setStatus('idle');
        setMessage(null);
        return;
      }

      setStatus('loading');
      setMessage(null);

      const tasks: Promise<SearchResult[]>[] = [];
      const errors: string[] = [];

      if (currentScope !== 'series') {
        tasks.push(
          anilist.searchAnime(q).catch((e) => {
            errors.push(`AniList : ${e.message}`);
            return [];
          })
        );
        tasks.push(
          adn.searchShows(q).catch(() => {
            // ADN est un bonus ici : AniList couvre deja le catalogue anime.
            return [];
          })
        );
      }

      if (currentScope !== 'anime') {
        // TVmaze : aucune cle, et gere les titres francais (via ses titres
        // alternatifs, puis par traduction Wikidata/Wikipedia si besoin).
        tasks.push(
          searchSeriesResilient(q).catch((e) => {
            errors.push(`TVmaze : ${e.message}`);
            return [];
          })
        );
        // TMDB en bonus quand une cle est configuree : disponibilite FR exacte.
        if (tmdb.hasTmdbKey(settings.tmdbApiKey)) {
          tasks.push(
            tmdb.searchSeries(q, settings.tmdbApiKey).catch((e) => {
              errors.push(`TMDB : ${e.message}`);
              return [];
            })
          );
        }
      }

      const groups = await Promise.all(tasks);
      if (rid !== requestId.current) return; // une saisie plus recente a pris le relais

      setResults(dedupeResults(groups.flat(), q));
      setMessage(errors.length ? errors.join(' · ') : null);
      setStatus(errors.length && !groups.flat().length ? 'error' : 'done');
    },
    [settings.tmdbApiKey]
  );

  // Debounce : on ne veut pas une requete par frappe.
  useEffect(() => {
    const t = setTimeout(() => void runSearch(query, scope), 350);
    return () => clearTimeout(t);
  }, [query, scope, runSearch]);

  const onAdd = async (result: SearchResult) => {
    const id = itemIdOf(result);
    setAdding(id);
    try {
      await addFromSearch(result, { tmdbApiKey: settings.tmdbApiKey });
      notifyStoreChanged();
      onAdded?.();
    } finally {
      setAdding(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="relative">
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Titre de l’anime ou de la série…"
          enterKeyHint="search"
          autoComplete="off"
          className="w-full rounded-xl border px-4 py-3 pr-10 text-base outline-none focus:ring-2"
          style={{
            background: 'var(--bg)',
            borderColor: 'var(--border)',
            // @ts-expect-error -- propriete CSS personnalisee acceptee par React
            '--tw-ring-color': 'var(--accent)',
          }}
        />
        {status === 'loading' && (
          <span
            className="absolute right-3 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--accent)' }}
          >
            <Spinner size={16} label="Recherche en cours" />
          </span>
        )}
      </div>

      <div className="flex gap-2">
        {(
          [
            ['all', 'Tout'],
            ['anime', 'Animes'],
            ['series', 'Séries'],
          ] as [Scope, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setScope(value)}
            aria-pressed={scope === value}
            className="tap rounded-full border px-3 py-1.5 text-xs font-semibold"
            style={{
              borderColor: scope === value ? 'var(--accent)' : 'var(--border)',
              color: scope === value ? 'var(--accent)' : 'var(--text-muted)',
              background:
                scope === value
                  ? 'color-mix(in srgb, var(--accent) 14%, transparent)'
                  : 'var(--bg)',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {message && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {message}
        </p>
      )}

      {status === 'idle' && !query.trim() && (
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Animes via AniList et ADN, séries et animation via TVmaze. Aucune clé d’API nécessaire.
        </p>
      )}

      {status === 'loading' && results.length === 0 && (
        <ul className="grid grid-cols-2 gap-2" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <li
              key={i}
              className="overflow-hidden rounded-xl border"
              style={{ borderColor: 'var(--border)' }}
            >
              <Skeleton className="aspect-[2/3] w-full rounded-none" />
              <div className="space-y-2 p-2">
                <Skeleton width="80%" height={10} />
                <Skeleton width="45%" height={8} />
                <Skeleton height={26} className="rounded-lg" />
              </div>
            </li>
          ))}
        </ul>
      )}

      {status === 'done' && results.length === 0 && query.trim() && (
        <p className="py-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          Aucun résultat. Essaie l’onglet « À la main » pour créer la fiche toi-même.
        </p>
      )}

      {/* Fiches verticales en grille : a demi-largeur, la jaquette en bandeau
          superieur reste lisible la ou une disposition horizontale ecraserait le
          texte a une centaine de pixels. */}
      <ul className="grid grid-cols-2 gap-2">
        {results.map((result) => {
          const id = itemIdOf(result);
          const tracked = trackedIds.has(id);
          return (
            <li
              key={id}
              className="flex flex-col overflow-hidden rounded-xl border"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
            >
              {result.coverUrl ? (
                /*
                 * La jaquette n'est plus un bouton pleine surface.
                 *
                 * En fiche verticale elle occupe la majeure partie de la carte :
                 * en faire une cible de zoom captait les taps destines a
                 * « + Suivre ». Le zoom passe donc par une loupe dediee, et le
                 * reste de l'image est inerte — un tap a cote ne declenche plus
                 * rien au lieu d'ouvrir la visionneuse.
                 */
                <div className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element -- images externes, export statique */}
                  <img
                    src={result.coverUrl}
                    alt=""
                    loading="lazy"
                    className="aspect-[2/3] w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => setZoomed({ src: result.coverUrl!, title: result.title })}
                    aria-label={`Voir la jaquette de ${result.title} en grand`}
                    className="tap absolute bottom-1.5 right-1.5 flex h-8 w-8 items-center justify-center rounded-full text-white backdrop-blur-sm"
                    style={{ background: 'rgba(0,0,0,0.55)' }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
                      <circle
                        cx="10.5"
                        cy="10.5"
                        r="6"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                      <path
                        d="M15 15l5 5M8 10.5h5M10.5 8v5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
              ) : (
                <span
                  aria-hidden="true"
                  className="aspect-[2/3] w-full"
                  style={{ background: 'var(--surface-2)' }}
                />
              )}

              <div className="flex flex-1 flex-col justify-between gap-2 p-2">
                <div className="min-w-0">
                  <p className="flex items-baseline gap-1 text-[13px] font-semibold leading-tight">
                    <span className="line-clamp-2">{result.title}</span>
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    <span>{result.kind === 'anime' ? 'Anime' : 'Série'}</span>
                    {result.year && <span>· {result.year}</span>}
                    {result.totalEpisodes && <span>· {result.totalEpisodes} ép.</span>}
                    <SubtypeTag subtype={result.subtype} />
                  </p>
                  {result.platforms.length > 0 && (
                    <div className="mt-1.5">
                      <PlatformBadges ids={result.platforms} max={2} />
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  disabled={tracked || adding === id}
                  onClick={() => void onAdd(result)}
                  className="tap flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold disabled:opacity-60"
                  style={{
                    background: tracked ? 'var(--surface-2)' : 'var(--accent)',
                    color: tracked ? 'var(--text-muted)' : '#fff',
                  }}
                >
                  {adding === id && <Spinner size={11} />}
                  {tracked ? 'Déjà suivi' : adding === id ? 'Ajout…' : '+ Suivre'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {zoomed && (
        <CoverLightbox src={zoomed.src} title={zoomed.title} onClose={() => setZoomed(null)} />
      )}
    </div>
  );
}

/**
 * Deduplique les resultats inter-providers et remonte les meilleures
 * correspondances. AniList et ADN renvoient souvent la meme serie : on garde
 * AniList (planning plus riche) mais on n'affiche pas deux lignes.
 */
function dedupeResults(results: SearchResult[], query: string): SearchResult[] {
  // TMDB devant TVmaze quand les deux repondent : sa disponibilite par
  // plateforme est regionalisee sur la France, celle de TVmaze non.
  const PROVIDER_RANK: Record<string, number> = {
    anilist: 4,
    tmdb: 3,
    tvmaze: 2,
    adn: 1,
    manual: 0,
  };
  const kept: SearchResult[] = [];

  for (const r of results) {
    const normalized = normalizeTitle(r.title);
    const twin = kept.findIndex(
      (k) => k.kind === r.kind && titleSimilarity(normalizeTitle(k.title), normalized) >= 0.9
    );
    if (twin === -1) {
      kept.push(r);
    } else if (PROVIDER_RANK[r.provider] > PROVIDER_RANK[kept[twin].provider]) {
      // On garde la meilleure source, en conservant les plateformes connues des deux.
      kept[twin] = { ...r, platforms: [...new Set([...r.platforms, ...kept[twin].platforms])] };
    }
  }

  const nq = normalizeTitle(query);
  return kept
    .map((r) => ({ r, score: titleSimilarity(normalizeTitle(r.title), nq) }))
    .sort((a, b) => b.score - a.score)
    .map(({ r }) => r);
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PlatformBadges } from './PlatformBadge';
import { SubtypeTag } from './SubtypeTag';
import { Skeleton, Spinner } from './Loaders';
import { CoverLightbox } from './CoverLightbox';
import { addToAccount, searchAll } from '@/lib/providers';
import type { SearchResult } from '@/lib/types';
import { notifyStoreChanged, useItems, useSession } from '@/lib/useStore';

/**
 * Recherche et ajout, via BetaSeries.
 *
 * Aucun re-filtrage par titre : la mesure a montre qu'un tel filtre rejetait 19
 * titres sur 49 que BetaSeries avait pourtant trouves correctement, parce qu'il
 * gere deja le multilingue (« Mercredi » trouve « Wednesday »). On respecte donc
 * son classement.
 *
 * Ajouter une serie l'ecrit SUR LE COMPTE BetaSeries : elle se retrouve aussi
 * sur le site, et la progression suit.
 */
export function SearchPanel({ onAdded }: { onAdded?: () => void }) {
	const { items } = useItems();
	const { session, connected } = useSession();

	const [query, setQuery] = useState('');
	const [results, setResults] = useState<SearchResult[]>([]);
	const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
	const [message, setMessage] = useState<string | null>(null);
	const [adding, setAdding] = useState<string | null>(null);
	const [zoomed, setZoomed] = useState<{ src: string; title: string } | null>(null);

	const trackedIds = new Set((items ?? []).map(i => i.id));
	// Un compteur de requete evite qu'une reponse lente ecrase une saisie plus recente.
	const requestId = useRef(0);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const runSearch = useCallback(
		async (q: string) => {
			const rid = ++requestId.current;
			if (!q.trim()) {
				setResults([]);
				setStatus('idle');
				setMessage(null);
				return;
			}
			setStatus('loading');
			setMessage(null);
			try {
				const found = await searchAll(session, q);
				if (rid !== requestId.current) return;
				setResults(found);
				setStatus('done');
			} catch (e) {
				if (rid !== requestId.current) return;
				setMessage(e instanceof Error ? e.message : 'Recherche impossible');
				setStatus('error');
			}
		},
		[session]
	);

	useEffect(() => {
		const t = setTimeout(() => void runSearch(query), 350);
		return () => clearTimeout(t);
	}, [query, runSearch]);

	const onAdd = async (result: SearchResult) => {
		const id = `betaseries:${result.externalId}`;
		setAdding(id);
		try {
			await addToAccount(session, result);
			notifyStoreChanged();
			onAdded?.();
		} catch (e) {
			setMessage(e instanceof Error ? e.message : 'Ajout impossible');
		} finally {
			setAdding(null);
		}
	};

	if (!connected) {
		return (
			<p
				className="py-4 text-center text-sm"
				style={{ color: 'var(--text-muted)' }}
			>
				Connecte-toi à BetaSeries depuis la page Import pour chercher et ajouter
				des séries.
			</p>
		);
	}

	return (
		<div className="space-y-3">
			<div className="relative">
				<input
					ref={inputRef}
					type="search"
					value={query}
					onChange={e => setQuery(e.target.value)}
					placeholder="Titre de la série ou du film…"
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

			{message && (
				<p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
					{message}
				</p>
			)}

			{status === 'idle' && !query.trim() && (
				<p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
					Séries et films via BetaSeries. Les titres français sont reconnus.
				</p>
			)}

			{status === 'loading' && results.length === 0 && (
				<ul className="grid grid-cols-2 gap-2" aria-hidden="true">
					{[0, 1, 2, 3].map(i => (
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
				<p
					className="py-6 text-center text-sm"
					style={{ color: 'var(--text-muted)' }}
				>
					Aucun résultat sur BetaSeries.
				</p>
			)}

			<ul className="grid grid-cols-2 gap-2">
				{results.map(result => {
					const id = `betaseries:${result.externalId}`;
					const tracked = trackedIds.has(id);
					return (
						<li
							key={id}
							className="flex flex-col gap-2 p-2 overflow-hidden rounded-xl border"
							style={{
								background: 'var(--bg)',
								borderColor: 'var(--border)',
							}}
						>
							<div className="flex gap-2">
								{result.coverUrl ?
									<div className="relative">
										{/* eslint-disable-next-line @next/next/no-img-element -- images externes, export statique */}
										<img
											src={result.coverUrl}
											alt=""
											loading="lazy"
											className="h-[75px] w-[51px] rounded object-cover"
											onClick={() =>
												setZoomed({
													src: result.coverUrl!,
													title: result.title,
												})
											}
										/>
									</div>
								:	<span
										aria-hidden="true"
										className="aspect-[2/3] w-full"
										style={{ background: 'var(--surface-2)' }}
									/>
								}

								<div className="flex flex-1 flex-col justify-between gap-2">
									<div className="min-w-0">
										<p className="text-[13px] font-semibold leading-tight">
											<span className="line-clamp-2">
												{result.title}
											</span>
										</p>
										<p
											className="mt-1 flex flex-wrap items-center gap-1 text-[10px]"
											style={{ color: 'var(--text-muted)' }}
										>
											<span>
												{result.externalId.startsWith('m') ?
													'Film'
												:	'Série'}
											</span>
											{result.year && <span>· {result.year}</span>}
											{result.totalEpisodes && (
												<span>· {result.totalEpisodes} ép.</span>
											)}
											<SubtypeTag subtype={result.subtype} />
										</p>
										{result.platforms.length > 0 && (
											<div className="mt-1.5">
												<PlatformBadges
													ids={result.platforms}
													max={2}
												/>
											</div>
										)}
									</div>
								</div>
							</div>
							<button
								type="button"
								disabled={tracked || adding === id}
								onClick={() => void onAdd(result)}
								className="tap flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold disabled:opacity-60"
								style={{
									borderWidth: '1px',
									borderStyle: 'solid',
									borderColor:
										tracked ? 'var(--surface-2)' : 'var(--accent)',
									color:
										tracked ? 'var(--text-muted)' : 'var(--accent)',
								}}
							>
								{adding === id && <Spinner size={11} />}
								{tracked ?
									'Déjà suivi'
								: adding === id ?
									'Ajout…'
								:	'+ Suivre'}
							</button>
						</li>
					);
				})}
			</ul>

			{zoomed && (
				<CoverLightbox
					src={zoomed.src}
					title={zoomed.title}
					onClose={() => setZoomed(null)}
				/>
			)}
		</div>
	);
}

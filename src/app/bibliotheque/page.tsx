'use client';

import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/AppShell';
import { PlatformBadges, PlatformChip } from '@/components/PlatformBadge';
import { SubtypeTag } from '@/components/SubtypeTag';
import { SearchPanel } from '@/components/SearchPanel';
import { CoverLightbox } from '@/components/CoverLightbox';
import { deleteItem, patchItem, setOverrides, setProgress } from '@/lib/db';
import { TRACKED_PLATFORMS } from '@/lib/platforms';
import { resolveItem } from '@/lib/providers';
import type { PlatformId, ResolvedItem, TrackedItem, WatchStatus } from '@/lib/types';
import { notifyStoreChanged, useItems } from '@/lib/useStore';

const STATUS_LABEL: Record<WatchStatus, string> = {
	watching: 'En cours',
	planned: 'À voir',
	done: 'Terminé',
	dropped: 'Abandonné',
};

/** Filtres proposes, dans l'ordre d'affichage. */
const FILTERS: ('all' | WatchStatus)[] = ['all', 'watching', 'planned', 'done'];

/**
 * Tri par diffusion decroissante : ce qui vient de sortir en premier.
 * Les series sans date connue passent en fin de liste, classees par titre, plutot
 * que de polluer le haut avec des valeurs nulles.
 */
function byAiringDesc(a: ResolvedItem, b: ResolvedItem): number {
	const da = a.lastAiredAt ?? null;
	const db = b.lastAiredAt ?? null;
	if (da !== null && db !== null) return db - da;
	if (da !== null) return -1;
	if (db !== null) return 1;

	// Sans date exploitable, on suit l'ordre renvoye par l'API, qui a trie sur des
	// champs dont l'app ne dispose pas. Rejouer un tri local produirait un
	// classement different et faux.
	const ia = a.sortIndex ?? Number.MAX_SAFE_INTEGER;
	const ib = b.sortIndex ?? Number.MAX_SAFE_INTEGER;
	if (ia !== ib) return ia - ib;

	return a.displayTitle.localeCompare(b.displayTitle, 'fr');
}

/** Normalisation legere pour la recherche locale : accents et casse ignores. */
function searchable(s: string): string {
	return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export default function LibraryPage() {
	const { items, loading, error, reload } = useItems();
	const [expanded, setExpanded] = useState<string | null>(null);
	const [filter, setFilter] = useState<'all' | WatchStatus>('all');
	/** Panneau d'ajout : ferme, ou ouvert sur la recherche BetaSeries. */
	const [addMode, setAddMode] = useState<'closed' | 'search'>('closed');
	/** Jaquette affichee en grand, `null` quand la visionneuse est fermee. */
	const [zoomed, setZoomed] = useState<{ src: string; title: string } | null>(null);

	/** Recherche locale : la liste est deja chargee, inutile d'interroger l'API. */
	const [query, setQuery] = useState('');

	const visible = useMemo(() => {
		if (!items) return [];
		const byStatus =
			filter === 'all' ? items : items.filter(i => i.status === filter);
		const resolved = byStatus.map(resolveItem);

		const q = searchable(query.trim());
		const found =
			q ?
				resolved.filter(
					i =>
						searchable(i.displayTitle).includes(q) ||
						searchable(i.originalTitle ?? '').includes(q)
				)
			:	resolved;

		return found.sort(byAiringDesc);
	}, [items, filter, query]);

	/** Compte par etat, pour afficher le volume reel derriere chaque filtre. */
	const counts = useMemo(() => {
		const out: Record<string, number> = { all: items?.length ?? 0 };
		for (const s of FILTERS) {
			if (s === 'all') continue;
			out[s] = (items ?? []).filter(i => i.status === s).length;
		}
		return out;
	}, [items]);

	return (
		<>
			<PageHeader
				title="Ma liste"
				subtitle={
					items ?
						`${items.length} série${items.length > 1 ? 's' : ''} sur ton compte BetaSeries`
					:	undefined
				}
				action={
					<button
						type="button"
						onClick={() =>
							setAddMode(m => (m === 'closed' ? 'search' : 'closed'))
						}
						aria-expanded={addMode !== 'closed'}
						className="tap mt-1 shrink-0 rounded-lg px-3 py-2 text-xs font-semibold"
						style={{
							background:
								addMode === 'closed' ? 'var(--accent)' : (
									'var(--surface-2)'
								),
							color: addMode === 'closed' ? '#fff' : 'var(--text)',
						}}
					>
						{addMode === 'closed' ? '+ Ajouter' : 'Fermer'}
					</button>
				}
			/>

			{addMode !== 'closed' && (
				<div
					className="mx-4 mb-4 rounded-xl border p-3"
					style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
				>
					<SearchPanel />
				</div>
			)}

			<div className="px-4 pb-3">
				<input
					type="search"
					value={query}
					onChange={e => setQuery(e.target.value)}
					placeholder="Rechercher dans ma liste…"
					enterKeyHint="search"
					autoComplete="off"
					className="w-full rounded-xl border px-3 py-2 text-sm outline-none focus:ring-2"
					style={{
						background: 'var(--surface)',
						borderColor: 'var(--border)',
						// @ts-expect-error -- propriete CSS personnalisee acceptee par React
						'--tw-ring-color': 'var(--accent)',
					}}
				/>
			</div>

			<div className="no-scrollbar flex gap-2 overflow-x-auto px-4 pb-3">
				{FILTERS.map(value => (
					<button
						key={value}
						type="button"
						onClick={() => setFilter(value)}
						aria-pressed={filter === value}
						className="tap shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold"
						style={{
							borderColor:
								filter === value ? 'var(--accent)' : 'var(--border)',
							color:
								filter === value ? 'var(--accent)' : 'var(--text-muted)',
							background:
								filter === value ?
									'color-mix(in srgb, var(--accent) 14%, transparent)'
								:	'var(--surface)',
						}}
					>
						{value === 'all' ? 'Tout' : STATUS_LABEL[value]}
						{counts[value] > 0 && (
							<span className="ml-1 opacity-60">{counts[value]}</span>
						)}
					</button>
				))}
			</div>

			{/* Un echec de lecture laissait tourner le squelette indefiniment, sans le
          moindre message : impossible de distinguer « ca charge » de « c'est
          casse ». L'erreur est desormais visible et l'action de reprise offerte. */}
			{error && (
				<div className="mx-4 mb-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-3">
					<p className="text-xs font-semibold text-red-700 dark:text-red-300">
						Impossible de lire ta liste
					</p>
					<p className="mt-1 text-[11px] text-red-700/90 dark:text-red-300/90">
						{error}
					</p>
					<button
						type="button"
						onClick={reload}
						className="tap mt-2 rounded-lg px-3 py-1.5 text-[11px] font-semibold"
						style={{ background: 'var(--surface-2)' }}
					>
						Réessayer
					</button>
				</div>
			)}

			{loading && !error && (
				<ul
					className="grid grid-cols-1 gap-2 px-4 min-[400px]:grid-cols-2"
					aria-hidden="true"
				>
					{[0, 1, 2, 3].map(i => (
						<li key={i} className="skeleton h-[72px] rounded-xl" />
					))}
				</ul>
			)}

			{!loading && visible.length === 0 && (
				<p
					className="mt-8 px-4 text-center text-sm"
					style={{ color: 'var(--text-muted)' }}
				>
					Rien ici pour l’instant.
				</p>
			)}

			{/* Deux colonnes des ~400 px de large : en dessous, les fiches
          deviendraient trop etroites pour rester lisibles. */}
			<ul className="grid grid-cols-1 gap-2 px-4 min-[400px]:grid-cols-2">
				{visible.map(item => (
					<ItemRow
						key={item.id}
						item={item}
						expanded={expanded === item.id}
						onToggle={() =>
							setExpanded(cur => (cur === item.id ? null : item.id))
						}
						onZoom={src => setZoomed({ src, title: item.displayTitle })}
					/>
				))}
			</ul>

			{zoomed && (
				<CoverLightbox
					src={zoomed.src}
					title={zoomed.title}
					onClose={() => setZoomed(null)}
				/>
			)}
		</>
	);
}

// --------------------------------------------------------------------------

function ItemRow({
	item,
	expanded,
	onToggle,
	onZoom,
}: {
	item: ReturnType<typeof resolveItem>;
	expanded: boolean;
	onToggle: () => void;
	onZoom: (src: string) => void;
}) {
	const total = item.overrides?.totalEpisodes ?? item.totalEpisodes ?? null;
	const [confirmDelete, setConfirmDelete] = useState(false);

	return (
		<li
			// Une fiche depliee occupe les deux colonnes : le panneau d'edition serait
			// illisible dans une demi-largeur, et ca evite un trou dans la grille.
			className={`overflow-hidden rounded-xl border ${expanded ? 'col-span-2' : ''}`}
			style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
		>
			<div className="flex items-stretch gap-2 p-2">
				{item.displayCover ?
					// Un bouton et non une image nue : l'agrandissement doit etre
					// atteignable au clavier et annonce comme une action.
					<button
						type="button"
						onClick={() => onZoom(item.displayCover!)}
						aria-label={`Voir la jaquette de ${item.displayTitle} en grand`}
						className="tap shrink-0 self-start overflow-hidden rounded-md"
					>
						{/* eslint-disable-next-line @next/next/no-img-element -- images externes, export statique */}
						<img
							src={item.displayCover}
							alt=""
							loading="lazy"
							className="h-[75px] w-[51px] object-cover"
						/>
					</button>
				:	<span
						aria-hidden="true"
						className="h-[75px] w-[51px] shrink-0 self-start rounded-md"
						style={{ background: 'var(--surface-2)' }}
					/>
				}

				<button
					type="button"
					onClick={onToggle}
					aria-expanded={expanded}
					className="tap min-w-0 flex-1 text-left"
				>
					<p className="flex items-baseline gap-1 text-sm font-semibold">
						<span className="truncate">{item.displayTitle}</span>
						<SubtypeTag subtype={item.subtype} />
					</p>
					<p
						className="mt-0.5 truncate text-[11px]"
						style={{ color: 'var(--text-muted)' }}
					>
						{STATUS_LABEL[item.status]} · ép. {item.progress}
						{total ? `/${total}` : ''}
					</p>
					<div className="mt-1">
						<PlatformBadges ids={item.displayPlatforms} max={2} />
					</div>
				</button>

				{/* Suppression atteignable directement, sans deplier la fiche, mais
            toujours en deux temps : c'est une action irreversible. */}
				{confirmDelete ?
					<span className="flex shrink-0 flex-col justify-center gap-1">
						<button
							type="button"
							onClick={async () => {
								await deleteItem(item.id);
								notifyStoreChanged();
							}}
							className="tap rounded-md bg-red-500/15 px-2 py-1 text-[10px] font-bold text-red-600 dark:text-red-400"
						>
							OK
						</button>
						<button
							type="button"
							onClick={() => setConfirmDelete(false)}
							className="tap rounded-md px-2 py-1 text-[10px] font-semibold"
							style={{
								background: 'var(--surface-2)',
								color: 'var(--text-muted)',
							}}
						>
							Non
						</button>
					</span>
				:	<button
						type="button"
						onClick={() => setConfirmDelete(true)}
						aria-label={`Retirer ${item.displayTitle} de ma liste`}
						className="tap flex w-8 shrink-0 items-center justify-center self-center rounded-md"
						style={{ color: 'var(--text-muted)' }}
					>
						<TrashIcon />
					</button>
				}
			</div>

			{expanded && <ItemDetails item={item} />}
		</li>
	);
}

function TrashIcon() {
	return (
		<svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
			<path
				d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13M10 11v6M14 11v6"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** Panneau d'edition : c'est ici que les overrides locaux se posent. */
function ItemDetails({ item }: { item: ReturnType<typeof resolveItem> }) {
	const total = item.overrides?.totalEpisodes ?? item.totalEpisodes ?? null;

	const save = async (patch: Parameters<typeof setOverrides>[1]) => {
		await setOverrides(item.id, patch);
		notifyStoreChanged();
	};

	const togglePlatform = async (id: PlatformId) => {
		const current = new Set(item.displayPlatforms);
		if (current.has(id)) current.delete(id);
		else current.add(id);
		await save({ platforms: [...current] });
	};

	return (
		<div
			className="space-y-4 border-t px-3 py-3"
			style={{ borderColor: 'var(--border)' }}
		>
			<Field label="Statut">
				<div className="flex flex-wrap gap-1.5">
					{(Object.keys(STATUS_LABEL) as WatchStatus[]).map(s => (
						<button
							key={s}
							type="button"
							onClick={async () => {
								await patchItem(item.id, { status: s });
								notifyStoreChanged();
							}}
							className="tap rounded-md border px-2.5 py-1 text-[11px] font-semibold"
							style={{
								borderColor:
									item.status === s ? 'var(--accent)' : 'var(--border)',
								color:
									item.status === s ?
										'var(--accent)'
									:	'var(--text-muted)',
							}}
						>
							{STATUS_LABEL[s]}
						</button>
					))}
				</div>
			</Field>

			<Field
				label="Plateformes"
				hint="Corrige ce que les APIs ont mal détecté — ton choix est prioritaire."
			>
				<div className="flex flex-wrap gap-1.5">
					{TRACKED_PLATFORMS.map(id => (
						<PlatformChip
							key={id}
							id={id}
							selected={item.displayPlatforms.includes(id)}
							onToggle={() => void togglePlatform(id)}
						/>
					))}
				</div>
			</Field>

			{/* Remplace les boutons + / − retires de la fiche : sans ce champ, la
          progression ne serait plus modifiable que depuis l'agenda, et seulement
          pour les episodes de la semaine affichee. */}
			<Field
				label="Dernier épisode vu"
				hint="0 signifie que tu n’as rien commencé. Les épisodes 1 à N sont marqués vus."
			>
				<div className="flex items-center gap-2">
					<input
						type="number"
						inputMode="numeric"
						min={0}
						max={total ?? undefined}
						defaultValue={item.progress}
						key={`progress-${item.progress}`}
						onBlur={async e => {
							const value = Number(e.target.value);
							if (!Number.isFinite(value) || value === item.progress)
								return;
							await setProgress(item.id, value);
							notifyStoreChanged();
						}}
						aria-label={`Dernier épisode vu de ${item.displayTitle}`}
						className="w-20 rounded-md border px-2.5 py-1.5 text-xs"
						style={{
							background: 'var(--surface)',
							borderColor: 'var(--border)',
						}}
					/>
					{total && (
						<span
							className="text-[11px]"
							style={{ color: 'var(--text-muted)' }}
						>
							sur {total}
						</span>
					)}
				</div>
			</Field>

			<Field label="Titre affiché">
				<input
					type="text"
					defaultValue={item.displayTitle}
					onBlur={e => {
						const value = e.target.value.trim();
						void save({ title: value === item.title ? undefined : value });
					}}
					className="w-full rounded-md border px-2.5 py-1.5 text-xs"
					style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
				/>
			</Field>

			{/* La suppression a quitte ce panneau : elle est desormais sur la fiche
          elle-meme, atteignable sans deplier. */}
			<div className="pt-1">
				<span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
					Source : {item.provider}
					{item.links?.betaseriesId ? ' #' + item.links.betaseriesId : ''}
				</span>
			</div>
		</div>
	);
}

function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<div>
			<p
				className="mb-1.5 text-[11px] font-bold uppercase tracking-wider"
				style={{ color: 'var(--text-muted)' }}
			>
				{label}
			</p>
			{children}
			{hint && (
				<p
					className="mt-1.5 text-[10px] leading-snug"
					style={{ color: 'var(--text-muted)' }}
				>
					{hint}
				</p>
			)}
		</div>
	);
}

// --------------------------------------------------------------------------

/** Creation d'une fiche que BetaSeries ne reference pas. */
export type { TrackedItem };

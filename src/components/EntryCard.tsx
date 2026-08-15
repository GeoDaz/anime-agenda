'use client';

import { PlatformBadges } from './PlatformBadge';
import { SubtypeTag } from './SubtypeTag';
import { PLATFORMS } from '@/lib/platforms';
import type { AiringEntry } from '@/lib/types';
import { formatTime } from '@/lib/week';

/**
 * Provenance de la date.
 *
 * BetaSeries ne fournit qu'une DATE, sans heure : l'agenda affiche donc des
 * jours. Le libelle reste utile pour distinguer une vraie date de diffusion
 * d'une estimation saisie a la main.
 */
const SOURCE_LABEL: Record<AiringEntry['source'], string> = {
	betaseries: 'BetaSeries',
};

export function EntryCard({
	entry,
	onToggleWatched,
}: {
	entry: AiringEntry;
	onToggleWatched: (entry: AiringEntry) => void;
}) {
	// Liseré de la couleur de la première plateforme : repère visuel au défilement.
	const accent = PLATFORMS[entry.platforms[0] ?? 'other'].color;
	const isPast = entry.airsAt < Date.now();

	return (
		<li
			className="flex items-stretch gap-0 overflow-hidden rounded-xl border transition-opacity"
			style={{
				background: 'var(--surface)',
				borderColor: 'var(--border)',
				opacity: entry.watched ? 0.55 : 1,
			}}
		>
			<span
				aria-hidden="true"
				className="w-1 shrink-0"
				style={{ background: accent }}
			/>

			{entry.coverUrl ?
				// eslint-disable-next-line @next/next/no-img-element -- images externes, export statique
				<img
					src={entry.coverUrl}
					alt=""
					loading="lazy"
					className="h-[75px] w-[51px] shrink-0 object-cover"
				/>
			:	<span
					aria-hidden="true"
					className="h-[75px] w-[51px] shrink-0"
					style={{ background: 'var(--surface-2)' }}
				/>
			}

			<div className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-3 py-2">
				<div className="flex items-baseline gap-2">
					<time
						className="shrink-0 text-sm font-bold tabular-nums"
						dateTime={new Date(entry.airsAt).toISOString()}
					>
						{formatTime(entry.airsAt)}
					</time>
					<p
						className={`flex min-w-0 flex-1 items-baseline gap-1.5 truncate text-sm font-semibold ${entry.watched ? 'line-through' : ''}`}
					>
						<span className="truncate">{entry.title}</span>
						<SubtypeTag subtype={entry.subtype} />
					</p>
				</div>

				<p className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>
					{entry.episode !== null ? `Ép. ${entry.episode}` : 'Nouvel épisode'}
					{entry.episodeTitle ? ` · ${entry.episodeTitle}` : ''}
					{' · '}
					{SOURCE_LABEL[entry.source]}
				</p>

				<div className="flex items-center gap-2">
					<PlatformBadges ids={entry.platforms} />
					{entry.url && (
						<a
							href={entry.url}
							target="_blank"
							rel="noreferrer"
							className="text-[10px] font-semibold underline decoration-dotted"
							style={{ color: 'var(--accent)' }}
						>
							Regarder
						</a>
					)}
				</div>
			</div>

			<button
				type="button"
				onClick={() => onToggleWatched(entry)}
				aria-pressed={entry.watched}
				aria-label={
					entry.watched ?
						`Marquer ${entry.title} épisode ${entry.episode} comme non vu`
					:	`Marquer ${entry.title} épisode ${entry.episode} comme vu`
				}
				className="tap flex w-12 shrink-0 items-center justify-center border-l"
				style={{
					borderColor: 'var(--border)',
					color:
						entry.watched ? '#16a34a'
						: isPast ? 'var(--text)'
						: 'var(--text-muted)',
				}}
			>
				{entry.watched ?
					<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
						<circle
							cx="12"
							cy="12"
							r="9"
							fill="currentColor"
							opacity="0.15"
						/>
						<path
							d="M8 12.5l2.5 2.5L16 9.5"
							fill="none"
							stroke="currentColor"
							strokeWidth="2.2"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				:	<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
						<circle
							cx="12"
							cy="12"
							r="9"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.6"
							strokeDasharray={isPast ? undefined : '3 3'}
						/>
					</svg>
				}
			</button>
		</li>
	);
}

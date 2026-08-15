'use client';

import { useEffect, useRef, useState } from 'react';
import { highResUrl } from '@/lib/images';
import { Spinner } from './Loaders';

/**
 * Affichage plein ecran d'une jaquette.
 *
 * Charge d'abord la version haute definition quand le provider en expose une, en
 * gardant la vignette visible pendant le telechargement plutot que d'afficher un
 * trou. Si la version HD echoue — un motif d'URL peut changer sans preavis — on
 * retombe silencieusement sur la vignette.
 */
export function CoverLightbox({
	src,
	title,
	onClose,
}: {
	src: string;
	title: string;
	onClose: () => void;
}) {
	const hires = highResUrl(src);
	const [loaded, setLoaded] = useState(false);
	const [useThumb, setUseThumb] = useState(!hires);
	const closeRef = useRef<HTMLButtonElement>(null);
	const restoreFocus = useRef<Element | null>(null);

	useEffect(() => {
		// On memorise le declencheur pour lui rendre le focus a la fermeture :
		// sans ca, le focus repart au debut du document et la navigation clavier
		// recommence depuis le haut de la liste.
		restoreFocus.current = document.activeElement;
		closeRef.current?.focus();

		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		};
		document.addEventListener('keydown', onKey);

		// Empeche le defilement de la page derriere la superposition.
		const previous = document.body.style.overflow;
		document.body.style.overflow = 'hidden';

		return () => {
			document.removeEventListener('keydown', onKey);
			document.body.style.overflow = previous;
			(restoreFocus.current as HTMLElement | null)?.focus?.();
		};
	}, [onClose]);

	const shown = useThumb ? src : (hires ?? src);

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label={`Jaquette de ${title}`}
			onClick={onClose}
			className="fixed inset-0 z-[60] flex flex-col items-center justify-center p-4"
			style={{ background: 'rgba(0,0,0,0.88)' }}
		>
			<button
				ref={closeRef}
				type="button"
				onClick={onClose}
				aria-label="Fermer"
				className="tap absolute right-3 top-3 flex h-10 w-10 items-center justify-center rounded-full text-white"
				style={{ background: 'rgba(255,255,255,0.15)' }}
			>
				<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
					<path
						d="M6 6l12 12M18 6L6 18"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
					/>
				</svg>
			</button>

			{/* Le clic sur l'image ne doit pas fermer : seul le fond et la croix le font. */}
			<div
				className="relative flex max-h-full flex-col items-center"
				onClick={e => e.stopPropagation()}
			>
				{!loaded && (
					<span className="absolute inset-0 flex items-center justify-center text-white">
						<Spinner size={28} label="Chargement de l’image" />
					</span>
				)}

				{/* eslint-disable-next-line @next/next/no-img-element -- images externes, export statique */}
				<img
					src={shown}
					alt={`Jaquette de ${title}`}
					onLoad={() => setLoaded(true)}
					onError={() => {
						// La variante HD n'existe pas : on repasse a la vignette.
						if (!useThumb) {
							setUseThumb(true);
							return;
						}
						setLoaded(true);
					}}
					className="max-h-[80vh] w-auto rounded-xl object-contain shadow-2xl"
					style={{
						opacity: loaded ? 1 : 0,
						transition: 'opacity 150ms ease-out',
					}}
				/>

				<p className="mt-3 max-w-[90vw] text-center text-xl font-medium text-white/90">
					{title}
				</p>
			</div>
		</div>
	);
}

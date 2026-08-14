'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useOnline } from '@/lib/useStore';

/**
 * Trois onglets seulement : l'ajout de series vit desormais dans Ma liste, ou il
 * est au plus pres de ce qu'il modifie.
 */
const TABS = [
  { href: '/', label: 'Semaine', icon: CalendarIcon },
  { href: '/bibliotheque/', label: 'Ma liste', icon: ListIcon },
  { href: '/import/', label: 'Import', icon: ImportIcon },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const online = useOnline();

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col">
      {!online && (
        <div className="sticky top-0 z-20 bg-amber-500/15 px-4 py-1.5 text-center text-xs font-medium text-amber-700 dark:text-amber-300">
          Hors ligne — affichage des dernières données enregistrées
        </div>
      )}

      <main className="flex-1 pb-24">{children}</main>

      <nav
        className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t backdrop-blur-lg"
        style={{
          background: 'color-mix(in srgb, var(--surface) 88%, transparent)',
          borderColor: 'var(--border)',
        }}
      >
        <ul className="mx-auto flex w-full max-w-4xl items-stretch">
          {TABS.map((tab) => {
            const active =
              tab.href === '/' ? pathname === '/' : pathname.startsWith(tab.href.replace(/\/$/, ''));
            const Icon = tab.icon;
            return (
              <li key={tab.href} className="flex-1">
                <Link
                  href={tab.href}
                  aria-current={active ? 'page' : undefined}
                  className="tap flex flex-col items-center gap-1 py-2 text-[11px] font-medium transition-colors"
                  style={{ color: active ? 'var(--accent)' : 'var(--text-muted)' }}
                >
                  <Icon active={active} />
                  {tab.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

/** En-tete de page reutilisable, avec un slot pour les actions. */
export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="pt-safe flex items-start justify-between gap-3 px-4 pb-3">
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && (
          <p className="mt-0.5 text-sm" style={{ color: 'var(--text-muted)' }}>
            {subtitle}
          </p>
        )}
      </div>
      {action}
    </header>
  );
}

// --- Icones inline : evite une dependance d'icones pour quatre glyphes. ---

type IconProps = { active?: boolean };
const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

function CalendarIcon({ active }: IconProps) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="3" {...stroke} />
      <path d="M3 10h18M8 3v4M16 3v4" {...stroke} />
      {active && <rect x="7" y="13" width="4" height="4" rx="1" fill="currentColor" />}
    </svg>
  );
}

function ListIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" {...stroke} />
    </svg>
  );
}

/** Fleche descendant vers un bac : import de liste, et non plus reglages. */
function ImportIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v11m0 0l-4-4m4 4l4-4" {...stroke} />
      <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" {...stroke} />
    </svg>
  );
}

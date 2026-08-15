'use client';

import { useRef, useState } from 'react';
import { PageHeader } from '@/components/AppShell';
import { buildLocalCatalog, clearCache, exportBackup, importBackup, type Backup } from '@/lib/db';
import { Spinner } from '@/components/Loaders';
import { BetaSeriesLogin } from '@/components/BetaSeriesLogin';
import { parseImport, type ImportCandidate } from '@/lib/importers';
import { notifyStoreChanged, useItems, useSession, useSettings } from '@/lib/useStore';
import { ImportMatcher } from '@/components/ImportMatcher';
import { ExportGuides } from '@/components/ExportGuides';
import { PlatformChip } from '@/components/PlatformBadge';
import { TRACKED_PLATFORMS } from '@/lib/platforms';
import type { PlatformId } from '@/lib/types';

export default function SettingsPage() {
  const { settings, update } = useSettings();
  const { items } = useItems();
  const { session, connected } = useSession();

  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  /** Contenu de la zone de texte, desormais soumis explicitement. */
  const [listText, setListText] = useState('');
  const hasListText = listText.trim().length > 0;
  // Plateforme d'origine de la liste : leve l'ambiguite anime / live-action
  // (un "One Piece" venant de Netflix est la serie de 2023, pas l'anime).
  const [importSource, setImportSource] = useState<PlatformId | null>('netflix');

  const backupInput = useRef<HTMLInputElement>(null);
  const listInput = useRef<HTMLInputElement>(null);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 4000);
  };

  // --- Sauvegarde ---
  const doExport = async () => {
    const backup = await exportBackup();
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agenda-anime-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    flash('Sauvegarde téléchargée.');
  };

  const doImportBackup = async (file: File) => {
    setBusy('backup');
    try {
      const parsed = JSON.parse(await file.text()) as Backup;
      if (!parsed || !Array.isArray(parsed.items)) throw new Error('Fichier non reconnu');
      const { imported, skipped } = await importBackup(parsed, 'merge');
      notifyStoreChanged();
      flash(`${imported} série(s) importée(s), ${skipped} déjà présente(s).`);
    } catch (e) {
      flash(`Échec : ${e instanceof Error ? e.message : 'fichier illisible'}`);
    } finally {
      setBusy(null);
    }
  };

  // --- Import de liste (CSV / texte / JSON) ---
  const doParseList = async (content: string) => {
    const parsed = parseImport(content);
    if (!parsed.length) {
      flash('Aucun titre détecté dans ce contenu.');
      return;
    }
    setCandidates(parsed);
  };

  /** Dump de developpement : titres + adresses d'images deja connus. */
  const doDumpCatalog = async () => {
    setBusy('dump');
    try {
      const catalog = await buildLocalCatalog();
      if (!catalog.length) {
        flash('Rien en cache pour l’instant — fais une recherche ou un import d’abord.');
        return;
      }
      const blob = new Blob([JSON.stringify(catalog, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `catalog-local-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      const withImage = catalog.filter((c) => c.imageUrl).length;
      flash(`${catalog.length} entrées exportées, ${withImage} avec image.`);
    } finally {
      setBusy(null);
    }
  };


  return (
    <>
      <PageHeader title="Import" subtitle="Récupérer ta liste, sauvegarder, régler" />

      {notice && (
        <p
          className="mx-4 mb-4 rounded-lg px-3 py-2 text-xs font-medium"
          style={{ background: 'color-mix(in srgb, var(--accent) 14%, transparent)', color: 'var(--accent)' }}
        >
          {notice}
        </p>
      )}

      <div className="space-y-6 px-4">
        {/* ---------------- Affichage ---------------- */}
        <Section title="Affichage">
          <Toggle
            label="Semaine commençant le lundi"
            checked={settings.weekStartsOnMonday}
            onChange={(v) => void update({ weekStartsOnMonday: v })}
          />
          <Toggle
            label="Masquer les épisodes déjà vus"
            hint="L’agenda ne montre que ce qu’il te reste à regarder."
            checked={settings.hideWatched}
            onChange={(v) => void update({ hideWatched: v })}
          />
        </Section>

        {/* ---------------- Compte BetaSeries ---------------- */}
        <Section
          title="Compte BetaSeries"
          hint="BetaSeries est desormais la source unique : ta liste, ta progression et ton planning vivent sur ton compte, donc tu retrouves la meme chose ici et sur leur site. La cle et le jeton restent sur cet appareil (IndexedDB) et ne partent jamais dans le bundle."
        >
          <BetaSeriesLogin />
        </Section>

        {/* ---------------- Import ---------------- */}
        <Section
          title="Importer une liste"
          hint="Colle une liste de titres, ou dépose un CSV — par exemple l’export Netflix (netflix.com/viewingactivity → « Tout télécharger »). Aucun identifiant n’est demandé : rien ne se connecte à tes comptes."
        >
          <div>
            <p className="mb-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
              Cette liste vient de :
            </p>
            <div className="no-scrollbar flex gap-2 overflow-x-auto pb-1">
              {TRACKED_PLATFORMS.map((id) => (
                <PlatformChip
                  key={id}
                  id={id}
                  selected={importSource === id}
                  onToggle={() => setImportSource(importSource === id ? null : id)}
                />
              ))}
            </div>
            <p className="mt-1 text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
              Sert à départager les homonymes : « One Piece » depuis Netflix désigne la série
              live-action de 2023, pas l’anime. La plateforme est aussi pré-remplie sur les fiches
              ajoutées.
            </p>
          </div>

          {/* Champ controle, sans declenchement au blur : perdre le focus n'est
              pas une intention de lancer une recherche de plusieurs minutes. */}
          <textarea
            value={listText}
            onChange={(e) => setListText(e.target.value)}
            placeholder={'Un titre par ligne…\nOne Piece\nFrieren\nArcane'}
            rows={4}
            className="w-full rounded-lg border px-3 py-2 text-sm"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!hasListText}
              onClick={() => void doParseList(listText)}
              className="tap rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed"
              style={{
                background: hasListText ? 'var(--accent)' : 'var(--surface-2)',
                color: hasListText ? '#fff' : 'var(--text-muted)',
                opacity: hasListText ? 1 : 0.6,
              }}
            >
              Lancer l’import
            </button>
            {/* Une seule action principale a la fois : des que la zone de texte est
                remplie, ce bouton cede la primaute et passe en contour. */}
            <button
              type="button"
              onClick={() => listInput.current?.click()}
              className="tap rounded-lg border px-3 py-2 text-xs font-semibold transition-colors"
              style={
                hasListText
                  ? {
                      background: 'transparent',
                      borderColor: 'var(--accent)',
                      color: 'var(--accent)',
                    }
                  : { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' }
              }
            >
              Déposer un fichier CSV / JSON
            </button>
            <input
              ref={listInput}
              type="file"
              accept=".csv,.txt,.json,text/csv,text/plain,application/json"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) await doParseList(await file.text());
                e.target.value = '';
              }}
            />
          </div>

          <div className="pt-1">
            <p
              className="mb-2 text-[11px] font-bold uppercase tracking-wider"
              style={{ color: 'var(--text-muted)' }}
            >
              Comment récupérer ma liste
            </p>
            <ExportGuides />
          </div>
        </Section>

        {/* ---------------- Sauvegarde ---------------- */}
        <Section
          title="Sauvegarde"
          hint="Tout est stocké sur ce téléphone. Exporte de temps en temps : c’est ta seule copie si tu changes d’appareil ou vides le cache du navigateur."
        >
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void doExport()}
              className="tap rounded-lg px-3 py-2 text-xs font-semibold"
              style={{ background: 'var(--surface-2)' }}
            >
              Exporter ({items?.length ?? 0} séries)
            </button>
            <button
              type="button"
              onClick={() => backupInput.current?.click()}
              disabled={busy === 'backup'}
              className="tap flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-50"
              style={{ background: 'var(--surface-2)' }}
            >
              {busy === 'backup' && <Spinner size={12} />}
              {busy === 'backup' ? 'Import…' : 'Importer une sauvegarde'}
            </button>
            <input
              ref={backupInput}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) await doImportBackup(file);
                e.target.value = '';
              }}
            />
          </div>
        </Section>

        {/* ---------------- Maintenance ---------------- */}
        <Section title="Maintenance">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={async () => {
                await clearCache();
                notifyStoreChanged();
                flash('Cache vidé, les dates seront rechargées.');
              }}
              className="tap rounded-lg px-3 py-2 text-xs font-semibold"
              style={{ background: 'var(--surface-2)' }}
            >
              Vider le cache des dates
            </button>
          </div>
        </Section>

        {/* ---------------- Developpement ----------------
            Retire du bundle de production : la condition est statique, donc le
            bloc est elimine a la compilation. */}
        {process.env.NODE_ENV === 'development' && (
          <Section
            title="Développement"
            hint="Un PWA ne peut pas écrire dans le dossier du projet : ce bouton produit un téléchargement. Pour générer les fichiers directement dans data/, utilise npm run dump."
          >
            <button
              type="button"
              onClick={() => void doDumpCatalog()}
              disabled={busy === 'dump'}
              className="tap flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-50"
              style={{ background: 'var(--surface-2)' }}
            >
              {busy === 'dump' && <Spinner size={12} />}
              {busy === 'dump' ? 'Extraction…' : 'Exporter le catalogue local (JSON)'}
            </button>
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Recycle tout ce que l’app a déjà mis en cache — titres, titres alternatifs et adresses
              d’images — sans aucune requête réseau.
            </p>
          </Section>
        )}

        {/* ---------------- Installation ---------------- */}
        <Section
          title="Installer sur l’écran d’accueil"
          hint="iPhone : bouton Partager, puis « Sur l’écran d’accueil ». Android : menu ⋮, puis « Installer l’application ». Ensuite l’app s’ouvre en plein écran et fonctionne hors connexion."
        >
          <div />
        </Section>

        <p className="pb-4 text-center text-[10px]" style={{ color: 'var(--text-muted)' }}>
          Données : BetaSeries.
        </p>
      </div>

      {candidates && (
        <ImportMatcher
          candidates={candidates}
          sourcePlatform={importSource}
          onClose={(added) => {
            setCandidates(null);
            if (added > 0) {
              notifyStoreChanged();
              flash(`${added} série(s) ajoutée(s).`);
              // Ce lot est traite : on vide la zone pour eviter un relancement
              // involontaire sur la meme liste.
              setListText('');
            }
          }}
        />
      )}
    </>
  );
}

// --------------------------------------------------------------------------

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        {title}
      </h2>
      {hint && (
        <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </p>
      )}
      {children}
    </section>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className="tap flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {hint && (
          <span className="mt-0.5 block text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {hint}
          </span>
        )}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className="relative h-6 w-10 shrink-0 rounded-full transition-colors"
        style={{ background: checked ? 'var(--accent)' : 'var(--border)' }}
      >
        <span
          className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform"
          style={{ transform: checked ? 'translateX(1.25rem)' : 'translateX(0.125rem)' }}
        />
      </span>
    </label>
  );
}

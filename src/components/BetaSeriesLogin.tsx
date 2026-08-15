'use client';

import { useState } from 'react';
import { login, logout, type BetaSeriesSession } from '@/lib/betaseries/session';
import { notifyStoreChanged, useSession } from '@/lib/useStore';
import { Spinner } from './Loaders';

/**
 * Formulaire de connexion BetaSeries, partage.
 *
 * Un seul exemplaire du formulaire pour la page Import et la fenetre de
 * connexion : dupliquer la logique d'authentification serait le meilleur moyen
 * de corriger un bug d'un cote seulement.
 *
 * Le mot de passe est hache en MD5 dans le navigateur (exigence de l'API),
 * envoye, puis oublie. Seul le jeton retourne est conserve, en IndexedDB.
 */
export function BetaSeriesLogin({
  onConnected,
  compact = false,
}: {
  onConnected?: (session: BetaSeriesSession) => void;
  compact?: boolean;
}) {
  const { session, connected } = useSession();

  const [apiKey, setApiKey] = useState(session.apiKey ?? '');
  const [loginName, setLoginName] = useState(session.login ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const field = 'w-full rounded-lg border px-3 py-2 text-sm';
  const fieldStyle = { background: 'var(--bg)', borderColor: 'var(--border)' };

  if (connected) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">
          Connecté{session.login ? ` : ${session.login}` : ''}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await logout(session);
              notifyStoreChanged();
            } finally {
              setBusy(false);
            }
          }}
          className="tap flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-60"
          style={{ background: 'var(--surface-2)' }}
        >
          {busy && <Spinner size={12} />}
          Se déconnecter
        </button>
        {!compact && (
          <p className="w-full text-[11px]" style={{ color: 'var(--text-muted)' }}>
            La déconnexion révoque le jeton côté BetaSeries.
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const next = await login(apiKey.trim(), loginName.trim(), password);
          notifyStoreChanged();
          // Le mot de passe ne survit pas a la soumission, meme en memoire.
          setPassword('');
          onConnected?.(next);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Connexion impossible');
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder="Clé d’API BetaSeries"
        autoComplete="off"
        required
        className={field}
        style={fieldStyle}
      />
      <input
        type="text"
        value={loginName}
        onChange={(e) => setLoginName(e.target.value)}
        placeholder="Identifiant ou e-mail"
        autoComplete="username"
        required
        className={field}
        style={fieldStyle}
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Mot de passe"
        autoComplete="current-password"
        required
        className={field}
        style={fieldStyle}
      />

      {error && (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-[11px] text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="tap flex w-full items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-semibold text-white disabled:opacity-60"
        style={{ background: 'var(--accent)' }}
      >
        {busy && <Spinner size={13} />}
        {busy ? 'Connexion…' : 'Se connecter'}
      </button>

      <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        Ton mot de passe est haché dans le navigateur, envoyé à BetaSeries, puis oublié : seul le
        jeton est conservé sur cet appareil.{' '}
        <a
          href="https://www.betaseries.com/api"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          Obtenir une clé
        </a>
      </p>
    </form>
  );
}

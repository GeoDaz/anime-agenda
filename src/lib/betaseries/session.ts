'use client';

import { getSettings, saveSettings } from '../db';
import { authenticate, memberInfos, request, type BetaSeriesCredentials } from './client';
import { md5 } from './md5';

/**
 * Session BetaSeries.
 *
 * Ou vivent les secrets, et pourquoi :
 *  - la cle d'API et le jeton sont dans IndexedDB, pas dans le bundle. En export
 *    statique, toute variable `NEXT_PUBLIC_*` est inlinee au build et donc
 *    publique sur le site deploye ; une variable sans ce prefixe n'existe pas
 *    dans le navigateur. IndexedDB est la seule place correcte.
 *  - le mot de passe n'est JAMAIS conserve. Il est hache en MD5 (exigence de
 *    l'API), envoye, et seul le jeton retourne est stocke.
 */

export interface BetaSeriesSession {
  apiKey: string | null;
  token: string | null;
  login: string | null;
  memberId: number | null;
}

export const EMPTY_SESSION: BetaSeriesSession = {
  apiKey: null,
  token: null,
  login: null,
  memberId: null,
};

export async function loadSession(): Promise<BetaSeriesSession> {
  const s = await getSettings();
  return {
    apiKey: s.betaseriesApiKey ?? null,
    token: s.betaseriesToken ?? null,
    login: s.betaseriesLogin ?? null,
    memberId: s.betaseriesMemberId ?? null,
  };
}

export async function saveSession(patch: Partial<BetaSeriesSession>): Promise<BetaSeriesSession> {
  await saveSettings({
    ...(patch.apiKey !== undefined ? { betaseriesApiKey: patch.apiKey } : {}),
    ...(patch.token !== undefined ? { betaseriesToken: patch.token } : {}),
    ...(patch.login !== undefined ? { betaseriesLogin: patch.login } : {}),
    ...(patch.memberId !== undefined ? { betaseriesMemberId: patch.memberId } : {}),
  });
  return loadSession();
}

/** Credentials utilisables par le client, ou `null` si la cle manque. */
export function credentialsOf(session: BetaSeriesSession): BetaSeriesCredentials | null {
  if (!session.apiKey) return null;
  return { apiKey: session.apiKey, token: session.token };
}

export function isConnected(session: BetaSeriesSession): boolean {
  return Boolean(session.apiKey && session.token);
}

/**
 * Connexion. Le mot de passe est hache ici et n'est ni stocke ni journalise.
 *
 * L'API exige un MD5 : envoyer le mot de passe en clair renvoie
 * « 4003 Mot de passe incorrect », un message trompeur qui laisse croire a une
 * erreur d'identifiant.
 */
export async function login(
  apiKey: string,
  loginName: string,
  password: string
): Promise<BetaSeriesSession> {
  const res = await authenticate(apiKey, loginName, md5(password));
  return saveSession({
    apiKey,
    token: res.token,
    login: res.user?.login ?? loginName,
    memberId: res.user?.id ?? null,
  });
}

/**
 * Verifie qu'un jeton stocke est toujours valide.
 * `/members/is_active` est fait pour ca et n'a aucun effet de bord.
 */
export async function isTokenActive(session: BetaSeriesSession): Promise<boolean> {
  const creds = credentialsOf(session);
  if (!creds?.token) return false;
  try {
    await request('GET', '/members/is_active', creds);
    return true;
  } catch {
    return false;
  }
}

/** Deconnexion : le jeton est revoque cote serveur, puis efface localement. */
export async function logout(session: BetaSeriesSession): Promise<BetaSeriesSession> {
  const creds = credentialsOf(session);
  if (creds?.token) {
    try {
      await request('POST', '/members/destroy', creds);
    } catch {
      // Jeton deja invalide : on efface quand meme cote local.
    }
  }
  return saveSession({ token: null, memberId: null });
}

/** Profil du membre connecte, pour l'affichage. */
export async function fetchMember(session: BetaSeriesSession) {
  const creds = credentialsOf(session);
  if (!creds?.token) return null;
  try {
    const res = await memberInfos(creds);
    return res.member;
  } catch {
    return null;
  }
}

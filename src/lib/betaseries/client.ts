/**
 * Transport BetaSeries.
 *
 * Pourquoi cette API rend la surcouche possible, la ou Crunchyroll et Netflix ne
 * le permettaient pas — mesure le 2026-08-14 :
 *
 *   Access-Control-Allow-Origin: *                       sur toutes les reponses
 *   Preflight OPTIONS -> 200
 *   Access-Control-Allow-Headers: ... X-BetaSeries-Token ...
 *
 * La presence de `X-BetaSeries-Token` dans les en-tetes autorises signifie que
 * les appels AUTHENTIFIES sont explicitement prevus depuis un navigateur. On peut
 * donc se connecter, lire et ecrire sur le compte du membre sans backend, en
 * conservant `output: 'export'`.
 *
 * Contrat repris de la spec OpenAPI officielle (developers.betaseries.com/openapi.json,
 * v3.0, 165 chemins). Les schemas de securite y sont declares ainsi :
 *   BetaSeriesApiKey  -> en-tete X-BetaSeries-Key
 *   BetaSeriesToken   -> en-tete X-BetaSeries-Token
 *
 * Attention : cette spec ne declare quasiment aucun schema de REPONSE. Les
 * formes de donnees doivent donc etre verifiees avec une vraie cle plutot que
 * supposees — cf. scripts/probe-betaseries.mjs.
 */

import type {
  BsAuthResponse,
  BsEnvelope,
  BsEpisodesToWatchResponse,
  BsMemberResponse,
  BsPlanningResponse,
  BsPlatformsResponse,
  BsShowEpisodesResponse,
  BsShowResponse,
  BsShowsResponse,
} from './types';

const BASE = 'https://api.betaseries.com';

/** La version est exigee par l'API ; elle fige le format des reponses. */
const API_VERSION = '3.0';

/** Code d'erreur renvoye quand la cle est absente ou invalide. */
const ERROR_BAD_KEY = 1001;

export interface BetaSeriesCredentials {
  /** Cle d'application, obtenue sur betaseries.com/api. */
  apiKey: string;
  /** Jeton de session du membre, obtenu via POST /members/auth. */
  token?: string | null;
}

export interface BetaSeriesApiError {
  code: number;
  text: string;
}

/**
 * Erreur d'API typee.
 *
 * `badKey` est isole parce que c'est la panne de configuration la plus probable,
 * et qu'elle merite un message d'aide plutot qu'un code brut.
 */
export class BetaSeriesError extends Error {
  readonly status: number;
  readonly errors: BetaSeriesApiError[];

  constructor(status: number, errors: BetaSeriesApiError[]) {
    const first = errors[0];
    super(first ? `BetaSeries ${first.code} : ${first.text}` : `BetaSeries ${status}`);
    this.name = 'BetaSeriesError';
    this.status = status;
    this.errors = errors;
  }

  get badKey(): boolean {
    return this.errors.some((e) => e.code === ERROR_BAD_KEY);
  }

  /** Jeton absent, expire ou revoque : il faut se reconnecter. */
  get needsAuth(): boolean {
    return this.status === 400 && this.errors.some((e) => /token/i.test(e.text));
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

function buildUrl(path: string, query?: Query): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, BASE);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === null || v === undefined || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/**
 * Appel brut. Renvoie la charge utile telle quelle : le typage precis se fera
 * endpoint par endpoint, une fois les formes reelles observees.
 */
export async function request<T = unknown>(
  method: 'GET' | 'POST' | 'DELETE' | 'PUT',
  path: string,
  creds: BetaSeriesCredentials,
  options: { query?: Query; body?: Query } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    'X-BetaSeries-Version': API_VERSION,
    'X-BetaSeries-Key': creds.apiKey,
    Accept: 'application/json',
  };
  if (creds.token) headers['X-BetaSeries-Token'] = creds.token;

  let body: string | undefined;
  if (options.body) {
    // L'API attend un formulaire, pas du JSON, sur les ecritures.
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(options.body)) {
      if (v === null || v === undefined || v === '') continue;
      form.set(k, String(v));
    }
    body = form.toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  const res = await fetch(buildUrl(path, options.query), { method, headers, body });

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    throw new BetaSeriesError(res.status, [
      { code: -1, text: 'Réponse illisible (JSON attendu)' },
    ]);
  }

  const errors = (payload as { errors?: BetaSeriesApiError[] })?.errors;
  // L'API renvoie un tableau `errors` vide en cas de succes : seul un tableau
  // non vide signale un probleme, y compris sur un statut 200.
  if (Array.isArray(errors) && errors.length > 0) {
    throw new BetaSeriesError(res.status, errors);
  }
  if (!res.ok) {
    throw new BetaSeriesError(res.status, [{ code: res.status, text: res.statusText }]);
  }

  return payload as T;
}

// --------------------------------------------------------------------------
// Endpoints, repris tels quels de la spec OpenAPI v3.0.
// Les paramametres marques d'une etoile dans la spec sont requis.
// --------------------------------------------------------------------------

/**
 * Connexion du membre. Le mot de passe part directement chez BetaSeries en
 * HTTPS et n'est jamais conserve : seul le jeton retourne est stocke.
 */
export function authenticate(apiKey: string, login: string, password: string) {
  return request<BsAuthResponse>('POST', '/members/auth', { apiKey }, {
    body: { login, password },
  });
}

/** Informations du membre connecte. Sert aussi a valider un jeton. */
export function memberInfos(creds: BetaSeriesCredentials, id?: number) {
  return request<BsMemberResponse>('GET', '/members/infos', creds, { query: { id } });
}

/**
 * Recherche de series. La spec precise « with member information if a token is
 * provided » : en passant le jeton, on sait directement ce qui est deja suivi.
 */
export function searchShows(
  creds: BetaSeriesCredentials,
  params: { title: string; platforms?: string; country?: string; nbpp?: number; page?: number }
) {
  return request<BsShowsResponse>('GET', '/shows/search', creds, { query: params });
}

export function showDisplay(creds: BetaSeriesCredentials, id: number) {
  return request<BsShowResponse>('GET', '/shows/display', creds, { query: { id } });
}

export function showEpisodes(
  creds: BetaSeriesCredentials,
  params: { id: number; season?: number; episode?: number }
) {
  return request<BsShowEpisodesResponse>('GET', '/shows/episodes', creds, { query: params });
}

/** Ajoute une serie au compte du membre. C'est le « sauvegarder dessus ». */
export function addShow(creds: BetaSeriesCredentials, id: number) {
  return request<BsEnvelope>('POST', '/shows/show', creds, { body: { id } });
}

export function removeShow(creds: BetaSeriesCredentials, id: number) {
  return request<BsEnvelope>('DELETE', '/shows/show', creds, { query: { id } });
}

/**
 * Planning du membre : c'est la source du calendrier.
 * `unseen` limite aux episodes non vus, `month` cible un mois (`YYYY-MM`).
 */
export function memberPlanning(
  creds: BetaSeriesCredentials,
  params: { month?: string; unseen?: boolean; id?: number } = {}
) {
  return request<BsPlanningResponse>('GET', '/planning/member', creds, {
    query: { month: params.month, unseen: params.unseen ? 1 : undefined, id: params.id },
  });
}

/** Planning general, sans compte : utile avant connexion. */
export function generalPlanning(
  creds: BetaSeriesCredentials,
  params: { date?: string; before?: number; after?: number } = {}
) {
  return request<BsPlanningResponse>('GET', '/planning/general', creds, { query: params });
}

/** Episodes restant a voir, filtrables par plateforme. */
export function episodesToWatch(
  creds: BetaSeriesCredentials,
  params: { limit?: number; showId?: number; platforms?: string } = {}
) {
  return request<BsEpisodesToWatchResponse>('GET', '/episodes/list', creds, { query: params });
}

export function markWatched(
  creds: BetaSeriesCredentials,
  params: { id: number; bulk?: boolean; date?: string }
) {
  return request<BsEnvelope>('POST', '/episodes/watched', creds, {
    body: { id: params.id, bulk: params.bulk ? 1 : undefined, date: params.date },
  });
}

export function unmarkWatched(creds: BetaSeriesCredentials, id: number) {
  return request<BsEnvelope>('DELETE', '/episodes/watched', creds, { query: { id } });
}

/** Plateformes SVOD/VOD disponibles dans un pays. Remplace notre table locale. */
export function platformsList(creds: BetaSeriesCredentials, country = 'FR') {
  return request<BsPlatformsResponse>('GET', '/platforms/list', creds, { query: { country } });
}

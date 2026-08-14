import { cacheGet, cacheSet } from '../db';

/**
 * Traduction de titres francais vers l'anglais, sans aucune cle d'API.
 *
 * Pourquoi c'est necessaire : les exports Netflix francais contiennent des
 * titres traduits que les bases internationales ignorent. Mesure sur un export
 * reel — AniList ne rapproche que 5 titres sur 48, parce qu'il ne stocke aucun
 * libelle francais.
 *
 * Deux sources, volontairement combinees car elles echouent sur des cas
 * differents (verifie) :
 *
 *   "La Reine Charlotte"       Wikidata OK  -> Queen Charlotte: A Bridgerton Story
 *                              Wikipedia KO -> trouve la personne historique
 *   "Mercredi"                 Wikidata KO  -> Q128, le jour de la semaine
 *                              Wikipedia OK -> Wednesday
 *
 * L'identifiant TVmaze de Wikidata (P6113) aurait evite ce detour par les
 * titres, mais il est quasiment jamais renseigne (0 sur 8 series testees).
 *
 * Les deux APIs acceptent `origin=*` donc fonctionnent depuis le navigateur.
 * Wikimedia demande un User-Agent descriptif ; un navigateur ne pouvant pas le
 * definir, on envoie `Api-User-Agent`, que Wikimedia accepte pour cet usage.
 */

const UA = 'AgendaAnime/0.1 (PWA perso, agenda de sorties)';
const WIKI_HEADERS: HeadersInit = { 'Api-User-Agent': UA, Accept: 'application/json' };

/** Les titres ne changent pas : on peut cacher tres longtemps. */
const TTL = 30 * 24 * 60 * 60 * 1000;

/** Types Wikidata acceptes (P31) : serie TV, serie animee, mini-serie, ONA... */
const SERIES_TYPES = new Set([
  'Q5398426', // serie televisee
  'Q63952888', // serie animee
  'Q1259759', // mini-serie
  'Q581714', // serie d'animation televisee
  'Q117467246', // serie animee originale en streaming
  'Q220898', // ONA
  'Q11086742', // serie televisee japonaise animee
]);

/**
 * Retire le suffixe de desambiguisation des titres Wikipedia/Wikidata.
 * "The Diplomat (American TV series)" -> "The Diplomat", sans quoi la recherche
 * en aval ne trouve rien (verifie).
 */
export function stripDisambiguation(title: string): string {
  return title.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * File sequentielle : Wikimedia limite au burst, pas seulement au debit moyen.
 * Deux requetes simultanees suffisent a declencher un 429, donc on serialise.
 */
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const next = chain.then(task, task);
  // On ignore l'erreur ici pour ne pas rompre la chaine des appels suivants.
  chain = next.catch(() => undefined);
  return next;
}

const MIN_GAP_MS = 350;
let lastCall = 0;

/**
 * Appel Wikimedia avec respect du debit et reprise sur 429.
 *
 * Necessaire, et mesure : en enchainant les traductions sans pause, Wikimedia
 * repond `429 You are making too many requests to the API` en texte brut. Sans
 * cette gestion, la traduction echouait silencieusement et la serie apparaissait
 * comme introuvable — exactement le genre de faux negatif qu'on veut eviter.
 */
/** Resultat brut d'une tentative : `throttled` distingue le 429 d'un vrai echec. */
type Attempt<T> = { ok: true; data: T | null } | { ok: false; throttled: boolean; retryAfterMs: number };

/**
 * Une seule tentative, serialisee et espacee. Volontairement separee de la
 * boucle de reprise : appeler la file depuis l'interieur d'une de ses taches
 * attendrait cette tache elle-meme, donc un interblocage.
 */
function attemptOnce<T>(url: string): Promise<Attempt<T>> {
  return serialize(async () => {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastCall));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    try {
      const r = await fetch(url, { headers: WIKI_HEADERS });
      lastCall = Date.now();

      const retryAfter = Number(r.headers.get('retry-after'));
      const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;

      if (r.status === 429) return { ok: false, throttled: true, retryAfterMs };
      if (!r.ok) return { ok: false, throttled: false, retryAfterMs: 0 };

      const text = await r.text();
      // Wikimedia repond en texte brut quand il limite le debit.
      if (!text.startsWith('{') && !text.startsWith('[')) {
        return { ok: false, throttled: true, retryAfterMs };
      }
      return { ok: true, data: JSON.parse(text) as T };
    } catch {
      lastCall = Date.now();
      return { ok: false, throttled: false, retryAfterMs: 0 };
    }
  });
}

/**
 * Appel Wikimedia avec reprise sur limitation de debit.
 *
 * Mesure : en enchainant les traductions sans pause, Wikimedia repond
 * `429 You are making too many requests to the API` en texte brut. Sans cette
 * gestion, la traduction echouait silencieusement et la serie apparaissait comme
 * introuvable — exactement le faux negatif qu'on veut eviter.
 */
async function json<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt <= 2; attempt++) {
    const res = await attemptOnce<T>(url);
    if (res.ok) return res.data;
    if (!res.throttled) return null;
    if (attempt === 2) return null;
    await new Promise((r) => setTimeout(r, res.retryAfterMs || 1500 * 2 ** attempt));
  }
  return null;
}

// --------------------------------------------------------------------------

interface WdSearch {
  search?: { id: string }[];
}

interface WdEntities {
  entities?: Record<
    string,
    {
      labels?: Record<string, { value: string }>;
      claims?: Record<string, { mainsnak?: { datavalue?: { value?: unknown } } }[]>;
    }
  >;
}

/** Libelle anglais via Wikidata, en privilegiant les entites de type serie. */
async function viaWikidata(frTitle: string): Promise<string | null> {
  const search = await json<WdSearch>(
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(
      frTitle
    )}&language=fr&uselang=fr&type=item&limit=6&format=json&origin=*`
  );
  const ids = (search?.search ?? []).map((s) => s.id);
  if (!ids.length) return null;

  const entities = await json<WdEntities>(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.join(
      '|'
    )}&props=labels|claims&languages=en&format=json&origin=*`
  );
  if (!entities?.entities) return null;

  let fallback: string | null = null;

  for (const id of ids) {
    const ent = entities.entities[id];
    if (!ent) continue;
    const en = ent.labels?.en?.value ?? null;
    if (!en) continue;

    const p31 = (ent.claims?.P31 ?? [])
      .map((c) => (c.mainsnak?.datavalue?.value as { id?: string } | undefined)?.id)
      .filter((v): v is string => typeof v === 'string');

    // Une entite typee "serie" est bien plus fiable : c'est ce qui evite de
    // traduire "Mercredi" par le jour de la semaine.
    if (p31.some((v) => SERIES_TYPES.has(v))) return en;
    if (!fallback) fallback = en;
  }
  return fallback;
}

interface WpSearch {
  query?: { search?: { title: string }[] };
}

interface WpLangLinks {
  query?: { pages?: Record<string, { langlinks?: { '*': string }[] }> };
}

/** Libelle anglais via l'article Wikipedia FR et son lien interlangue. */
async function viaWikipedia(frTitle: string): Promise<string | null> {
  const search = await json<WpSearch>(
    `https://fr.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      frTitle
    )}&srlimit=1&format=json&origin=*`
  );
  const page = search?.query?.search?.[0]?.title;
  if (!page) return null;

  const links = await json<WpLangLinks>(
    `https://fr.wikipedia.org/w/api.php?action=query&prop=langlinks&lllang=en&titles=${encodeURIComponent(
      page
    )}&format=json&origin=*`
  );
  const first = Object.values(links?.query?.pages ?? {})[0];
  return first?.langlinks?.[0]?.['*'] ?? null;
}

/**
 * Titres anglais candidats pour un titre francais, du plus fiable au moins.
 * Renvoie une liste car les deux sources se completent et on preferera
 * confronter chaque candidat au catalogue en aval.
 */
export async function translateToEnglish(frTitle: string): Promise<string[]> {
  const cacheKey = `titles:fr-en:${frTitle.toLowerCase()}`;
  const cached = await cacheGet<string[]>(cacheKey);
  if (cached) return cached;

  const [wd, wp] = await Promise.all([viaWikidata(frTitle), viaWikipedia(frTitle)]);

  const out: string[] = [];
  for (const raw of [wd, wp]) {
    if (!raw) continue;
    const clean = stripDisambiguation(raw);
    if (!clean) continue;
    // Inutile de proposer une "traduction" identique au titre d'origine.
    if (clean.toLowerCase() === frTitle.toLowerCase()) continue;
    if (!out.includes(clean)) out.push(clean);
  }

  await cacheSet(cacheKey, out, TTL);
  return out;
}

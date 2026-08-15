/**
 * Decouverte des formes de reponse BetaSeries.
 *
 * La spec OpenAPI officielle declare les chemins et les parametres, mais
 * pratiquement aucun schema de REPONSE. Impossible donc de typer le client sans
 * observer de vraies reponses — et ce script sert exactement a ca.
 *
 *   node scripts/probe-betaseries.mjs --key=TA_CLE
 *   node scripts/probe-betaseries.mjs --key=TA_CLE --login=pseudo --password=xxx
 *
 * Sans login, seuls les endpoints publics sont sondes : c'est deja suffisant pour
 * la recherche, les episodes et le planning general. Le mot de passe, s'il est
 * fourni, part uniquement chez BetaSeries en HTTPS ; le script n'ecrit ni ne
 * conserve aucun identifiant, il n'affiche que le jeton tronque.
 *
 * Sortie : data/betaseries-shapes.json, la liste des champs observes par
 * endpoint, a partir de laquelle typer le client proprement.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '..', 'data');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).replace(/^["']|["']$/g, '') : null;
};

/*
 * La cle est lue depuis l'environnement en priorite, pour qu'elle n'apparaisse
 * dans aucune ligne de commande ni dans un historique de shell :
 *
 *   node --env-file=.env scripts/probe-betaseries.mjs
 *
 * L'argument --key= reste accepte en secours.
 */
const KEY = process.env.BETA_SERIES_API_KEY ?? process.env.BETASERIES_API_KEY ?? arg('key');
const LOGIN = process.env.BETA_SERIES_LOGIN ?? arg('login');
const PASSWORD = process.env.BETA_SERIES_PASSWORD ?? arg('password');

if (!KEY) {
  console.error(
    "\nIl manque la cle d'API.\n\n" +
      '  node --env-file=.env scripts/probe-betaseries.mjs\n' +
      '    (attend BETA_SERIES_API_KEY dans .env)\n\n' +
      '  ou : node scripts/probe-betaseries.mjs --key=TA_CLE\n\n' +
      'La cle se cree sur https://www.betaseries.com/api (compte BetaSeries requis).\n'
  );
  process.exit(1);
}

const BASE = 'https://api.betaseries.com';
let token = null;

async function call(method, path, { query, body } = {}) {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers = {
    'X-BetaSeries-Version': '3.0',
    'X-BetaSeries-Key': KEY,
    Accept: 'application/json',
  };
  if (token) headers['X-BetaSeries-Token'] = token;

  let payload;
  if (body) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) if (v != null) form.set(k, String(v));
    payload = form.toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  const r = await fetch(url, { method, headers, body: payload });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* laisse json a null */
  }
  return { status: r.status, json, raw: text.slice(0, 200) };
}

/** Decrit la forme d'une valeur, sans en divulguer le contenu. */
function shape(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (!value.length) return 'array(vide)';
    return depth > 2 ? 'array' : { '[]': shape(value[0], depth + 1) };
  }
  if (typeof value === 'object') {
    if (depth > 2) return 'object';
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = shape(v, depth + 1);
    return out;
  }
  return typeof value;
}

const results = {};

async function probe(label, method, path, opts) {
  const res = await call(method, path, opts);
  const err = res.json?.errors?.[0];
  const status = err ? `${res.status} ERREUR ${err.code} ${err.text}` : String(res.status);
  console.log(`\n--- ${label}  [${method} ${path}]  -> ${status}`);
  if (err) {
    results[label] = { error: err };
    return null;
  }
  const body = res.json ?? res.raw;
  const s = shape(body);
  results[label] = { status: res.status, shape: s };
  console.log('   ' + JSON.stringify(s, null, 1).split('\n').slice(0, 26).join('\n   '));
  return body;
}

console.log('=== Endpoints publics (cle seule) ===');
await probe('platforms/list', 'GET', '/platforms/list', { query: { country: 'FR' } });
const search = await probe('shows/search', 'GET', '/shows/search', {
  query: { title: 'one piece', nbpp: 2 },
});
await probe('planning/general', 'GET', '/planning/general', { query: { date: 'today' } });

// Un identifiant reel permet de sonder les endpoints qui en dependent.
const showId =
  search?.shows?.[0]?.id ?? search?.shows?.[0]?.thetvdb_id ?? null;
if (showId) {
  console.log(`\n(id de serie observe : ${showId})`);
  await probe('shows/display', 'GET', '/shows/display', { query: { id: showId } });
  await probe('shows/episodes', 'GET', '/shows/episodes', { query: { id: showId, season: 1 } });
} else {
  console.log('\n(aucun id de serie exploitable : shows/display et shows/episodes non sondes)');
}

if (LOGIN && PASSWORD) {
  console.log('\n=== Connexion ===');
  /*
   * L'API attend le mot de passe en MD5, pas en clair : la spec le precise
   * (« MD5 encrypted password »). Envoyer le mot de passe brut renvoie
   * « 4003 Mot de passe incorrect », ce qui laisse croire a tort que
   * l'identifiant est mauvais.
   */
  const hashed = createHash('md5').update(PASSWORD, 'utf8').digest('hex');
  console.log(`  mot de passe hache en MD5 (${hashed.length} caracteres hex)`);
  const auth = await probe('members/auth', 'POST', '/members/auth', {
    body: { login: LOGIN, password: hashed },
  });
  token = auth?.token ?? auth?.user?.token ?? null;
  if (!token) {
    console.log('  aucun jeton trouve dans la reponse : voir la forme ci-dessus.');
  } else {
    console.log(`  jeton obtenu : ${String(token).slice(0, 6)}… (non conserve)`);
    console.log('\n=== Endpoints authentifies ===');
    await probe('members/infos', 'GET', '/members/infos');
    await probe('planning/member', 'GET', '/planning/member', { query: { unseen: 1 } });
    await probe('episodes/list', 'GET', '/episodes/list', { query: { limit: 3 } });
  }
} else {
  console.log('\n(pas de login fourni : endpoints authentifies non sondes)');
}

await mkdir(OUT, { recursive: true });
const path = resolve(OUT, 'betaseries-shapes.json');
await writeFile(path, JSON.stringify(results, null, 2), 'utf8');
console.log(`\nFormes observees ecrites dans ${path}`);
console.log('Aucun identifiant n a ete enregistre.');

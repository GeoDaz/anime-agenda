/**
 * Constitue des copies locales JSON du catalogue : titres + adresse de l'image.
 *
 * Pourquoi un script Node et pas l'app : un PWA n'a aucun acces en ecriture au
 * dossier du projet. Le navigateur peut seulement proposer un telechargement.
 * Ce script, lui, ecrit directement dans `data/`.
 *
 * A quoi ca sert en developpement : eviter de rappeler les APIs a chaque test,
 * disposer d'un jeu de donnees stable, et pouvoir travailler hors ligne.
 *
 *   npm run dump                      # tout, avec des plafonds raisonnables
 *   npm run dump -- --adn             # seulement le catalogue ADN
 *   npm run dump -- --anilist --pages=6
 *   npm run dump -- --from="C:/.../NetflixViewingHistory.csv"
 *   npm run dump -- --tvmaze-index --pages=4
 *
 * Sortie dans `data/` (ignore par git) :
 *   adn.json  anilist.json  tvmaze.json  catalog.json
 *
 * `catalog.json` est la fusion normalisee des trois, dedupliquee.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, '..', 'data');

// ---------------------------------------------------------------- arguments
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const raw = hit.slice(name.length + 3);
  return raw.replace(/^["']|["']$/g, '');
};

const PAGES = Number(value('pages', '4'));
const FROM_CSV = value('from', null);
const ONLY_ADN = has('--adn');
const ONLY_ANILIST = has('--anilist');
const ONLY_TVMAZE = has('--tvmaze') || has('--tvmaze-index');
const TVMAZE_INDEX = has('--tvmaze-index');
const RUN_ALL = !ONLY_ADN && !ONLY_ANILIST && !ONLY_TVMAZE;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
  if (!r.ok) throw new Error(`${r.status} sur ${url}`);
  return r.json();
}

// ---------------------------------------------------------------------- ADN
/** Catalogue ADN complet : ~580 series, `limit` plafonne a 100, pagination par offset. */
async function dumpAdn() {
  const BASE = 'https://gw.api.animationdigitalnetwork.com';
  const H = { 'X-Target-Distribution': 'fr' };

  const first = await getJson(`${BASE}/show/catalog?limit=100&offset=0`, H);
  const total = first.total ?? 0;
  const shows = [...(first.shows ?? [])];

  for (let offset = 100; offset < total; offset += 100) {
    const page = await getJson(`${BASE}/show/catalog?limit=100&offset=${offset}`, H);
    shows.push(...(page.shows ?? []));
    process.stdout.write(`\r  ADN ${shows.length}/${total}`);
    await sleep(150);
  }
  process.stdout.write('\n');

  return shows.map((s) => ({
    provider: 'adn',
    id: s.id,
    // ADN distingue les films des series par son champ `type`.
    kind: s.type === 'MOV' ? 'film' : 'anime',
    title: s.title,
    altTitles: [s.originalTitle, s.shortTitle].filter(Boolean),
    imageUrl: s.image2x ?? s.image ?? null,
    imageHorizontalUrl: s.imageHorizontal2x ?? s.imageHorizontal ?? null,
    // `firstReleaseYear` est expose par l'API mais toujours null sur l'endpoint
    // de liste : il n'est renseigne que sur la fiche detaillee. On le garde pour
    // le jour ou ca changerait, sans compter dessus.
    year: s.firstReleaseYear ? Number(s.firstReleaseYear) : null,
    episodeCount: s.episodeCount || null,
    genres: s.genres ?? [],
    country: s.countryOfOrigin ?? null,
    studio: s.productionStudio ?? null,
    simulcast: !!s.simulcast,
    url: s.url ?? null,
  }));
}

// ------------------------------------------------------------------ AniList
const ANILIST_FIELDS = `
  id
  title { romaji english native }
  coverImage { large extraLarge }
  bannerImage
  format
  episodes
  seasonYear
  status
`;

/** Animes et films d'animation, tries par popularite. 50 par page. */
async function dumpAniList(pages) {
  const out = [];

  for (const format of ['TV', 'TV_SHORT', 'MOVIE', 'ONA', 'OVA']) {
    for (let page = 1; page <= pages; page++) {
      const query = `query ($page: Int, $format: MediaFormat) {
        Page(page: $page, perPage: 50) {
          pageInfo { hasNextPage }
          media(type: ANIME, format: $format, sort: POPULARITY_DESC, isAdult: false) { ${ANILIST_FIELDS} }
        }
      }`;
      const r = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { page, format } }),
      });
      if (r.status === 429) {
        const wait = Number(r.headers.get('retry-after') ?? 60);
        process.stdout.write(`\n  quota AniList, pause ${wait}s\n`);
        await sleep(wait * 1000);
        page--;
        continue;
      }
      const j = await r.json();
      if (j.errors) throw new Error(j.errors[0].message);

      for (const m of j.data.Page.media) {
        out.push({
          provider: 'anilist',
          id: m.id,
          kind: m.format === 'MOVIE' ? 'film' : 'anime',
          title: m.title.romaji ?? m.title.english ?? m.title.native,
          altTitles: [m.title.english, m.title.native, m.title.romaji].filter(Boolean),
          imageUrl: m.coverImage?.extraLarge ?? m.coverImage?.large ?? null,
          bannerUrl: m.bannerImage ?? null,
          year: m.seasonYear ?? null,
          episodeCount: m.episodes ?? null,
          format: m.format,
          status: m.status,
        });
      }
      process.stdout.write(`\r  AniList ${format} page ${page} — ${out.length} entrees`);
      if (!j.data.Page.pageInfo.hasNextPage) break;
      // Quota mesure : 30 requetes/minute. 2,2 s tient a ~27/min.
      await sleep(2200);
    }
    process.stdout.write('\n');
  }
  return out;
}

// ------------------------------------------------------------------- TVmaze
function toTvmazeEntry(s) {
  return {
    provider: 'tvmaze',
    id: s.id,
    kind: (s.type ?? '').toLowerCase() === 'animation' && (s.language ?? '') === 'Japanese' ? 'anime' : 'serie',
    title: s.name,
    altTitles: [],
    imageUrl: s.image?.original ?? s.image?.medium ?? null,
    year: s.premiered ? Number(s.premiered.slice(0, 4)) : null,
    platform: s.webChannel?.name ?? s.network?.name ?? null,
    status: s.status ?? null,
    url: s.url ?? null,
  };
}

/** Index complet TVmaze, 250 series par page. ~320 pages pour tout : on plafonne. */
async function dumpTvmazeIndex(pages) {
  const out = [];
  for (let page = 0; page < pages; page++) {
    try {
      const list = await getJson(`https://api.tvmaze.com/shows?page=${page}`);
      if (!Array.isArray(list) || !list.length) break;
      out.push(...list.map(toTvmazeEntry));
      process.stdout.write(`\r  TVmaze index page ${page} — ${out.length} entrees`);
    } catch (e) {
      process.stdout.write(`\n  page ${page} en echec : ${e.message}\n`);
      break;
    }
    await sleep(600);
  }
  process.stdout.write('\n');
  return out;
}

/** Resout une liste de titres (typiquement extraits d'un export Netflix). */
async function dumpTvmazeFromTitles(titles) {
  const out = [];
  const akas = [];

  for (let i = 0; i < titles.length; i++) {
    try {
      const rows = await getJson(
        `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(titles[i])}`
      );
      const top = rows?.[0]?.show;
      if (top) {
        const entry = toTvmazeEntry(top);
        entry.queriedWith = titles[i];
        out.push(entry);

        // Les titres alternatifs par pays sont ce qui permet le rapprochement FR.
        try {
          const list = await getJson(`https://api.tvmaze.com/shows/${top.id}/akas`);
          const fr = (list ?? []).filter((a) => a.country?.code === 'FR').map((a) => a.name);
          entry.altTitles = [...new Set([...(list ?? []).map((a) => a.name)])];
          if (fr.length) akas.push({ id: top.id, name: top.name, fr });
        } catch {
          /* les akas sont un bonus */
        }
        await sleep(550);
      }
    } catch (e) {
      process.stdout.write(`\n  "${titles[i]}" en echec : ${e.message}\n`);
    }
    process.stdout.write(`\r  TVmaze ${i + 1}/${titles.length} — ${out.length} trouves`);
    await sleep(550);
  }
  process.stdout.write('\n');
  if (akas.length) console.log(`  ${akas.length} series avec un titre FR alternatif`);
  return out;
}

/** Extrait les titres d'un export Netflix, sans dependre du code de l'app. */
async function titlesFromCsv(path) {
  const raw = await readFile(path, 'utf8');
  const lines = raw.split(/\r?\n/).slice(1).filter(Boolean);

  const EPISODIC =
    /^(?:saisons?|seasons?|\u00E9pisodes?|episodes?|parties?|parts?|volumes?|vol|chapitres?|chapters?|le\u00E7ons?|lecons?|lessons?|s\d+|\d+\s*(?:st|nd|rd|th|re|\u00E8re|e|er)?\s*(?:saisons?|seasons?|parties?|parts?))\b/i;

  const cleaned = [];

  for (const line of lines) {
    const m = line.match(/^"((?:[^"]|"")*)"|^([^,;]*)/);
    let title = (m?.[1] ?? m?.[2] ?? '').replace(/""/g, '"');
    // Netflix truffe ses exports d'espaces insecables.
    title = title.replace(/[\u00A0\u2000-\u200A\u202F\u3000]/g, ' ').trim();
    if (!title) continue;

    const parts = title.split(/\s*:\s*/).map((p) => p.trim());
    if (parts.length >= 3 || (parts.length === 2 && EPISODIC.test(parts[1]))) {
      title = parts[0];
    }
    if (title.length >= 2) cleaned.push(title);
  }

  // Familles detectees par les donnees, comme dans src/lib/importers.ts : si
  // plusieurs titres DIFFERENTS partagent le meme premier segment, ce segment
  // est le nom de la serie. Sans cette passe le script sortait 76 titres la ou
  // l'app en sort 48 : "Twilight of the Gods: <titre d'episode>" comptait huit
  // fois. Un film a deux-points n'apparait qu'une fois et reste intact.
  const families = new Map();
  for (const t of cleaned) {
    const parts = t.split(/\s*:\s*/);
    if (parts.length < 2) continue;
    const head = parts[0].trim();
    if (head.length < 2 || head === t) continue;
    if (!families.has(head)) families.set(head, new Set());
    families.get(head).add(t);
  }
  const collapsible = new Set(
    [...families.entries()].filter(([, variants]) => variants.size >= 2).map(([head]) => head)
  );

  const seen = new Map();
  for (const t of cleaned) {
    const head = t.split(/\s*:\s*/)[0].trim();
    const final = collapsible.has(head) ? head : t;
    seen.set(final.toLowerCase(), final);
  }
  return [...seen.values()];
}

// ----------------------------------------------------------------- fusion
/** Fusionne les trois sources en une liste normalisee, dedupliquee par titre. */
function mergeCatalog(groups) {
  const byKey = new Map();
  const norm = (s) =>
    s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  for (const entry of groups.flat()) {
    if (!entry.title) continue;
    const key = `${entry.kind}:${norm(entry.title)}`;
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, {
        kind: entry.kind,
        title: entry.title,
        altTitles: [...new Set(entry.altTitles ?? [])],
        imageUrl: entry.imageUrl ?? null,
        year: entry.year ?? null,
        sources: [{ provider: entry.provider, id: entry.id }],
      });
      continue;
    }

    // Une image existante n'est jamais remplacee par un `null`.
    if (!existing.imageUrl && entry.imageUrl) existing.imageUrl = entry.imageUrl;
    if (!existing.year && entry.year) existing.year = entry.year;
    existing.altTitles = [...new Set([...existing.altTitles, ...(entry.altTitles ?? [])])];
    existing.sources.push({ provider: entry.provider, id: entry.id });
  }

  return [...byKey.values()].sort((a, b) => a.title.localeCompare(b.title, 'fr'));
}

async function save(name, data) {
  const path = resolve(OUT_DIR, name);
  await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
  const withImage = data.filter?.((d) => d.imageUrl)?.length ?? 0;
  console.log(
    `  ecrit ${name.padEnd(14)} ${String(data.length).padStart(6)} entrees` +
      (data.length ? `, ${withImage} avec image` : '')
  );
}

// -------------------------------------------------------------------- main
async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const groups = [];

  if (RUN_ALL || ONLY_ADN) {
    console.log('\nADN — catalogue complet');
    const adn = await dumpAdn();
    await save('adn.json', adn);
    groups.push(adn);
  }

  if (RUN_ALL || ONLY_ANILIST) {
    console.log(`\nAniList — ${PAGES} page(s) par format`);
    const anilist = await dumpAniList(PAGES);
    await save('anilist.json', anilist);
    groups.push(anilist);
  }

  if (RUN_ALL || ONLY_TVMAZE) {
    let tvmaze = [];
    if (FROM_CSV) {
      const titles = await titlesFromCsv(FROM_CSV);
      console.log(`\nTVmaze — ${titles.length} titres issus de ${FROM_CSV}`);
      tvmaze = await dumpTvmazeFromTitles(titles);
    } else if (TVMAZE_INDEX) {
      console.log(`\nTVmaze — index, ${PAGES} page(s) de 250`);
      tvmaze = await dumpTvmazeIndex(PAGES);
    } else {
      console.log('\nTVmaze — ignore (passe --from=<csv> ou --tvmaze-index)');
    }
    if (tvmaze.length) {
      await save('tvmaze.json', tvmaze);
      groups.push(tvmaze);
    }
  }

  // Fusion a partir de TOUS les fichiers presents sur le disque, et non des
  // seules sources lancees cette fois : sinon `npm run dump -- --tvmaze`
  // ecrasait catalog.json en y perdant les 580 entrees d'ADN.
  const onDisk = [];
  for (const name of ['adn.json', 'anilist.json', 'tvmaze.json']) {
    try {
      const parsed = JSON.parse(await readFile(resolve(OUT_DIR, name), 'utf8'));
      if (Array.isArray(parsed) && parsed.length) {
        onDisk.push(parsed);
        console.log(`  reprise de ${name} (${parsed.length} entrees)`);
      }
    } catch {
      // Source jamais generee : normal.
    }
  }

  if (onDisk.length) {
    console.log('\nFusion');
    const catalog = mergeCatalog(onDisk);
    await save('catalog.json', catalog);
    const parKind = catalog.reduce((acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] ?? 0) + 1 }), {});
    console.log(`  par type : ${Object.entries(parKind).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    console.log(`  sans image : ${catalog.filter((e) => !e.imageUrl).length}`);
  }

  console.log(`\nTermine. Fichiers dans ${OUT_DIR}\n`);
}

main().catch((e) => {
  console.error(`\nEchec : ${e.message}`);
  process.exit(1);
});

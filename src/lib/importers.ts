/**
 * Import de listes existantes, sans aucun identifiant de plateforme.
 *
 * Volontairement generique : on ne se connecte a rien. Tout ce qui ressemble a
 * "un titre par ligne" ou "un CSV avec une colonne titre" rentre ici. Ca couvre
 * l'export officiel Netflix ("Vos informations personnelles" -> ViewingActivity.csv),
 * une liste copiee depuis une page watchlist, ou un export MyAnimeList/AniList.
 *
 * Le rapprochement avec les providers se fait ensuite via la recherche : on
 * propose, l'utilisateur confirme. Aucun ajout silencieux, parce qu'un mauvais
 * rapprochement pollue durablement la bibliotheque.
 */

export interface ImportCandidate {
  /** Titre nettoye, tel qu'on va le chercher chez les providers. */
  title: string;
  /** Ligne d'origine, pour que l'utilisateur puisse verifier. */
  raw: string;
  /** Numero d'episode detecte, s'il y en a un. */
  episode: number | null;
  /** Numero de saison detecte, s'il y en a un. */
  season: number | null;
  /** Nombre d'occurrences : sert a trier par "ce que je regarde vraiment". */
  count: number;
}

/**
 * Netflix truffe ses exports d'espaces insecables : 543 occurrences U+00A0 dans
 * un historique de 465 lignes ("Saison 6", "Tale : La Servante").
 * Sans normalisation, ces caracteres survivent jusque dans les titres envoyes
 * aux APIs de recherche, qui ne trouvent alors rien.
 */
function normalizeSpaces(s: string): string {
  // U+00A0 insecable, U+2000..U+200A cadratins, U+2007 chiffre,
  // U+202F insecable fine, U+3000 ideographique.
  return s.replace(/[\u00A0\u2000-\u200A\u2007\u202F\u3000]/g, ' ');
}

/**
 * Un segment qui prouve qu'on est dans la structure "Serie: ...: Episode".
 *
 * Couvre les formes reellement rencontrees dans les exports FR : "Saison 6",
 * "Épisode 10", "1st Saison" (Netflix melange l'ordinal anglais et le mot
 * francais), "Leçon 1", "Partie 2", "Chapitre 3", "Volume 1".
 */
const EPISODIC_SEGMENT =
  /^(?:saisons?|seasons?|épisodes?|episodes?|parties?|parts?|volumes?|vol|chapitres?|chapters?|leçons?|lecons?|lessons?|séries?\s+limitée|limited\s+series|mini-?s[ée]rie|miniseries|s\d+|\d+\s*(?:st|nd|rd|th|re|ère|e|er)?\s*(?:saisons?|seasons?|parties?|parts?))\b/i;

/** Decoupe une ligne CSV en gerant les champs entre guillemets. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((ch === ',' || ch === ';') && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Netflix nomme ses lignes "Serie: Saison 1: Titre de l'episode".
 * On ne garde que le premier segment, qui est le nom de la serie.
 */
function cleanTitle(raw: string): {
  title: string;
  episode: number | null;
  season: number | null;
} {
  let s = normalizeSpaces(raw).trim().replace(/^["']|["']$/g, '');

  const segments = s.split(/\s*:\s*/).map((seg) => seg.trim());
  let episode: number | null = null;
  let season: number | null = null;

  if (segments.length > 1) {
    const tail = segments.slice(1);
    const hasMarker = tail.some((seg) => EPISODIC_SEGMENT.test(seg));

    // Trois segments ou plus : c'est toujours "Serie: Saison N: Titre d'episode"
    // chez Netflix. Deux segments sans marqueur restent intacts, sinon on
    // amputerait les vrais titres a deux-points ("Black Clover : L'épée...").
    if (hasMarker || segments.length >= 3) {
      s = segments[0];

      for (const seg of tail) {
        const ep = seg.match(/^(?:épisodes?|episodes?|ep|chapitres?|chapters?|leçons?|lecons?|lessons?)\s*\.?\s*(\d{1,4})\b/i);
        if (ep && episode === null) episode = Number(ep[1]);

        const se = seg.match(/^(?:saisons?|seasons?)\s*(\d{1,3})\b/i);
        if (se && season === null) season = Number(se[1]);

        // Forme ordinale : "1st Saison", "2e Partie".
        const ord = seg.match(/^(\d{1,3})\s*(?:st|nd|rd|th|re|ère|e|er)?\s*(?:saisons?|seasons?)\b/i);
        if (ord && season === null) season = Number(ord[1]);
      }
    }
  }

  // Formes en fin de chaine, hors structure Netflix : "One Piece - Episode 1089",
  // "Frieren S01E12". Le prefixe de classe evite \b, qui echoue devant un
  // caractere accentue ("É" n'est pas un caractere de mot).
  if (episode === null) {
    const seMatch = s.match(/(?:^|[\s\-–—|(])S(\d{1,2})\s*E\s*(\d{1,3})\b/i);
    const epMatch = s.match(
      /(?:^|[\s\-–—|(])(?:ep|episode|épisode)s?\s*\.?\s*(\d{1,4})(?!\d)/i
    );
    if (seMatch) {
      season = season ?? Number(seMatch[1]);
      episode = Number(seMatch[2]);
    } else if (epMatch) {
      episode = Number(epMatch[1]);
    }
  }

  s = s
    .replace(/(?:^|[\s\-–—|(])S\d{1,2}\s*E\s*\d{1,3}\b/i, ' ')
    .replace(/(?:^|[\s\-–—|(])(?:ep|episode|épisode)s?\s*\.?\s*\d{1,4}(?!\d)/i, ' ')
    .replace(/[\s\-–—|]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return { title: s, episode, season };
}

/**
 * Analyse un contenu colle ou un fichier depose.
 * Detecte seul s'il s'agit d'un CSV, d'un JSON ou d'une simple liste.
 */
export function parseImport(content: string): ImportCandidate[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  // --- JSON (sauvegarde de l'app, ou export d'un tracker) ---
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const data = JSON.parse(trimmed);
      const rows: unknown[] = Array.isArray(data)
        ? data
        : Array.isArray((data as Record<string, unknown>).items)
          ? ((data as Record<string, unknown>).items as unknown[])
          : [];
      const titles = rows
        .map((r) => {
          if (typeof r === 'string') return r;
          const o = r as Record<string, unknown>;
          return (o.title ?? o.name ?? o.series_title ?? null) as string | null;
        })
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
      return tally(titles);
    } catch {
      // Pas du JSON valide : on retombe sur le traitement ligne par ligne.
    }
  }

  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return [];

  // --- CSV : on cherche la colonne "titre" dans l'en-tete ---
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const looksCsv = header.length > 1;
  let titleCol = -1;

  if (looksCsv) {
    const keys = ['title', 'titre', 'name', 'nom', 'serie', 'série', 'show', 'series_title'];
    titleCol = header.findIndex((h) => keys.some((k) => h === k || h.includes(k)));
    // Netflix : ViewingActivity.csv a "Title,Date". Pas d'en-tete reconnu -> colonne 0.
    if (titleCol === -1) titleCol = 0;
  }

  const rawTitles = looksCsv
    ? lines.slice(1).map((l) => splitCsvLine(l)[titleCol] ?? '')
    : lines;

  return tally(rawTitles.filter((t) => t.trim().length > 0));
}

/** Premier segment d'un titre a deux-points, ou null s'il n'y en a qu'un. */
function headSegment(title: string): string | null {
  const parts = title.split(/\s*:\s*/);
  if (parts.length < 2) return null;
  const head = parts[0].trim();
  return head.length >= 2 ? head : null;
}

/** Regroupe les doublons et compte les occurrences. */
function tally(rawTitles: string[]): ImportCandidate[] {
  const cleaned = rawTitles
    .map((raw) => ({ raw, ...cleanTitle(raw) }))
    .filter((c) => c.title && c.title.length >= 2);

  /*
   * Detection de familles par les donnees, et non par mots-cles.
   *
   * Netflix nomme certains episodes sans aucun marqueur de saison :
   * "Twilight of the Gods: Le chant de Sigrid", "Super Mâles: Mâles au cœur",
   * "Les Dinosaures: L'ascension". La liste EPISODIC_SEGMENT ne peut pas les
   * couvrir, et ils produisaient une fiche par episode (8, 7 et 4).
   *
   * Le signal fiable est statistique : si plusieurs titres DIFFERENTS partagent
   * le meme premier segment, ce segment est le nom de la serie. Un film dont le
   * titre contient un deux-points n'apparait qu'une fois et reste intact
   * ("Black Clover : L'épée de l'empereur-mage").
   */
  const families = new Map<string, Set<string>>();
  for (const c of cleaned) {
    const head = headSegment(c.title);
    if (!head || head === c.title) continue;
    if (!families.has(head)) families.set(head, new Set());
    families.get(head)!.add(c.title);
  }
  const collapsible = new Set(
    [...families.entries()].filter(([, variants]) => variants.size >= 2).map(([head]) => head)
  );

  const map = new Map<string, ImportCandidate>();

  for (const c of cleaned) {
    const { raw, episode, season } = c;
    const head = headSegment(c.title);
    const title = head && collapsible.has(head) ? head : c.title;

    const key = title.toLowerCase();
    const existing = map.get(key);
    if (existing) {
      existing.count++;
      // On garde l'episode le plus haut vu : c'est la progression la plus probable.
      if (episode !== null && (existing.episode === null || episode > existing.episode)) {
        existing.episode = episode;
      }
      if (season !== null && (existing.season === null || season > existing.season)) {
        existing.season = season;
      }
    } else {
      map.set(key, { title, raw, episode, season, count: 1 });
    }
  }

  return [...map.values()].sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
}

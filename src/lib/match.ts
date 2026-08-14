/**
 * Rapprochement de titres entre providers.
 *
 * Le probleme concret : ADN dit "Détective Conan" / originalTitle "Meitantei Conan",
 * AniList dit "Meitantei Conan" en romaji et "Case Closed" en anglais. Il faut relier
 * les deux sans backend et sans base de correspondance. On normalise agressivement
 * puis on compare, avec un repli sur une similarite par tokens.
 */

/** Minuscule, sans accents, sans ponctuation, espaces normalises. */
export function normalizeTitle(raw: string): string {
  return raw
    .normalize('NFD')
    // Retire les diacritiques combinants (U+0300..U+036F) : "Détective" -> "detective".
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Retire les suffixes de saison qui font echouer une comparaison stricte. */
export function stripSeasonNoise(normalized: string): string {
  return normalized
    .replace(
      /\b(saison|season|s|part|partie|cour|final|arc)\s*\d+\b/g,
      ' '
    )
    .replace(/\b(2nd|3rd|\d+th|second|third)\s+(season|saison)\b/g, ' ')
    .replace(/\b(tv|anime|the animation|the movie|ova|ona|special)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(s.split(' ').filter((t) => t.length > 1));
}

/**
 * Nombre de caracteres alphabetiques d'un titre normalise.
 *
 * Indispensable : normalizeTitle supprime les caracteres japonais, donc
 * "君のことが大大大大大好きな100人の彼女" se reduit a "100". Deux titres CJK
 * sans rapport tombent alors sur le meme jeu de tokens numeriques et la
 * similarite grimpe a 1. On refuse donc tout candidat sans contenu alphabetique
 * exploitable.
 */
function letterCount(normalized: string): number {
  let n = 0;
  for (const ch of normalized) {
    if (ch >= 'a' && ch <= 'z') n++;
  }
  return n;
}

const MIN_LETTERS = 3;

/** Titres exploitables pour une comparaison : assez de lettres, pas que des chiffres. */
function usable(candidates: (string | null | undefined)[]): string[] {
  return candidates
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .map(normalizeTitle)
    .filter((t) => t.length > 0 && letterCount(t) >= MIN_LETTERS);
}

/** Similarite de Jaccard sur les tokens, 0..1. */
export function titleSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Vrai si deux jeux de titres designent tres probablement la meme oeuvre.
 * Seuil volontairement haut : un faux positif place un episode sur la mauvaise
 * serie, ce qui est plus penible qu'un episode manquant.
 */
export function titlesMatch(
  candidatesA: (string | null | undefined)[],
  candidatesB: (string | null | undefined)[]
): boolean {
  const a = usable(candidatesA);
  const b = usable(candidatesB);
  if (!a.length || !b.length) return false;

  // 1. Egalite exacte apres normalisation.
  for (const x of a) for (const y of b) if (x === y) return true;

  // 2. Egalite apres retrait du bruit de saison.
  const sa = a.map(stripSeasonNoise).filter((t) => letterCount(t) >= MIN_LETTERS);
  const sb = b.map(stripSeasonNoise).filter((t) => letterCount(t) >= MIN_LETTERS);
  for (const x of sa) for (const y of sb) if (x === y) return true;

  // 3. Similarite forte par tokens. Deux garde-fous en plus du seuil :
  //    - au moins 2 tokens de chaque cote, sinon un seul mot commun suffirait ;
  //    - au moins 2 tokens partages, ce qui elimine les collisions sur un
  //      chiffre ou un mot generique isole.
  for (const x of sa) {
    const tx = tokens(x);
    if (tx.size < 2) continue;
    for (const y of sb) {
      const ty = tokens(y);
      if (ty.size < 2) continue;

      let shared = 0;
      for (const t of tx) if (ty.has(t)) shared++;
      if (shared < 2) continue;

      if (shared / (tx.size + ty.size - shared) >= 0.8) return true;
    }
  }
  return false;
}

/** Extrait un numero d'episode depuis un libelle ADN ("Episode 238", "238"). */
export function parseEpisodeNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

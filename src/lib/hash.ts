/**
 * Hash FNV-1a, 32 bits, en base 36.
 *
 * Sert uniquement a raccourcir des cles de cache : une bibliotheque de plusieurs
 * centaines de series fabriquerait sinon une cle de plusieurs milliers de
 * caracteres, relue a chaque acces IndexedDB. Aucun usage cryptographique.
 */
export function fingerprint(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

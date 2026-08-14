/**
 * Derivation d'une URL de jaquette en haute definition.
 *
 * Les vignettes stockees font quelques centaines de pixels : les afficher en
 * plein ecran donnerait du flou. Certains providers exposent une variante plus
 * grande a une URL predictible — mais pas tous, et il fallait le verifier plutot
 * que le supposer :
 *
 *   TVmaze   /medium_portrait/ -> /original_untouched/    OK  (206 image/jpeg)
 *   ADN      _350x500          -> _700x1000              OK  (206 image/jpeg)
 *   AniList  /medium/          -> /large/                404 — le nom de fichier
 *            change avec la taille (`b6702-` contre `bx6702-`), aucune
 *            derivation possible. Ses jaquettes restent donc en 230x345, ce qui
 *            reste correct a l'ecran.
 *
 * Renvoie `null` quand aucune variante n'est connue : l'appelant garde alors la
 * vignette, et doit de toute facon prevoir un repli en cas d'echec de
 * chargement, ces motifs pouvant changer sans preavis.
 */
export function highResUrl(url: string | null | undefined): string | null {
  if (!url) return null;

  if (url.includes('/medium_portrait/')) {
    return url.replace('/medium_portrait/', '/original_untouched/');
  }
  if (url.includes('/medium_landscape/')) {
    return url.replace('/medium_landscape/', '/original_untouched/');
  }
  if (url.includes('_350x500')) {
    return url.replace('_350x500', '_700x1000');
  }
  if (url.includes('_175x250')) {
    return url.replace('_175x250', '_700x1000');
  }

  return null;
}

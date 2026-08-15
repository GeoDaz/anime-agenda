import type { PlatformId } from './types';

interface PlatformMeta {
  id: PlatformId;
  label: string;
  /** Couleur de marque, utilisee pour le liseré et le badge. */
  color: string;
  /** Fond du badge, suffisamment contraste en clair comme en sombre. */
  badgeClass: string;
}

export const PLATFORMS: Record<PlatformId, PlatformMeta> = {
  crunchyroll: {
    id: 'crunchyroll',
    label: 'Crunchyroll',
    color: '#f47521',
    badgeClass: 'bg-[#f47521]/15 text-[#c25412] dark:text-[#ffa864] ring-[#f47521]/30',
  },
  adn: {
    id: 'adn',
    label: 'ADN',
    color: '#0096ff',
    badgeClass: 'bg-[#0096ff]/15 text-[#0a6ebd] dark:text-[#6cc4ff] ring-[#0096ff]/30',
  },
  netflix: {
    id: 'netflix',
    label: 'Netflix',
    color: '#e50914',
    badgeClass: 'bg-[#e50914]/15 text-[#b0060f] dark:text-[#ff7b81] ring-[#e50914]/30',
  },
  disneyplus: {
    id: 'disneyplus',
    label: 'Disney+',
    color: '#1f80e0',
    badgeClass: 'bg-[#1f80e0]/15 text-[#155fa8] dark:text-[#79b8f5] ring-[#1f80e0]/30',
  },
  primevideo: {
    id: 'primevideo',
    label: 'Prime Video',
    color: '#00a8e1',
    badgeClass: 'bg-[#00a8e1]/15 text-[#00789f] dark:text-[#68d4f5] ring-[#00a8e1]/30',
  },
  hbomax: {
    id: 'hbomax',
    label: 'HBO Max',
    color: '#991eeb',
    badgeClass: 'bg-[#991eeb]/15 text-[#6b12a6] dark:text-[#c98cf5] ring-[#991eeb]/30',
  },
  paramount: {
    id: 'paramount',
    label: 'Paramount+',
    color: '#0064ff',
    badgeClass: 'bg-[#0064ff]/15 text-[#0047b3] dark:text-[#79aeff] ring-[#0064ff]/30',
  },
  appletv: {
    id: 'appletv',
    label: 'Apple TV',
    // Apple TV+ est monochrome : un gris ardoise reste lisible dans les deux
    // themes, la ou un noir de marque disparaitrait en mode sombre.
    color: '#5a5a5f',
    badgeClass: 'bg-[#5a5a5f]/15 text-[#3f3f46] dark:text-[#d4d4d8] ring-[#5a5a5f]/30',
  },
  other: {
    id: 'other',
    label: 'Autre',
    color: '#8b8b8b',
    badgeClass: 'bg-neutral-500/15 text-neutral-600 dark:text-neutral-300 ring-neutral-500/30',
  },
};

/** Les 5 plateformes qui nous interessent, dans l'ordre d'affichage. */
export const TRACKED_PLATFORMS: PlatformId[] = [
  'crunchyroll',
  'adn',
  'netflix',
  'disneyplus',
  'primevideo',
  'hbomax',
  'paramount',
  'appletv',
];

/**
 * Normalise un nom de plateforme arbitraire (BetaSeries `platforms.svods[].name`)
 * vers notre identifiant interne. Tout ce qui n'est pas reconnu tombe en `other`,
 * volontairement : mieux vaut afficher "Autre" que perdre l'info.
 */
export function normalizePlatform(raw: string): PlatformId {
  const s = raw.toLowerCase().replace(/[\s._-]/g, '');

  if (s.includes('crunchyroll')) return 'crunchyroll';

  /*
   * Noms tels que BetaSeries les ecrit pour la France, verifies sur
   * /platforms/list?country=FR : « HBO Max », « Paramount+ », « Apple TV ».
   *
   * Le `+` de « Paramount+ » n'est pas retire par la normalisation, d'ou un test
   * par inclusion. Et « Apple TV » doit etre distingue d'« Apple iTunes », un
   * service VOD different present dans la meme liste : on exige donc le prefixe
   * exact plutot qu'un simple `includes('apple')`.
   */
  if (s.includes('hbo')) return 'hbomax';
  if (s.includes('paramount')) return 'paramount';
  if (s.startsWith('appletv')) return 'appletv';
  if (s.includes('animationdigitalnetwork') || s.includes('animedigitalnetwork') || s === 'adn')
    return 'adn';
  if (s.includes('netflix')) return 'netflix';
  if (s.includes('disney')) return 'disneyplus';
  // "Amazon Prime Video", "Prime Video", "Amazon Video"
  if (s.includes('primevideo') || s.includes('amazonvideo') || s.includes('amazonprime'))
    return 'primevideo';

  return 'other';
}

/** Deduplique et trie une liste de plateformes selon l'ordre d'affichage. */
export function tidyPlatforms(list: PlatformId[]): PlatformId[] {
  const seen = new Set(list);
  const ordered = TRACKED_PLATFORMS.filter((p) => seen.has(p));
  if (seen.has('other')) ordered.push('other');
  return ordered;
}

export function platformLabel(id: PlatformId): string {
  return PLATFORMS[id]?.label ?? 'Autre';
}

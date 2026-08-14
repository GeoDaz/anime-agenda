// Modele de donnees. Regle d'or : le store local est la source de verite.
// Les providers (AniList / ADN / TMDB) ne font qu'enrichir, jamais ecraser.

export type MediaKind = 'anime' | 'series';

/**
 * Nature de l'oeuvre, distincte de `kind`.
 *
 * Necessaire parce que `kind: 'series'` couvre deux choses tres differentes :
 * une serie live-action (The Witcher) et de l'animation occidentale (Arcane,
 * Castlevania). Etiqueter la seconde « live action » serait faux, donc on
 * stocke l'information plutot que de la deduire.
 *
 * TVmaze la donne proprement via son champ `type` : `Scripted` -> live,
 * `Animation` -> animation.
 */
export type MediaSubtype = 'live' | 'animation';

/** D'ou vient la fiche a l'origine. `manual` = saisie a la main, aucun provider. */
export type ProviderId = 'anilist' | 'tmdb' | 'tvmaze' | 'adn' | 'manual';

export type PlatformId =
  | 'crunchyroll'
  | 'adn'
  | 'netflix'
  | 'disneyplus'
  | 'primevideo'
  | 'other';

export type WatchStatus = 'watching' | 'planned' | 'paused' | 'done' | 'dropped';

/**
 * Champs que l'utilisateur peut forcer en local. Tout ce qui est defini ici
 * gagne systematiquement sur la donnee du provider (cf. resolveItem()).
 */
export interface LocalOverrides {
  title?: string;
  coverUrl?: string;
  platforms?: PlatformId[];
  totalEpisodes?: number | null;
  /** Jour de parution 0=dimanche..6=samedi, pour les series sans planning provider. */
  weekday?: number | null;
  /** "HH:mm" heure locale, utilise avec weekday. */
  time?: string | null;
  hidden?: boolean;
}

/** Une serie suivie, telle que stockee en IndexedDB. */
export interface TrackedItem {
  /** uid local stable : `${provider}:${externalId}` ou `manual:${uuid}`. */
  id: string;
  kind: MediaKind;
  /** Live action ou animation. Absent sur les fiches d'avant ce champ. */
  subtype?: MediaSubtype | null;
  provider: ProviderId;
  /** id chez le provider (AniList mediaId, TMDB tv id, ADN show id). */
  externalId: string | null;

  // --- donnees provider (rafraichies, jamais editees a la main) ---
  title: string;
  originalTitle?: string | null;
  coverUrl?: string | null;
  platforms: PlatformId[];
  totalEpisodes?: number | null;

  /** Correspondances trouvees vers d'autres providers, mises en cache. */
  links?: {
    anilistId?: number | null;
    tmdbId?: number | null;
    tvmazeId?: number | null;
    adnShowId?: number | null;
  };

  // --- etat utilisateur ---
  status: WatchStatus;
  /** Dernier episode vu. 0 = rien vu. */
  progress: number;
  /** Episodes marques vus individuellement, pour le rattrapage non lineaire. */
  watchedEpisodes?: number[];

  overrides?: LocalOverrides;

  addedAt: number;
  updatedAt: number;
  /** Derniere synchro provider reussie (epoch ms). */
  syncedAt?: number;
}

/** Vue resolue d'un item : overrides locaux appliques par-dessus le provider. */
export interface ResolvedItem extends TrackedItem {
  displayTitle: string;
  displayCover: string | null;
  displayPlatforms: PlatformId[];
}

/** Une sortie d'episode placee dans l'agenda. */
export interface AiringEntry {
  /** cle de deduplication : `${itemId}:${episode ?? airsAt}`. */
  key: string;
  itemId: string;
  kind: MediaKind;
  subtype?: MediaSubtype | null;
  title: string;
  coverUrl: string | null;
  episode: number | null;
  episodeTitle?: string | null;
  /** epoch ms. */
  airsAt: number;
  platforms: PlatformId[];
  /** Qui a fourni cette date. Sert a arbitrer les conflits. */
  source: 'adn' | 'tmdb' | 'tvmaze' | 'anilist' | 'manual';
  /** Lien direct de visionnage quand le provider en donne un. */
  url?: string | null;
  watched: boolean;
}

/** Resultat de recherche, avant ajout a la bibliotheque. */
export interface SearchResult {
  provider: ProviderId;
  externalId: string;
  kind: MediaKind;
  subtype?: MediaSubtype | null;
  title: string;
  originalTitle?: string | null;
  /**
   * Tous les autres libelles connus (anglais AniList, titre original TMDB...).
   * Indispensable au rapprochement : "The Eminence in Shadow" n'existe que dans
   * le champ anglais d'AniList, dont `title` ne contient que le romaji.
   */
  altTitles?: string[];
  coverUrl?: string | null;
  platforms: PlatformId[];
  totalEpisodes?: number | null;
  year?: number | null;
  description?: string | null;
  /** Deja dans la bibliotheque ? rempli par l'UI. */
  alreadyTracked?: boolean;
}

export interface AppSettings {
  /** Cle TMDB v3 saisie dans l'app (active le support des series live-action). */
  tmdbApiKey: string | null;
  /** Plateformes retenues dans l'agenda. Vide = toutes. */
  platformFilter: PlatformId[];
  /** Masquer les episodes deja vus dans l'agenda. */
  hideWatched: boolean;
  /** Lundi comme premier jour de semaine. */
  weekStartsOnMonday: boolean;
  /** Inclure les series non suivies qui sortent cette semaine (mode decouverte). */
  showDiscovery: boolean;
}

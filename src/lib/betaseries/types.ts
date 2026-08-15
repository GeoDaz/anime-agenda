/**
 * Types BetaSeries, ecrits d'apres des reponses REELLES.
 *
 * La spec OpenAPI officielle declare les chemins et les parametres mais
 * pratiquement aucun schema de reponse. Ces interfaces viennent donc de
 * l'observation (scripts/probe-betaseries.mjs, 2026-08-14), et non d'une
 * supposition. Les champs dont la forme n'a PAS pu etre observee sont signales :
 * mieux vaut un `unknown` honnete qu'un type inventé.
 *
 * Deux pieges de cette API, constates :
 *  - plusieurs champs numeriques arrivent en `string` (`seasons`, `episodes`,
 *    `followers`, `length`, `rating`) ; ne pas les traiter comme des nombres ;
 *  - `errors` est present meme en cas de succes, sous forme de tableau vide.
 */

/** Erreur applicative. Presente et vide quand tout va bien. */
export interface BsError {
  code: number;
  text: string;
}

/** Enveloppe commune : toute reponse porte `errors`. */
export interface BsEnvelope {
  errors?: BsError[];
}

// --------------------------------------------------------------------------
// Authentification
// --------------------------------------------------------------------------

/**
 * Reponse de `POST /members/auth`.
 * Le jeton est a la racine, dans `token` — c'est lui qu'on stocke.
 */
export interface BsAuthResponse extends BsEnvelope {
  user: {
    id: number;
    login: string;
    xp: number;
    in_account: boolean;
  };
  token: string;
  /** Empreinte fournie par l'API ; inutilisee ici. */
  hash: string;
}

/** Reponse de `GET /members/infos`. Sert aussi a valider un jeton existant. */
export interface BsMemberResponse extends BsEnvelope {
  member: {
    id: number;
    login: string;
    xp: number;
    locale: string;
    avatar: string | null;
    profile_banner: string | null;
    in_account: boolean;
    is_private: boolean;
    is_admin: boolean;
    premium: boolean;
    valid_email: boolean;
    stats: {
      friends: number;
      shows: number;
      seasons: number;
      episodes: number;
      comments: number;
      /** D'autres compteurs existent ; seuls ceux-ci ont ete observes. */
      [key: string]: number;
    };
  };
}

// --------------------------------------------------------------------------
// Plateformes
// --------------------------------------------------------------------------

/**
 * Plateforme telle que listee par `/platforms/list?country=FR`.
 * 19 SVOD observees pour la France, dont ADN, Netflix, Disney+, Prime Video,
 * Canal+, OCS, Apple TV, HBO Max.
 */
export interface BsPlatformListItem {
  id: number;
  name: string;
  logo: string | null;
}

/**
 * Plateforme attachee a une serie (`show.platforms.svods`).
 * Plus riche que la liste generale : elle porte la couleur de marque et le lien
 * direct, ce qui remplace toute table de correspondance locale.
 */
export interface BsShowPlatform {
  id: number;
  name: string;
  tag: string | null;
  color: string | null;
  link_url: string | null;
  available: boolean;
  logo: string | null;
}

export interface BsPlatformsResponse extends BsEnvelope {
  platforms: {
    svod: BsPlatformListItem[];
    vod: BsPlatformListItem[];
  };
  locale: string;
}

// --------------------------------------------------------------------------
// Series
// --------------------------------------------------------------------------

/** Etat de la serie pour le membre connecte. Absent sans jeton. */
export interface BsShowUserState {
  archived: boolean;
  favorited: boolean;
  /** Episodes restant a voir. */
  remaining: number;
  status: number;
  last: string | null;
  next: string | null;
  tags: string | null;
  friends_watching: unknown[];
  rewatch: unknown;
}

export interface BsShowImages {
  show: string | null;
  banner: string | null;
  box: string | null;
  poster: string | null;
  clearlogo: string | null;
}

export interface BsShow {
  id: number;
  thetvdb_id: number;
  imdb_id: string | null;
  themoviedb_id: number;
  slug: string;
  title: string;
  original_title: string;
  description: string;

  /** Numeriques mais renvoyes en chaine par l'API. */
  seasons: string;
  episodes: string;
  followers: string;
  length: string;
  rating: string;

  seasons_details: { number: number; episodes: number }[];
  /** Table genre -> libelle, et non un tableau. */
  genres: Record<string, string>;
  network: string | null;
  country: string | null;
  status: string;
  language: string | null;
  creation: string;

  /** Vrai si la serie est deja suivie : remplace tout rapprochement local. */
  in_account: boolean;

  images: BsShowImages | null;
  aliases: Record<string, string> | unknown;
  platforms: {
    svods?: BsShowPlatform[];
    svod?: BsShowPlatform | null;
  } | null;

  /** Present uniquement avec un jeton. */
  user?: BsShowUserState;

  resource_url: string;
}

export interface BsShowsResponse extends BsEnvelope {
  shows: BsShow[];
}

export interface BsShowResponse extends BsEnvelope {
  show: BsShow;
}

// --------------------------------------------------------------------------
// Episodes
// --------------------------------------------------------------------------

/** Etat de l'episode pour le membre. C'est ici que vit la progression. */
export interface BsEpisodeUserState {
  seen: boolean;
  seen_date: string | null;
  downloaded: boolean;
  friends_watched: unknown[];
  rewatch: unknown;
}

export interface BsEpisodeNote {
  total: number;
  mean: number;
  user: number | null;
}

/** Serie reduite, telle qu'imbriquee dans un episode de planning. */
export interface BsEpisodeShow {
  id: number;
  thetvdb_id: number;
  title: string;
  slug: string;
  in_account: boolean;
  status: string;
  creation: string;
  description: string;
}

export interface BsEpisode {
  id: number;
  thetvdb_id: number;
  youtube_id: string | null;
  title: string;
  season: number;
  episode: number;
  /** Code de diffusion, par exemple « S02E467 ». */
  code: string;
  /** Numero absolu, toutes saisons confondues. */
  global: number;
  special: number;
  description: string;

  /**
   * Date de diffusion, au format `YYYY-MM-DD`.
   *
   * Attention : c'est une DATE, sans heure. L'API n'expose aucun horaire de
   * diffusion, contrairement a l'`airstamp` de TVmaze ou aux dates de mise en
   * ligne d'ADN. L'agenda ne peut donc afficher que des jours.
   */
  date: string;

  note: BsEpisodeNote;
  /** Present uniquement avec un jeton. */
  user?: BsEpisodeUserState;
  comments: number;
  resource_url: string;
  seen_total: number;
  length?: number;
  director?: string | null;
  show_slug?: string;
  show?: BsEpisodeShow;

  /**
   * Non observe : ce tableau etait toujours vide sur les episodes sondes.
   * Volontairement laisse en `unknown[]` plutot que type a l'aveugle.
   */
  platform_links: unknown[];
  /**
   * Partiellement observe : `{ displayOriginal, releases }`, la premiere valeur
   * de `releases` etant un booleen. La forme complete reste a confirmer.
   */
  releasesSvod?: { displayOriginal?: boolean; releases?: unknown } | null;
}

export interface BsPlanningResponse extends BsEnvelope {
  episodes: BsEpisode[];
}

export interface BsShowEpisodesResponse extends BsEnvelope {
  episodes: BsEpisode[];
}

/**
 * Reponse de `GET /episodes/list` : groupee PAR SERIE, et non a plat.
 * `remaining` et `unseen` donnent directement le retard a rattraper.
 */
export interface BsEpisodesToWatchResponse extends BsEnvelope {
  shows: {
    id: number;
    thetvdb_id: number;
    imdb_id: string | null;
    title: string;
    remaining: number;
    unseen: BsEpisode[];
  }[];
  total: number;
  totalEpisodes: number;
  totalMissingShows: number;
  totalMissingEpisodes: number;
}

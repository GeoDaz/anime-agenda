# Agenda Anime

PWA d'agenda hebdomadaire des sorties d'animes et de séries sur les plateformes françaises
(Crunchyroll, ADN, Netflix, Disney+, Prime Video).

Pas d'application mobile, pas de store, pas de backend : un export statique Next.js qu'on installe
sur l'écran d'accueil du téléphone.

```bash
npm install
npm run icons     # génère les icônes PNG de la PWA
npm run dev       # http://localhost:3000
npm run build     # export statique dans out/
```

Le serveur de dev affiche aussi une URL réseau (`http://192.168.x.x:3000`) : c'est le moyen le plus
simple de tester sur le téléphone avant de déployer.

---

## Architecture : local d'abord

La règle qui structure tout le projet : **IndexedDB est la source de vérité**, les providers ne font
qu'enrichir.

```
IndexedDB (ma liste + ma progression)  ← priorité absolue
        ▲ enrichissement / dates de diffusion
   ┌────┴──────┬───────────────┬──────────────┐
 AniList      ADN            TMDB          Manuel
 (anime,      (dates FR      (séries +      (jour de
  horaires)    réelles)       plateformes    parution
                              FR)            forcé)
```

Pourquoi pas AniList comme référentiel : il ne connaît que l'animation. Dès qu'on veut mélanger des
séries live-action, il ne peut plus être le socle. Chaque fiche porte donc un objet `overrides`
(`src/lib/types.ts`) dont les champs gagnent systématiquement sur la donnée provider — c'est
`resolveItem()` dans `src/lib/providers/index.ts` qui applique cette priorité.

### Arbitrage entre providers

Quand deux sources donnent une date pour le même épisode, la plus proche de la réalité française
gagne, mais **les plateformes sont fusionnées** (une série peut sortir sur Crunchyroll *et* ADN) :

| Source  | Rang | Ce qu'elle apporte                        |
| ------- | ---- | ----------------------------------------- |
| ADN     | 4    | date de mise en ligne FR réelle           |
| TMDB    | 3    | date de diffusion, région FR              |
| AniList | 2    | diffusion japonaise (décalage possible)   |
| Manuel  | 1    | estimation de l'utilisateur               |

---

## Sources de données

Les trois APIs renvoient `Access-Control-Allow-Origin: *`, ce qui permet de tout appeler depuis le
navigateur — c'est ce qui rend l'export statique possible.

| Source                    | Clé requise         | Rôle                                                          |
| ------------------------- | ------------------- | ------------------------------------------------------------- |
| **AniList**               | non                 | planning à la minute, visuels — **origine JP uniquement**      |
| **ADN**                   | non                 | vraies dates de sortie FR, titres d'épisodes en français        |
| **TVmaze**                | non                 | séries et animation, horaires précis — **source par défaut**    |
| **Wikidata + Wikipédia**  | non                 | traduction des titres FR vers l'anglais                        |
| **TMDB**                  | oui, **facultative** | disponibilité exacte par plateforme en France                  |

**Aucune clé n'est nécessaire.** TMDB demandant des données personnelles pour sa clé, tout le
parcours fonctionne sans lui — voir la section suivante.

**AniList ne référence que les œuvres d'origine japonaise.** Ce n'est pas « anime vs live-action » :
`Arcane`, `Castlevania`, `Blood of Zeus` et le `Devil May Cry` de Netflix n'y sont **pas du tout**
(vérifié : `media(type: ANIME, search: "Arcane")` renvoie zéro résultat, avec ou sans filtres).
`Pluto` et le `Devil May Cry` de 2007, japonais, y sont.

Conséquence : la clé TMDB n'est pas un bonus pour le live-action, elle est **de fait indispensable**
dès que la bibliothèque contient de l'animation occidentale. Elle se saisit dans la page Import et
reste sur l'appareil (IndexedDB) ; elle n'est jamais envoyée ailleurs que chez TMDB.

### Deux particularités d'ADN découvertes en testant

**La recherche ADN ne porte que sur le titre français.** `?search=Meitantei Conan` renvoie zéro
résultat alors que la série existe sous « Détective Conan » avec `originalTitle: "Meitantei Conan"`.
Comme AniList nous donne le romaji, chercher par ce biais échouait sur 29 séries testées sur 30.
Le catalogue ne faisant que ~580 entrées (`limit` plafonné à 100, pagination par `offset`), on
le charge entièrement, on le met en cache 24 h et on rapproche en local sur `originalTitle`.

**Le calendrier mélange sorties hebdomadaires et ajouts de catalogue en masse** (21 épisodes de
Détective Conan le même jour). Sans importance ici : on ne retient que ce qui correspond à une série
suivie.

---

## Le rapprochement de titres, et son piège

`src/lib/match.ts` relie « Détective Conan » (ADN) à « Meitantei Conan » (AniList) sans base de
correspondance : normalisation agressive, retrait du bruit de saison, puis similarité de Jaccard sur
les tokens.

Le test d'intégration sur données réelles a révélé un faux positif qui ne se voyait pas en test
unitaire. `normalizeTitle` supprime les caractères japonais, donc :

```
"君のことが大大大大大好きな100人の彼女 3rd Season"  →  "100"
"ドラゴンボールZ 100"                              →  "z 100"
```

Deux titres CJK sans aucun rapport se réduisaient à des tokens numériques identiques, la similarité
montait à 1,0, et « Kimi no Koto ga… 100-nin no Kanojo » se retrouvait apparié à « FAIRY TAIL 100
YEARS QUEST » *et* à « Dragon Ball Z ». Trois garde-fous corrigent ça :

- un candidat doit contenir au moins 3 caractères alphabétiques (`letterCount`) ;
- la voie par similarité exige au moins 2 tokens de chaque côté ;
- il faut au moins 2 tokens partagés, ce qui élimine les collisions sur un chiffre isolé.

Et en cas d'ambiguïté (plusieurs séries ADN candidates), **on ne lie rien** : un mauvais lien colle
durablement les épisodes d'une autre série dans l'agenda, ce qui est pire qu'une date manquante.

---

## Ce que le projet ne fait pas, et pourquoi

**Pas de connexion à tes comptes Crunchyroll / Netflix / Disney+.** Ce n'est pas un choix de confort,
c'est une limite mesurée :

- **Netflix** n'a plus d'API publique depuis 2014, **Disney+** n'en a jamais eu.
- **Crunchyroll** : le CORS n'est pas le problème (une Route Handler Next.js le résoudrait, et les
  hosts d'API répondent `401 JSON` sans challenge anti-bot). Le blocage est l'**authentification** :
  `auth.obtain_access_token.missing_client_credential` réclame un couple `client_id`/`secret` de
  device, non publié, embarqué dans leurs apps et rotaté. L'extraire viole les CGU et casse à chaque
  rotation.
- Un proxy serveur imposerait par ailleurs d'abandonner `output: 'export'`, donc l'hébergement
  statique gratuit.

À la place, `src/lib/importers.ts` accepte n'importe quelle liste : un titre par ligne, un CSV, ou du
JSON. L'export officiel Netflix (`netflix.com/viewingactivity` → « Tout télécharger ») y rentre
directement. Aucun mot de passe n'est demandé. `ImportMatcher` propose les correspondances et
l'utilisateur valide — jamais d'ajout silencieux.

### Ce qu'un vrai export Netflix a appris au parseur

Un historique réel de 465 lignes a mis au jour quatre défauts que les tests synthétiques ne voyaient
pas :

- **543 espaces insécables U+00A0** (`Saison 6`, `Tale : La Servante`). Non normalisés, ils
  survivaient jusque dans les requêtes API, qui ne trouvaient alors rien.
- **`Épisode N` absent des marqueurs de segment** : `KAOS: Épisode 1..8` produisait 8 fiches
  distinctes au lieu d'une.
- **`1st Saison`** (Netflix mélange l'ordinal anglais et le mot français) ne matchait pas
  `saison\s*\d+` : `The Eminence in Shadow` éclatait en 12 fiches.
- **`\b` échoue devant une lettre accentuée** — `É` n'est pas un caractère de mot, donc
  `\b(?:épisode)` ne matchait jamais `Épisode`. Remplacé par un préfixe de classe explicite.

Résultat : 156 candidats bruités → **75 candidats propres**, sans résidu ni NBSP, avec numéros
d'épisode détectés.

Une deuxième passe sur le même fichier a réduit encore de 75 à **48 candidats**, en remplaçant la
liste de mots-clés par une **détection statistique de familles** : Netflix nomme certains épisodes
sans aucun marqueur (`Twilight of the Gods: Le chant de Sigrid`, `Super Mâles: Mâles au cœur`,
`Les Dinosaures: L'ascension`), ce qui produisait 8, 7 et 4 fiches. Le signal fiable n'est pas
lexical : si plusieurs titres **différents** partagent le même premier segment, ce segment est le nom
de la série. Un film à deux-points n'apparaît qu'une fois et reste donc intact.

### Le quota AniList, et pourquoi l'import semblait ne rien trouver

`x-ratelimit-limit: 30` — **30 requêtes par minute**. L'import faisait une requête par titre à
750 ms, soit 80/min : au-delà de la 30ᵉ ligne, tout répondait `429`, et l'erreur était avalée par un
`catch` silencieux qui affichait « Aucune correspondance ». Un problème de débit se lisait donc comme
une absence de résultat.

Deux corrections : les recherches sont **regroupées par 8 dans une seule requête** via les alias
GraphQL (48 titres = **6 requêtes**, quota jamais approché, mesuré `remaining` entre 24 et 29), et
un échec de recherche affiche désormais « recherche impossible » au lieu de « aucune
correspondance » — la distinction compte.

Le titre anglais d'AniList était par ailleurs jeté : `SearchResult.title` ne contenait que le romaji
et `originalTitle` le japonais, si bien que `The Eminence in Shadow` — qui n'existe que dans le champ
`english` — ne matchait jamais. D'où le champ `altTitles`.

Le seuil de rapprochement a lui aussi été durci après mesure. À 0,45 de similarité brute, l'import
appariait **`The Crown` → `The Everlasting Guilty Crown`** et **`Lupin` → `Lupin 8-sei`** : deux faux
positifs ajoutés silencieusement. Le filtre passe maintenant par `titlesMatch`, qui exige au moins
2 tokens partagés — les deux faux positifs disparaissent, les 10 vrais positifs testés survivent.

### Se passer entièrement de TMDB

TMDB exige nom, adresse et un motif d'utilisation pour délivrer une clé. La chaîne suivante atteint
un résultat comparable **sans aucune inscription** :

```
titre FR ──> TVmaze (recherche directe)                    33/48
   │           TVmaze indexe les titres alternatifs par pays,
   │           donc "La Chronique des Bridgerton" trouve "Bridgerton"
   │
   └─ échec ─> Wikidata (libellé EN, filtré sur P31 = série)
               Wikipédia FR (lien interlangue)              +9
               puis nouvelle recherche TVmaze
```

Mesuré sur l'export Netflix réel de 48 titres : **42 identifiés**. Les 6 restants sont des **films**
(Enola Holmes 3, Kingsman, Rebel Moon…) que TVmaze ne couvre pas par nature — et que l'app ne suit
pas de toute façon.

Les deux traducteurs sont conservés **tous les deux** parce qu'ils échouent sur des cas différents :

| Titre                | Wikidata                            | Wikipédia FR                  |
| -------------------- | ----------------------------------- | ----------------------------- |
| `La Reine Charlotte` | ✅ Queen Charlotte: A Bridgerton Story | ❌ la personne historique      |
| `L'Impératrice`      | ✅ The Empress                        | ❌ Élisabeth d'Autriche        |
| `Mercredi`           | ❌ Q128, le jour de la semaine         | ✅ Wednesday                   |
| `Du mouvement de la Terre` | ❌ aucune entité                 | ✅ Orb: On the Movements of the Earth |

Deux détails qui ont demandé un correctif :

- **Les suffixes de désambiguïsation cassent la recherche.** `The Diplomat (American TV series)` ne
  trouve rien ; nettoyé en `The Diplomat`, il trouve la série sur Netflix.
- **Wikimedia limite au burst, pas seulement au débit moyen.** Deux requêtes simultanées suffisent à
  déclencher `429 You are making too many requests`, renvoyé **en texte brut**. Non géré, ça faisait
  échouer la traduction en silence et la série paraissait introuvable — un faux négatif qui m'a
  d'abord fait conclure à tort que 3 séries étaient absentes. D'où la file séquentielle, l'espacement
  minimum et la reprise avec backoff dans `titles.ts`, plus un cache de 30 jours.

Le compromis assumé : TVmaze donne la chaîne **d'origine**, pas la disponibilité française.
`The Handmaid's Tale` y est rattaché à Hulu. Pour les productions Netflix — l'essentiel d'un
historique Netflix — c'est juste. Les écarts se corrigent en deux touches dans Ma liste, et
l'override local reste prioritaire. Une clé TMDB supprime cet écart, sans rien changer d'autre.

### Le rôle historique de TMDB dans l'import

Mesuré sur un export Netflix français réel : **AniList ne rapproche que 5 des 48 titres.** Ce n'est
pas un défaut d'algorithme, c'est structurel — AniList ne stocke **aucun libellé français** :

| Titre Netflix FR           | Ce qu'AniList connaît               |
| -------------------------- | ----------------------------------- |
| `Du mouvement de la Terre` | `Orb: On the Movements of the Earth` |
| `Valkyrie Apocalypse`      | `Record of Ragnarok`                 |
| `Maniac par Junji Ito`     | `Junji Ito Maniac`                   |
| `KonoSuba`                 | `Kono Subarashii Sekai ni Shukufuku wo!` |

Aucun réglage de seuil ne rapproche ces paires. TMDB interrogé en `fr-FR` connaît les titres
français **et** couvre l'animation, occidentale comprise. L'import l'interroge donc en premier, et
AniList ne sert plus que pour les titres déjà en romaji et pour le planning de diffusion.

Conséquence pratique : **sans clé TMDB, un import français est inexploitable** (5 titres sur 48).
Le dialogue d'import le dit explicitement avant de lancer la recherche.

### Le piège des homonymes exacts, côté agenda

Un bug signalé après coup, instructif : l'agenda affichait les prochains épisodes de **l'anime**
One Piece sur ADN alors que seule la **série live-action Netflix** était suivie.

`videosToEntries` recevait *tous* les items suivis et les rapprochait par titre. Les deux One Piece
portant un titre rigoureusement identique, `titlesMatch` renvoyait vrai — et comme il n'y avait qu'un
seul candidat, la règle d'unicité qui protège des ambiguïtés ne se déclenchait pas.

Le correctif n'est pas dans le rapprochement mais dans l'**éligibilité** : ADN ne diffuse que de
l'animation japonaise, donc un item live-action ne peut jamais recevoir un épisode ADN. Un lien
`adnShowId` explicite reste prioritaire, puisqu'il vient d'un rapprochement déjà validé.

Corollaire : `kind: 'series'` ne suffisait pas à étiqueter l'affichage, parce qu'il couvre à la fois
le live-action (The Witcher) et l'animation occidentale (Arcane, Castlevania) — appeler la seconde
« Live action » serait faux. D'où le champ **`subtype`** (`live` / `animation`), renseigné par chaque
provider : TVmaze le donne proprement via son `type` (`Scripted` vs `Animation`, vérifié), TMDB via
le genre 16, AniList et ADN valant toujours `animation`.

L'étiquette **Live action** s'affiche donc après le titre dans l'agenda, Ma liste, la recherche et
l'import. Rien n'est affiché quand `subtype` est inconnu : mieux vaut pas d'étiquette qu'une étiquette
devinée. Les fiches ajoutées avant ce champ se complètent via Import → « Réenrichir les fiches ».

### Homonymes anime / live-action

`One Piece` dans un export Netflix désigne la série live-action de 2023, pas l'anime de 1999. Les
deux existent et portent le même titre exactement, donc aucun algorithme de titre ne peut les
départager. L'import demande donc **la plateforme d'origine de la liste** : Netflix / Disney+ /
Prime Video favorisent le live-action, Crunchyroll / ADN favorisent l'anime. Les deux candidats
restent proposés, l'ordre change, et la fiche est signalée en ambre avec un avertissement explicite
quand les deux genres portent le titre. La plateforme choisie est aussi pré-remplie sur les fiches
ajoutées.

La progression n'est reportée depuis l'import que si elle est **sans ambiguïté** (saison 1 ou saison
absente) : les numéros d'épisode Netflix sont relatifs à la saison, donc « S3 É7 » ne signifie pas
« 7 épisodes vus ».

**Pas de notifications push.** Ça demanderait un serveur et un cron, donc la même bascule
architecturale.

---

## Hors ligne

Deux niveaux, volontairement séparés :

- **`public/sw.js`** ne met en cache que la coque de l'app (les 4 onglets, les bundles, les
  jaquettes). Écrit à la main plutôt que via `next-pwa`, qui casse à chaque version majeure de Next.
- **Les données** sont cachées en IndexedDB par l'app elle-même (`cacheGet` / `cacheSet`), avec TTL
  et repli sur une version périmée si le réseau est absent.

Cette séparation évite le piège classique du planning servi indéfiniment depuis un cache HTTP.

---

## Sauvegarde

Tout est local, donc **l'export est la seule copie**. Import → Exporter produit un JSON complet
(liste + progression + préférences), réimportable en mode fusion. À faire avant de changer de
téléphone ou de vider le cache du navigateur.

---

## Déploiement

`npm run build` produit `out/`, un site purement statique déployable n'importe où (Vercel, Netlify,
GitHub Pages, Cloudflare Pages). Une seule contrainte : **HTTPS**, sans quoi le service worker ne
s'enregistre pas et la PWA ne s'installe pas.

Installation sur le téléphone : iPhone → Partager → « Sur l'écran d'accueil ». Android → menu ⋮ →
« Installer l'application ».

---

## Structure

```
src/
  app/
    page.tsx              agenda de la semaine
    recherche/            ajout de séries
    bibliotheque/         ma liste, progression, overrides
    import/                récupération de liste, sauvegarde, clé TMDB
  components/
    AppShell.tsx          navigation basse + en-tête
    EntryCard.tsx         ligne d'épisode
    ImportMatcher.tsx     rapprochement d'une liste importée
    PlatformBadge.tsx     badges et filtres plateformes
  lib/
    types.ts              modèle, dont LocalOverrides
    db.ts                 IndexedDB, réglages, cache, export/import
    match.ts              rapprochement de titres
    importers.ts          parsing CSV / texte / JSON
    library.ts            ajout et enrichissement des fiches
    week.ts               calcul de semaine (date-fns, locale fr)
    platforms.ts          normalisation des noms de plateformes
    providers/
      anilist.ts  adn.ts  tmdb.ts  index.ts (arbitrage)
scripts/
  generate-icons.mjs      icônes PNG via sharp
```

## Notes techniques

- **TypeScript est épinglé en 5.x** : la 7.0 (réécriture native) casse la lecture des `paths` du
  `tsconfig` par Next 15.5, et tous les imports `@/…` échouent à la compilation.
- Les jaquettes utilisent `<img>` et non `next/image` : l'export statique désactive l'optimisation
  d'images, et les URLs sont externes.

'use client';

import { PLATFORMS } from '@/lib/platforms';
import type { PlatformId } from '@/lib/types';

/**
 * Tutoriels d'export par plateforme, en accordeon.
 *
 * Chaque lien a ete verifie : une redirection vers la page de connexion prouve
 * que la route existe. Plusieurs chemins plausibles se sont reveles faux et ont
 * ete ecartes — tous les `amazon.fr/gp/video/*` renvoient 404, ainsi que les
 * sept chemins de compte ADN testes.
 *
 * En revanche les libelles exacts des boutons sont derriere une authentification
 * que rien ici ne peut atteindre. Les etapes decrivent donc ou aller et quoi
 * chercher, sans inventer des intitules precis : c'est signale a l'utilisateur
 * plutot que masque.
 */

type Method = 'direct' | 'rgpd' | 'manuel';

const METHOD_META: Record<Method, { label: string; className: string }> = {
  direct: {
    label: 'Export immédiat',
    className: 'bg-green-500/15 text-green-700 dark:text-green-400 ring-green-500/30',
  },
  rgpd: {
    label: 'Demande RGPD · quelques jours',
    className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 ring-amber-500/30',
  },
  manuel: {
    label: 'Copier-coller',
    className: 'bg-neutral-500/15 text-neutral-600 dark:text-neutral-300 ring-neutral-500/30',
  },
};

interface Guide {
  platform: PlatformId;
  method: Method;
  /** Resume en une ligne, visible sans ouvrir l'accordeon. */
  summary: string;
  steps: React.ReactNode[];
  /** Precision honnete sur ce que la methode ne couvre pas. */
  caveat?: React.ReactNode;
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="break-all font-medium underline decoration-dotted"
      style={{ color: 'var(--accent)' }}
    >
      {children}
    </a>
  );
}

const GUIDES: Guide[] = [
  {
    platform: 'netflix',
    method: 'direct',
    summary: 'Un CSV téléchargeable en trois clics, sans attente.',
    steps: [
      <>
        Ouvre <Ext href="https://www.netflix.com/viewingactivity">netflix.com/viewingactivity</Ext>{' '}
        <strong>en étant sur le bon profil</strong> — l’historique est par profil, pas par compte.
      </>,
      <>Descends tout en bas de la liste : le lien de téléchargement est sous les dernières lignes.</>,
      <>
        Tu obtiens un fichier <code>NetflixViewingHistory.csv</code> au format{' '}
        <code>Title,Date</code>.
      </>,
      <>
        Reviens ici, choisis <strong>Netflix</strong> comme source ci-dessus, puis dépose le fichier.
      </>,
    ],
    caveat: (
      <>
        C’est l’<strong>historique</strong>, pas « Ma liste » — celle-ci n’a aucun export, il faut
        copier ses titres à la main. Pour un export complet du compte (plus lent, plusieurs jours),
        il existe <Ext href="https://www.netflix.com/account/getmyinfo">netflix.com/account/getmyinfo</Ext>
        , mais le CSV ci-dessus suffit largement.
      </>
    ),
  },
  {
    platform: 'primevideo',
    method: 'rgpd',
    summary: 'Historique consultable en ligne, export complet sur demande.',
    steps: [
      <>
        Ton historique est sur{' '}
        <Ext href="https://www.primevideo.com/settings/watch-history">
          primevideo.com/settings/watch-history
        </Ext>{' '}
        — consultable, mais je n’ai pas pu vérifier qu’un bouton de téléchargement y existe.
      </>,
      <>
        Le plus fiable : sélectionne la page et copie les titres, puis colle-les dans la zone de
        texte ci-dessus (un titre par ligne, le parseur nettoie le reste).
      </>,
      <>
        Pour un vrai fichier, passe par{' '}
        <Ext href="https://www.amazon.fr/gp/privacycentral/dsar/preview.html">
          Amazon Privacy Central
        </Ext>{' '}
        et demande tes données Prime Video. Tu reçois une archive par mail sous quelques jours.
      </>,
      <>
        Source à sélectionner : <strong>Prime Video</strong>.
      </>,
    ],
    caveat: (
      <>
        Aucun chemin <code>amazon.fr/gp/video/…</code> ne fonctionne — je les ai testés, ils
        renvoient tous une erreur 404. Passe bien par <code>primevideo.com</code>.
      </>
    ),
  },
  {
    platform: 'disneyplus',
    method: 'rgpd',
    summary: 'Aucun export en libre-service : demande formelle ou copie manuelle.',
    steps: [
      <>
        Disney+ n’offre pas de téléchargement d’historique depuis l’interface. La voie officielle est
        le portail de confidentialité :{' '}
        <Ext href="https://privacy.thewaltdisneycompany.com/fr/">
          privacy.thewaltdisneycompany.com/fr
        </Ext>
        , rubrique de demande d’accès à tes données.
      </>,
      <>
        En pratique, c’est plus rapide d’ouvrir ta liste dans l’app Disney+ et de recopier les titres
        qui t’intéressent.
      </>,
      <>
        Colle-les dans la zone de texte ci-dessus avec <strong>Disney+</strong> comme source.
      </>,
    ],
    caveat: (
      <>
        Je n’ai pas pu confirmer de lien direct vers le formulaire lui-même : l’URL que j’ai testée
        renvoie une erreur serveur. Pars de la racine du portail.
      </>
    ),
  },
  {
    platform: 'crunchyroll',
    method: 'manuel',
    summary: 'Pas d’export ni d’API accessible : copie depuis ta watchlist.',
    steps: [
      <>
        Ouvre <Ext href="https://www.crunchyroll.com/fr/watchlist">crunchyroll.com/fr/watchlist</Ext>{' '}
        (page confirmée accessible).
      </>,
      <>Sélectionne la liste et copie-la, telle quelle.</>,
      <>
        Colle dans la zone de texte ci-dessus : les numéros d’épisode et les mentions de saison sont
        retirés automatiquement, et les doublons regroupés.
      </>,
      <>
        Source à sélectionner : <strong>Crunchyroll</strong> — ça oriente aussi les homonymes vers
        l’anime plutôt que le live-action.
      </>,
    ],
    caveat: (
      <>
        Crunchyroll ne propose aucun export, et son API exige un identifiant d’appareil non publié
        qu’ils font tourner — aucune automatisation fiable n’est possible, même avec tes identifiants.
      </>
    ),
  },
  {
    platform: 'adn',
    method: 'manuel',
    summary: 'Copie manuelle — mais les dates de sortie ADN arrivent déjà tout seules.',
    steps: [
      <>
        Connecte-toi sur{' '}
        <Ext href="https://animationdigitalnetwork.com/">animationdigitalnetwork.com</Ext> et ouvre
        ton historique ou ta liste via le menu de profil.
      </>,
      <>Copie les titres et colle-les dans la zone de texte ci-dessus.</>,
      <>
        Source à sélectionner : <strong>ADN</strong>.
      </>,
    ],
    caveat: (
      <>
        Je n’ai pas pu te donner d’URL directe : j’ai testé sept chemins de compte plausibles, tous
        en 404. Passe par le menu du site. Bonne nouvelle en revanche — l’agenda récupère déjà
        automatiquement les <strong>vraies dates de sortie françaises</strong> d’ADN pour tes séries
        suivies, sans que tu aies à te connecter.
      </>
    ),
  },
];

export function ExportGuides() {
  return (
    <div className="space-y-2">
      <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        Les liens ci-dessous sont vérifiés. Les intitulés exacts des boutons, eux, sont derrière ta
        connexion : les étapes disent où aller et quoi chercher, l’habillage peut différer un peu.
      </p>

      {GUIDES.map((guide) => {
        const meta = PLATFORMS[guide.platform];
        const method = METHOD_META[guide.method];

        return (
          <details
            key={guide.platform}
            className="group overflow-hidden rounded-xl border"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
          >
            <summary className="tap flex cursor-pointer list-none items-center gap-2 p-3">
              <span
                aria-hidden="true"
                className="h-8 w-1 shrink-0 rounded-full"
                style={{ background: meta.color }}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-semibold">{meta.label}</span>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ring-1 ring-inset ${method.className}`}
                  >
                    {method.label}
                  </span>
                </span>
                <span
                  className="mt-0.5 block text-[11px] leading-snug"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {guide.summary}
                </span>
              </span>
              {/* Chevron pilote par l'etat natif de <details> : aucun JS. */}
              <svg
                aria-hidden="true"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                className="shrink-0 transition-transform group-open:rotate-180"
                style={{ color: 'var(--text-muted)' }}
              >
                <path
                  d="M6 9l6 6 6-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </summary>

            <div className="border-t px-3 pb-3 pt-2.5" style={{ borderColor: 'var(--border)' }}>
              <ol className="space-y-2">
                {guide.steps.map((step, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span
                      aria-hidden="true"
                      className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold"
                      style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
                    >
                      {i + 1}
                    </span>
                    <span className="text-[11px] leading-relaxed">{step}</span>
                  </li>
                ))}
              </ol>

              {guide.caveat && (
                <p
                  className="mt-3 rounded-lg px-2.5 py-2 text-[10px] leading-relaxed"
                  style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
                >
                  {guide.caveat}
                </p>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

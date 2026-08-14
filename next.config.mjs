/** @type {import('next').NextConfig} */
const nextConfig = {
  // Export statique : aucun backend, deployable sur Vercel / Netlify / GitHub Pages.
  // Toutes les APIs consommees (AniList, ADN, TMDB) renvoient Access-Control-Allow-Origin: *
  // donc le navigateur peut les appeler directement.
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;

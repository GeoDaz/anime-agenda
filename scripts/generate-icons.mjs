/**
 * Genere les icones PNG de la PWA depuis un SVG inline.
 *
 * Un vrai PNG est indispensable : iOS ignore les icones SVG du manifest, et une
 * PWA sans icone valide ne s'installe pas proprement sur l'ecran d'accueil.
 *
 *   npm run icons
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'icons');

/** Icone : une grille de calendrier avec un marqueur de diffusion. */
function svg({ padding }) {
  const S = 512;
  const inner = S - padding * 2;
  const x = padding;
  const y = padding + inner * 0.06;
  const w = inner;
  const h = inner * 0.88;
  const r = inner * 0.16;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8b7dff"/>
      <stop offset="1" stop-color="#5b4bd6"/>
    </linearGradient>
  </defs>
  <rect width="${S}" height="${S}" fill="#0d0d10"/>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="url(#bg)"/>
  <rect x="${x + w * 0.08}" y="${y + h * 0.26}" width="${w * 0.84}" height="${h * 0.6}" rx="${r * 0.4}" fill="#0d0d10" opacity="0.28"/>
  <g fill="#ffffff">
    <rect x="${x + w * 0.24}" y="${y - h * 0.06}" width="${w * 0.08}" height="${h * 0.18}" rx="${w * 0.04}"/>
    <rect x="${x + w * 0.68}" y="${y - h * 0.06}" width="${w * 0.08}" height="${h * 0.18}" rx="${w * 0.04}"/>
  </g>
  <g fill="#ffffff" opacity="0.9">
    <circle cx="${x + w * 0.28}" cy="${y + h * 0.46}" r="${w * 0.045}"/>
    <circle cx="${x + w * 0.5}" cy="${y + h * 0.46}" r="${w * 0.045}"/>
    <circle cx="${x + w * 0.72}" cy="${y + h * 0.46}" r="${w * 0.045}"/>
    <circle cx="${x + w * 0.28}" cy="${y + h * 0.68}" r="${w * 0.045}"/>
  </g>
  <circle cx="${x + w * 0.61}" cy="${y + h * 0.68}" r="${w * 0.105}" fill="#ff7b3d"/>
</svg>`;
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const jobs = [
    // `any` : l'icone occupe presque tout le canevas.
    { name: 'icon-192.png', size: 192, padding: 40 },
    { name: 'icon-512.png', size: 512, padding: 40 },
    { name: 'apple-touch-icon.png', size: 180, padding: 30 },
    // `maskable` : Android recadre en cercle, il faut 20 % de marge de securite.
    { name: 'maskable-512.png', size: 512, padding: 108 },
  ];

  for (const job of jobs) {
    const buf = await sharp(Buffer.from(svg({ padding: job.padding })))
      .resize(job.size, job.size)
      .png({ compressionLevel: 9 })
      .toBuffer();
    await writeFile(resolve(outDir, job.name), buf);
    console.log(`  ${job.name.padEnd(24)} ${job.size}x${job.size}`);
  }

  // Favicon SVG : net a toutes les tailles sur desktop.
  await writeFile(resolve(outDir, 'icon.svg'), svg({ padding: 40 }), 'utf8');
  console.log('  icon.svg');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

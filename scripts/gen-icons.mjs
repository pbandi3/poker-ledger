// Rasterize icons/icon.svg into the PNGs the manifest + iOS expect.
// Run once (needs network for the first `npm install`): npm run icons
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(join(root, 'icons', 'icon.svg'));

const targets = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'apple-touch-icon.png', size: 180 },
  // Maskable: render on a solid safe-zone background.
  { file: 'icon-maskable-512.png', size: 512, bg: '#0b1220', pad: 0.12 },
];

for (const t of targets) {
  let pipeline = sharp(svg, { density: 512 }).resize(t.size, t.size, { fit: 'contain' });
  if (t.bg) {
    const inner = Math.round(t.size * (1 - t.pad * 2));
    pipeline = sharp({
      create: {
        width: t.size,
        height: t.size,
        channels: 4,
        background: t.bg,
      },
    }).composite([
      { input: await sharp(svg, { density: 512 }).resize(inner, inner).png().toBuffer() },
    ]);
  }
  await pipeline.png().toFile(join(root, 'icons', t.file));
  console.log('wrote icons/%s (%dx%d)', t.file, t.size, t.size);
}

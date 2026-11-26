// Builds build/icon.png + build/icon.ico from build/logo.png (white kestrel mark).
// The mark is placed on KSTRL's dark tile with a red glow so it reads on light and dark taskbars.
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { writeFileSync } from 'node:fs';

const SIZE = 1024;
const tile = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
  <defs>
    <radialGradient id="g" cx="50%" cy="42%" r="70%">
      <stop offset="0%" stop-color="#2a1010"/>
      <stop offset="55%" stop-color="#141416"/>
      <stop offset="100%" stop-color="#0b0b0d"/>
    </radialGradient>
  </defs>
  <rect x="24" y="24" width="${SIZE - 48}" height="${SIZE - 48}" rx="210" fill="url(#g)"/>
  <rect x="24" y="24" width="${SIZE - 48}" height="${SIZE - 48}" rx="210" fill="none" stroke="#ff3d3d" stroke-opacity=".55" stroke-width="10"/>
</svg>`);

const mark = await sharp('build/logo.png').trim().resize(640, 640, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
const icon = await sharp(tile).composite([{ input: mark, gravity: 'center' }]).png().toBuffer();
writeFileSync('build/icon.png', icon);
writeFileSync('public/icon.png', icon);

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(sizes.map((s) => sharp(icon).resize(s, s).png().toBuffer()));
writeFileSync('build/icon.ico', await pngToIco(pngs));
console.log('icons written: build/icon.png, build/icon.ico, public/icon.png');

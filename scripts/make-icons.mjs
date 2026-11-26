// Builds build/icon.png + build/icon.ico from build/logo.png (white kestrel mark).
// The mark is placed on KSTRL's dark tile so it reads on light and dark taskbars.
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { writeFileSync } from 'node:fs';

const SIZE = 1024;
const tile = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
  <defs>
    <radialGradient id="g" cx="50%" cy="42%" r="70%">
      <stop offset="0%" stop-color="#262626"/>
      <stop offset="60%" stop-color="#141416"/>
      <stop offset="100%" stop-color="#0c0c0c"/>
    </radialGradient>
  </defs>
  <rect x="24" y="24" width="${SIZE - 48}" height="${SIZE - 48}" rx="210" fill="url(#g)"/>
  <rect x="28" y="28" width="${SIZE - 56}" height="${SIZE - 56}" rx="206" fill="none" stroke="#ffffff" stroke-opacity=".10" stroke-width="6"/>
</svg>`);

const mark = await sharp('build/logo.png').trim().resize(640, 640, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
const icon = await sharp(tile).composite([{ input: mark, gravity: 'center' }]).png().toBuffer();
writeFileSync('build/icon.png', icon);
writeFileSync('public/icon.png', icon);

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(sizes.map((s) => sharp(icon).resize(s, s).png().toBuffer()));
writeFileSync('build/icon.ico', await pngToIco(pngs));
console.log('icons written: build/icon.png, build/icon.ico, public/icon.png');

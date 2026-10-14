import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const source = path.resolve('apps/miniapp/design-assets/cardBackground');
const destination = path.resolve('apps/miniapp/src/static/cardBackground');
await mkdir(destination, { recursive: true });
for (const file of await readdir(source)) {
  // This supplied file duplicates aLittle.svg; keep its source without shipping it twice.
  if (!file.endsWith('.svg') || file === 'aLittle2.svg') continue;
  await sharp(path.join(source, file)).resize(636, 1024)
    .png({ palette: true, colours: 128, dither: 0.5 })
    .toFile(path.join(destination, file.replace(/\.svg$/, '.png')));
}
console.log('Prepared eight card backgrounds at 2× resolution.');

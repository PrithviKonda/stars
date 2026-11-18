// Builds data/sky.json from the d3-celestial data files (stars to magnitude 6,
// star names, constellation figures) and copies the vendored runtime files
// with their licences.
// Run with: npm run build:data
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules/d3-celestial/data');
const read = (name) => JSON.parse(readFileSync(join(src, name), 'utf8'));

const ra = (lon) => +(lon < 0 ? lon + 360 : lon).toFixed(4);
const round = (v, digits) => +(+v).toFixed(digits);

const starFeatures = read('stars.6.json').features;
const starNames = read('starnames.json');
const conPoints = read('constellations.json').features;
const conLines = read('constellations.lines.json').features;

// Brightest first, so the renderer can stop at the magnitude limit.
starFeatures.sort((a, b) => a.properties.mag - b.properties.mag);

const stars = [];
const names = {};
for (const f of starFeatures) {
  const [lon, lat] = f.geometry.coordinates;
  const bv = Number.parseFloat(f.properties.bv);
  stars.push(ra(lon), round(lat, 4), round(f.properties.mag, 2), Number.isFinite(bv) ? round(bv, 2) : 0.6, f.id);
  const n = starNames[f.id];
  if (!n) continue;
  const letter = n.bayer || n.flam || '';
  if (n.name || letter) names[f.id] = [n.name || '', letter, n.c || ''];
}

if (conPoints.length !== conLines.length) throw new Error('constellation files are out of step');
const constellations = conPoints.map((p, i) => {
  const l = conLines[i];
  if (l.id !== p.id) throw new Error(`constellation order mismatch at ${i}: ${p.id} vs ${l.id}`);
  return {
    id: p.id,
    name: p.properties.name,
    gen: p.properties.gen,
    label: [ra(p.geometry.coordinates[0]), round(p.geometry.coordinates[1], 2)],
    lines: l.geometry.coordinates.map((line) => line.map(([lon, lat]) => [ra(lon), round(lat, 4)])),
  };
});

mkdirSync(join(root, 'data'), { recursive: true });
writeFileSync(join(root, 'data/sky.json'), JSON.stringify({ stars, names, constellations }));
console.log(`data/sky.json: ${stars.length / 5} stars, ${Object.keys(names).length} named, ${constellations.length} constellation figures`);

// Runtime files served straight from the repo (no bundler).
mkdirSync(join(root, 'vendor/fonts'), { recursive: true });
const copies = [
  ['node_modules/astronomy-engine/astronomy.browser.min.js', 'vendor/astronomy.browser.min.js'],
  ['node_modules/@fontsource/marcellus/files/marcellus-latin-400-normal.woff2', 'vendor/fonts/marcellus-400.woff2'],
  ['node_modules/@fontsource/instrument-sans/files/instrument-sans-latin-400-normal.woff2', 'vendor/fonts/instrument-sans-400.woff2'],
  ['node_modules/@fontsource/instrument-sans/files/instrument-sans-latin-600-normal.woff2', 'vendor/fonts/instrument-sans-600.woff2'],
];
for (const [from, to] of copies) copyFileSync(join(root, from), join(root, to));

// Licence texts for the files above and for the catalogue's source data.
mkdirSync(join(root, 'vendor/licenses'), { recursive: true });
const astronomySource = readFileSync(join(root, 'node_modules/astronomy-engine/astronomy.js'), 'utf8');
const mit = astronomySource.slice(astronomySource.indexOf('MIT License'), astronomySource.indexOf('*/')).replace(/^ {4}/gm, '').trimEnd();
writeFileSync(join(root, 'vendor/licenses/astronomy-engine.txt'), `${mit}\n`);
copyFileSync(join(root, 'node_modules/d3-celestial/LICENSE'), join(root, 'vendor/licenses/d3-celestial.txt'));
copyFileSync(join(root, 'node_modules/@fontsource/marcellus/LICENSE'), join(root, 'vendor/licenses/marcellus.txt'));
copyFileSync(join(root, 'node_modules/@fontsource/instrument-sans/LICENSE'), join(root, 'vendor/licenses/instrument-sans.txt'));
console.log(`copied ${copies.length} vendored files`);

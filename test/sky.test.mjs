import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import * as Astronomy from 'astronomy-engine';
import {
  unitVector, skyMatrix, rotate, azAlt, computeBodies, loadCatalog, starTitle, starDesignation, compassPoint, mul3,
} from '../js/sky.js';
import { focalLength, fovAcross, limitingMagnitude } from '../js/view.js';
import { cameraFromAzAlt } from '../js/orientation.js';

const RAD = Math.PI / 180;
const catalog = loadCatalog(JSON.parse(readFileSync(new URL('../data/sky.json', import.meta.url), 'utf8')));
const starIndex = (name) => {
  const i = catalog.proper.indexOf(name);
  assert.ok(i >= 0, `${name} should be in the catalogue`);
  return i;
};
const starVec = (name) => Array.from(catalog.vec.slice(starIndex(name) * 3, starIndex(name) * 3 + 3));
// Angle between two directions; atan2 form stays exact for tiny angles and
// for the float32 catalogue vectors, which are unit length only to ~1e-7.
const separation = (a, b) => {
  const cross = Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
  return Math.atan2(cross, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / RAD;
};

test('catalogue carries the stars people know, in the right place', () => {
  assert.equal(catalog.n, 5044);
  assert.equal(catalog.proper[0], 'Sirius', 'brightest star comes first');
  for (let i = 1; i < catalog.n; i++) assert.ok(catalog.mag[i] >= catalog.mag[i - 1], 'stars must be sorted brightest first');
  // Vega: RA 18h36m56s, Dec +38d47m (J2000).
  assert.ok(separation(starVec('Vega'), unitVector(279.2347, 38.7837)) < 0.01, 'Vega position');
  assert.equal(starDesignation(catalog, starIndex('Vega')), 'α Lyrae');
  assert.equal(starTitle(catalog, starIndex('Betelgeuse')), 'Betelgeuse');
  assert.equal(catalog.constellations.filter((c) => c.lines.length > 0).length, 89, 'every constellation has a figure');
});

test('Polaris sits at the observer\'s latitude, due north, at any hour', () => {
  fc.assert(fc.property(
    fc.double({ min: 5, max: 85, noNaN: true }),
    fc.double({ min: -180, max: 180, noNaN: true }),
    fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 0, 1) }),
    (lat, lon, ms) => {
      const p = azAlt(rotate(skyMatrix(Astronomy, new Date(ms), lat, lon), starVec('Polaris')));
      assert.ok(Math.abs(p.alt - lat) < 0.8, `Polaris altitude ${p.alt} should be within 0.8 of latitude ${lat}`);
      const offNorth = Math.abs(((p.az + 180) % 360) - 180) * Math.cos(p.alt * RAD);
      assert.ok(offNorth < 0.8, `Polaris should be within 0.8 degrees of due north, got azimuth ${p.az}`);
    },
  ));
});

test('star positions agree with astronomy-engine\'s own horizon calculation', () => {
  fc.assert(fc.property(
    fc.integer({ min: 0, max: catalog.n - 1 }),
    fc.double({ min: -89, max: 89, noNaN: true }),
    fc.double({ min: -180, max: 180, noNaN: true }),
    fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 0, 1) }),
    (i, lat, lon, ms) => {
      const date = new Date(ms);
      const v = Array.from(catalog.vec.slice(i * 3, i * 3 + 3));
      const mine = rotate(skyMatrix(Astronomy, date, lat, lon), v);
      // Independent route: precess to the equator of date, then Horizon().
      const time = Astronomy.MakeTime(date);
      const ofDate = Astronomy.RotateVector(Astronomy.Rotation_EQJ_EQD(time), new Astronomy.Vector(v[0], v[1], v[2], time));
      const eq = Astronomy.EquatorFromVector(ofDate);
      const hor = Astronomy.Horizon(time, new Astronomy.Observer(lat, lon, 0), eq.ra, eq.dec);
      const theirs = [Math.sin(hor.azimuth * RAD) * Math.cos(hor.altitude * RAD), Math.cos(hor.azimuth * RAD) * Math.cos(hor.altitude * RAD), Math.sin(hor.altitude * RAD)];
      assert.ok(separation(mine, theirs) < 0.001, `star ${i} is ${separation(mine, theirs)} degrees from the reference position`);
    },
  ), { numRuns: 200 });
});

test('a star crossing the meridian stands at 90 - latitude + declination', () => {
  // Sirius (Dec -16.72) from latitude 40 N culminates 33.3 degrees up, due south.
  const lat = 40, lon = -75;
  const v = starVec('Sirius');
  let best = { alt: -90 };
  const start = Date.UTC(2026, 0, 15);
  for (let minute = 0; minute < 24 * 60; minute += 2) {
    const p = azAlt(rotate(skyMatrix(Astronomy, new Date(start + minute * 60000), lat, lon), v));
    if (p.alt > best.alt) best = p;
  }
  assert.ok(Math.abs(best.alt - (90 - lat - 16.72)) < 0.1, `Sirius culminates at ${best.alt}`);
  assert.ok(Math.abs(best.az - 180) < 1, `Sirius culminates due south, got azimuth ${best.az}`);
});

test('the Moon covers the Sun from Dallas during the 8 April 2024 total eclipse', () => {
  // Totality in Dallas ran from about 18:40 to 18:44 UTC.
  const bodies = computeBodies(Astronomy, new Date(Date.UTC(2024, 3, 8, 18, 42, 30)), 32.78, -96.8);
  const sun = bodies.find((b) => b.name === 'Sun');
  const moon = bodies.find((b) => b.name === 'Moon');
  assert.ok(separation(sun.vec, moon.vec) < 0.1, `Sun and Moon are ${separation(sun.vec, moon.vec)} degrees apart at mid-totality`);
  assert.ok(moon.litFraction < 0.01, `a new moon is unlit, got ${moon.litFraction}`);
  const sunPos = azAlt(rotate(skyMatrix(Astronomy, new Date(Date.UTC(2024, 3, 8, 18, 42, 30)), 32.78, -96.8), sun.vec));
  assert.ok(sunPos.alt > 60 && sunPos.alt < 68, `the eclipsed Sun stood about 64 degrees up, got ${sunPos.alt}`);
});

test('bodies report plausible brightness and distance', () => {
  const bodies = computeBodies(Astronomy, new Date(Date.UTC(2026, 10, 18)), 37.77, -122.42);
  assert.deepEqual(bodies.map((b) => b.name), ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']);
  const by = Object.fromEntries(bodies.map((b) => [b.name, b]));
  assert.ok(by.Sun.mag < -26 && Math.abs(by.Sun.distanceAu - 1) < 0.02, 'Sun');
  assert.ok(by.Jupiter.mag < -1.5 && by.Jupiter.distanceAu > 3.9 && by.Jupiter.distanceAu < 6.5, 'Jupiter');
  assert.ok(by.Moon.distanceAu < 0.003, 'Moon distance is in AU');
  for (const b of bodies) assert.ok(Math.abs(Math.hypot(...b.vec) - 1) < 1e-9, `${b.name} direction is a unit vector`);
});

test('compass points', () => {
  assert.deepEqual([0, 44, 90, 135, 200, 270, 315, 359].map(compassPoint), ['N', 'NE', 'E', 'SE', 'S', 'W', 'NW', 'N']);
});

test('a star lands on screen where the view geometry says it should', () => {
  // Looking due south 30 degrees up with a 60 degree field over 800 px:
  // a star 10 degrees higher on the meridian sits tan(10)*f above centre.
  const f = focalLength(400, 800, 60);
  assert.ok(Math.abs(fovAcross(800, f) - 60) < 1e-9, 'the long side spans the stated field of view');
  const cam = cameraFromAzAlt(180, 30);
  const star = [0, -Math.cos(40 * RAD), Math.sin(40 * RAD)];
  const c = rotate(cam, star);
  assert.ok(Math.abs(c[0]) < 1e-9, 'on the meridian means centred left-right');
  assert.ok(Math.abs((f * c[1]) / c[2] - f * Math.tan(10 * RAD)) < 1e-6, 'height above centre');
  // A star to the east of south (azimuth 170) appears left of centre.
  const east = rotate(cam, [Math.sin(170 * RAD) * Math.cos(30 * RAD), Math.cos(170 * RAD) * Math.cos(30 * RAD), Math.sin(30 * RAD)]);
  assert.ok(east[0] < 0, 'facing south, east is to the left');
});

test('camera feed scale: the overlay matches a cover-fitted video', () => {
  // 1080x1920 portrait video on a 390x844 screen is scaled by height (844/1920).
  const f = focalLength(390, 844, 64, 1, 1080, 1920);
  assert.ok(Math.abs(fovAcross(844, f) - 64) < 1e-9, 'full video height visible, so the screen height spans the camera field');
  // A wider-than-video screen crops the top and bottom of the feed.
  const f2 = focalLength(1000, 500, 64, 1, 1280, 720);
  assert.ok(fovAcross(1000, f2) < 64 + 1e-9 && Math.abs(fovAcross(1000, f2) - 64) < 1e-9, 'full width visible');
  assert.ok(fovAcross(500, f2) < fovAcross(720 * (1000 / 1280), f2), 'height is cropped');
  assert.ok(Math.abs(focalLength(390, 844, 64, 2, 1080, 1920) - 2 * f) < 1e-9, 'zoom scales the focal length');
});

test('fainter stars appear as the view narrows, within catalogue limits', () => {
  assert.equal(limitingMagnitude(60), 5);
  assert.ok(limitingMagnitude(25) > limitingMagnitude(60));
  assert.equal(limitingMagnitude(1), 6.5);
  assert.equal(limitingMagnitude(170), 4);
});

test('mul3 composes rotations', () => {
  const a = cameraFromAzAlt(30, 10), b = cameraFromAzAlt(200, -40);
  const v = [0.36, 0.48, 0.8];
  const viaProduct = rotate(mul3(a, b), v);
  const stepwise = rotate(a, rotate(b, v));
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(viaProduct[i] - stepwise[i]) < 1e-12);
});

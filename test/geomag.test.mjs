import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fc from 'fast-check';
import { declination, decimalYear } from '../js/geomag.js';

const geomagnetism = createRequire(import.meta.url)('geomagnetism');

test('declination matches the reference WMM implementation across the globe', () => {
  fc.assert(
    fc.property(
      fc.double({ min: -85, max: 85, noNaN: true }),
      fc.double({ min: -180, max: 180, noNaN: true }),
      fc.integer({ min: Date.UTC(2025, 0, 2), max: Date.UTC(2029, 10, 1) }),
      (lat, lon, ms) => {
        const date = new Date(ms);
        const expected = geomagnetism.model(date).point([lat, lon]).decl;
        const actual = declination(lat, lon, date);
        const diff = Math.abs(((actual - expected + 540) % 360) - 180);
        // The reference package counts every year as 365 days; allow for that.
        assert.ok(diff < 0.05, `declination at ${lat},${lon} on ${date.toISOString()}: got ${actual}, reference ${expected}`);
      },
    ),
    { numRuns: 300 },
  );
});

test('declination has the right sign and size in familiar places', () => {
  const date = new Date(Date.UTC(2026, 10, 18));
  // Seattle sits well east of the agonic line, New York west of it.
  const seattle = declination(47.6, -122.3, date);
  const newYork = declination(40.7, -74.0, date);
  assert.ok(seattle > 13 && seattle < 17, `Seattle should be about 15 degrees east, got ${seattle}`);
  assert.ok(newYork < -10 && newYork > -15, `New York should be about 12 degrees west, got ${newYork}`);
});

test('declination stays finite at the poles and beyond the model span', () => {
  for (const lat of [-90, 90]) assert.ok(Number.isFinite(declination(lat, 10, new Date())), `pole ${lat}`);
  const late = declination(48, 11, new Date(Date.UTC(2040, 0, 1)));
  const edge = declination(48, 11, new Date(Date.UTC(2030, 0, 1)));
  assert.equal(late, edge, 'years past the model span should hold the last valid value');
});

test('decimalYear is exact at year boundaries', () => {
  assert.equal(decimalYear(new Date(Date.UTC(2026, 0, 1))), 2026);
  assert.ok(Math.abs(decimalYear(new Date(Date.UTC(2026, 6, 2, 12))) - 2026.5) < 0.001);
});

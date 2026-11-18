import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  deviceRotation, cameraFromDevice, cameraFromAzAlt, pointing, blendCamera, CompassFusion, wrap180,
} from '../js/orientation.js';

const RAD = Math.PI / 180;
const row = (m, i) => [m[i * 3], m[i * 3 + 1], m[i * 3 + 2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const close = (a, b, eps, msg) => {
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < eps, `${msg}: got [${a.map((v) => v.toFixed(3))}], expected [${b}]`);
};
const EAST = [1, 0, 0], NORTH = [0, 1, 0], UP = [0, 0, 1], WEST = [-1, 0, 0], SOUTH = [0, -1, 0], DOWN = [0, 0, -1];

const angle = (min, max) => fc.double({ min, max, noNaN: true });

test('phone flat on a table, top to the north: camera looks straight down', () => {
  const cam = cameraFromDevice(0, 0, 0);
  close(row(cam, 0), EAST, 1e-9, 'screen right');
  close(row(cam, 1), NORTH, 1e-9, 'screen up');
  close(row(cam, 2), DOWN, 1e-9, 'camera');
});

test('phone held upright: camera looks at the horizon in the compass direction', () => {
  // alpha is counter-clockwise from north, so alpha 90 faces west.
  const cases = [[0, NORTH, EAST], [90, WEST, NORTH], [180, SOUTH, WEST], [270, EAST, SOUTH]];
  for (const [alpha, forward, right] of cases) {
    const cam = cameraFromDevice(alpha, 90, 0);
    close(row(cam, 2), forward, 1e-9, `camera at alpha ${alpha}`);
    close(row(cam, 0), right, 1e-9, `screen right at alpha ${alpha}`);
    close(row(cam, 1), UP, 1e-9, `screen up at alpha ${alpha}`);
  }
});

test('tilting the top of the phone back past upright raises the view above the horizon', () => {
  const p = pointing(cameraFromDevice(0, 130, 0));
  assert.ok(Math.abs(p.alt - 40) < 1e-6, `expected 40 degrees up, got ${p.alt}`);
  assert.ok(Math.abs(wrap180(p.az)) < 1e-6, `expected still facing north, got ${p.az}`);
});

test('landscape: the page is turned, so screen-up follows the long edge', () => {
  // Rolled a quarter turn counter-clockwise (top edge to the left), camera north at the horizon.
  // Device axes in the world: right edge up, top edge west, screen facing south.
  // Solving the spec's rotation for those axes gives alpha 90, beta 0, gamma -90.
  close(deviceRotation(90, 0, -90), [0, -1, 0, 0, 0, -1, 1, 0, 0], 1e-9, 'pose');
  const cam = cameraFromDevice(90, 0, -90, 90);
  close(row(cam, 2), NORTH, 1e-9, 'camera');
  close(row(cam, 1), UP, 1e-9, 'screen up');
  close(row(cam, 0), EAST, 1e-9, 'screen right');
});

test('camera matrices are right-handed rotations for any sensor reading', () => {
  fc.assert(fc.property(angle(0, 360), angle(-180, 180), angle(-90, 90), fc.constantFrom(0, 90, 180, 270), (a, b, g, s) => {
    const cam = cameraFromDevice(a, b, g, s);
    const [r, u, f] = [row(cam, 0), row(cam, 1), row(cam, 2)];
    for (const v of [r, u, f]) assert.ok(Math.abs(dot(v, v) - 1) < 1e-9, 'rows must be unit length');
    assert.ok(Math.abs(dot(r, u)) < 1e-9 && Math.abs(dot(r, f)) < 1e-9 && Math.abs(dot(u, f)) < 1e-9, 'rows must be perpendicular');
    // right x forward = up keeps the picture unmirrored
    const cross = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    close(cross, u, 1e-9, 'handedness');
  }));
});

test('cameraFromAzAlt points where it is told with a level horizon', () => {
  fc.assert(fc.property(angle(0, 359.9), angle(-89, 89), (az, alt) => {
    const cam = cameraFromAzAlt(az, alt);
    const p = pointing(cam);
    assert.ok(Math.abs(wrap180(p.az - az)) < 1e-6 && Math.abs(p.alt - alt) < 1e-6, `asked ${az}/${alt}, got ${p.az}/${p.alt}`);
    assert.ok(Math.abs(cam[2]) < 1e-12, 'screen-right must stay horizontal');
    assert.ok(cam[5] >= 0, 'screen-up must not point below the horizon');
  }));
});

test('an upright phone and the drag camera agree on the same view', () => {
  close(cameraFromDevice(360 - 75, 90 + 20, 0), cameraFromAzAlt(75, 20), 1e-9, 'az 75 alt 20');
});

test('blendCamera returns a proper rotation and reaches the target', () => {
  const a = cameraFromAzAlt(10, 5);
  const b = cameraFromAzAlt(40, 30);
  const mid = blendCamera(a, b, 0.5);
  const [r, u, f] = [row(mid, 0), row(mid, 1), row(mid, 2)];
  assert.ok(Math.abs(dot(r, u)) < 1e-9 && Math.abs(dot(r, f)) < 1e-9 && Math.abs(dot(f, f) - 1) < 1e-9, 'blend must stay orthonormal');
  close(blendCamera(a, b, 1), b, 1e-9, 'k=1 lands on the target');
});

// --- compass fusion -------------------------------------------------------

// Simulates a browser with drifting alpha: the true absolute alpha is
// alphaRel + offset. `model` says what the reported compass heading follows.
function compassReading(alphaTrue, beta, gamma, model) {
  const r = deviceRotation(alphaTrue, beta, gamma);
  const top = Math.atan2(r[1], r[4]) / RAD;
  const cam = Math.atan2(-r[2], -r[5]) / RAD;
  if (model === 'top') return (top + 360) % 360;
  if (model === 'camera') return (cam + 360) % 360;
  // 'switching': top edge when flat-ish, camera direction when raised
  return ((Math.abs(r[7]) > 0.7 ? cam : top) + 360) % 360;
}

for (const model of ['top', 'camera', 'switching']) {
  test(`fusion recovers the alpha offset and keeps it while looking up (${model} compass)`, () => {
    fc.assert(fc.property(angle(-180, 180), angle(0, 360), (offset, alphaTrue) => {
      const fusion = new CompassFusion();
      const feed = (beta, gamma, n = 1) => {
        let d;
        for (let i = 0; i < n; i++) {
          d = fusion.update(alphaTrue - offset, beta, gamma, compassReading(alphaTrue, beta, gamma, model), 10);
        }
        return d;
      };
      // Tapping Start: phone held in the hand, tilted up about 50 degrees, not rolled.
      feed(50, 0, 5);
      assert.ok(Math.abs(wrap180(fusion.delta - offset)) < 0.5, `after the first samples: delta ${fusion.delta}, true ${offset}`);
      // Raise the phone through upright and on up to near the zenith, slightly rolled.
      for (let beta = 50; beta <= 170; beta += 2) feed(beta, 4, 3);
      assert.ok(Math.abs(wrap180(fusion.delta - offset)) < 8, `after sweeping to the zenith: delta ${fusion.delta}, true ${offset}`);
    }), { numRuns: 60 });
  });
}

test('fusion started while already pointing at the sky corrects itself once the phone is lowered', () => {
  for (const model of ['top', 'camera']) {
    const offset = 77, alphaTrue = 200;
    const fusion = new CompassFusion();
    for (let i = 0; i < 20; i++) fusion.update(alphaTrue - offset, 140, 0, compassReading(alphaTrue, 140, 0, model), 10);
    for (let i = 0; i < 3; i++) fusion.update(alphaTrue - offset, 45, 0, compassReading(alphaTrue, 45, 0, model), 10);
    assert.ok(Math.abs(wrap180(fusion.delta - offset)) < 0.5, `${model}: delta ${fusion.delta}, true ${offset}`);
    assert.equal(fusion.anchored, true);
  }
});

test('fusion ignores readings the compass marks as uncalibrated or missing', () => {
  const fusion = new CompassFusion();
  assert.equal(fusion.update(10, 45, 0, 123, -1), null);
  assert.equal(fusion.update(10, 45, 0, undefined, 10), null);
  assert.equal(fusion.update(10, 45, 0, NaN, 10), null);
});

test('fusion smooths compass noise instead of following each sample', () => {
  const fusion = new CompassFusion();
  fusion.update(0, 45, 0, 0, 10);
  const before = fusion.delta;
  fusion.update(0, 45, 0, 20, 10); // one sample 20 degrees off
  assert.ok(Math.abs(wrap180(fusion.delta - before)) < 2, `one noisy sample moved delta by ${wrap180(fusion.delta - before)}`);
});

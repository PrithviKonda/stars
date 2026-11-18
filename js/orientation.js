// Turns phone sensor readings into a camera pose in the local sky frame.
//
// World frame is East-North-Up (x east, y north, z up), the same earth frame
// the W3C DeviceOrientation spec uses. Matrices are row-major arrays of 9.

const RAD = Math.PI / 180;

export const wrap180 = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;
export const wrap360 = (deg) => ((deg % 360) + 360) % 360;

/**
 * Device -> world rotation for the spec's Z-X'-Y'' angles (degrees). Columns
 * are the device's right, top and out-of-screen axes expressed in ENU.
 */
export function deviceRotation(alpha, beta, gamma) {
  const ca = Math.cos(alpha * RAD), sa = Math.sin(alpha * RAD);
  const cb = Math.cos(beta * RAD), sb = Math.sin(beta * RAD);
  const cg = Math.cos(gamma * RAD), sg = Math.sin(gamma * RAD);
  return [
    ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg,
    sa * cg + ca * sb * sg, ca * cb, sa * sg - ca * sb * cg,
    -cb * sg, sb, cb * cg,
  ];
}

/**
 * World -> camera matrix for the back camera. Rows are the directions of
 * screen-right, screen-up and straight-ahead in ENU. `screenAngle` is
 * screen.orientation.angle: how far the page is rotated from the device's
 * natural (portrait) orientation.
 */
export function cameraFromDevice(alpha, beta, gamma, screenAngle = 0) {
  const r = deviceRotation(alpha, beta, gamma);
  const c = Math.cos(screenAngle * RAD), s = Math.sin(screenAngle * RAD);
  return [
    c * r[0] - s * r[1], c * r[3] - s * r[4], c * r[6] - s * r[7],
    s * r[0] + c * r[1], s * r[3] + c * r[4], s * r[6] + c * r[7],
    -r[2], -r[5], -r[8],
  ];
}

/** World -> camera matrix looking at a compass azimuth and altitude with a level horizon. */
export function cameraFromAzAlt(azDeg, altDeg) {
  const ca = Math.cos(azDeg * RAD), sa = Math.sin(azDeg * RAD);
  const ch = Math.cos(altDeg * RAD), sh = Math.sin(altDeg * RAD);
  return [
    ca, -sa, 0,
    -sa * sh, -ca * sh, ch,
    sa * ch, ca * ch, sh,
  ];
}

/** Compass azimuth (0 = north, 90 = east) and altitude the camera points at. */
export function pointing(cam) {
  return {
    az: wrap360(Math.atan2(cam[6], cam[7]) / RAD),
    alt: Math.asin(Math.max(-1, Math.min(1, cam[8]))) / RAD,
  };
}

/** Moves `current` a fraction `k` of the way to `target` and re-squares it. */
export function blendCamera(current, target, k) {
  const m = current.map((v, i) => v + (target[i] - v) * k);
  // Gram-Schmidt on the rows: keep forward, rebuild right and up around it.
  const f = normalize([m[6], m[7], m[8]]);
  let r = [m[0], m[1], m[2]];
  const d = r[0] * f[0] + r[1] * f[1] + r[2] * f[2];
  r = normalize([r[0] - d * f[0], r[1] - d * f[1], r[2] - d * f[2]]);
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  return [...r, ...u, ...f];
}

function normalize(v) {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

const horizontalHeading = (e, n) => Math.atan2(e, n) / RAD;

/**
 * Finds true-ish north for browsers whose `alpha` drifts from an arbitrary
 * start but which also report a compass heading (iOS Safari's
 * `webkitCompassHeading`). The gyro-driven angles are smooth and fast; the
 * compass is slow and noisy but anchored. This keeps a slowly-corrected offset
 * `delta` such that `alpha + delta` is an absolute alpha.
 *
 * What the compass heading refers to depends on how the phone is held: the top
 * edge when it lies flat, and either the top edge or the camera direction once
 * it is raised, depending on the OS. Samples are therefore only trusted
 * outright where both readings agree; elsewhere a sample is used only if one
 * of the readings is consistent with the offset already established.
 */
export class CompassFusion {
  constructor({ gain = 0.04 } = {}) {
    this.gain = gain;
    this.delta = null; // degrees to add to the relative alpha
    this.anchored = false; // true once a trusted sample has been seen
  }

  update(alpha, beta, gamma, compassHeading, accuracy) {
    if (!Number.isFinite(compassHeading) || (Number.isFinite(accuracy) && accuracy < 0)) return this.delta;
    const r = deviceRotation(alpha, beta, gamma);
    // Device top edge and camera direction in the drifting frame.
    const top = { e: r[1], n: r[4], w: Math.hypot(r[1], r[4]) };
    const cam = { e: -r[2], n: -r[5], w: Math.hypot(r[2], r[5]) };
    const screenUp = r[8];
    // A frame turned counter-clockwise by delta lowers every heading by delta.
    const fromTop = wrap180(horizontalHeading(top.e, top.n) - compassHeading);
    const fromCam = wrap180(horizontalHeading(cam.e, cam.n) - compassHeading);
    const usable = 0.3;

    let sample = null;
    let trusted = false;
    if (screenUp > 0.7 && top.w > usable) {
      sample = fromTop; // lying roughly flat, screen up
      trusted = true;
    } else if (top.w > usable && cam.w > usable && Math.abs(wrap180(fromTop - fromCam)) < 30) {
      sample = wrap180(fromTop + (wrap180(fromCam - fromTop) * cam.w) / (cam.w + top.w));
      trusted = true;
    } else {
      const options = [];
      if (cam.w > usable) options.push(fromCam);
      if (top.w > usable) options.push(fromTop);
      if (this.delta === null) {
        sample = options.length ? options[0] : null;
      } else {
        for (const o of options) {
          const off = Math.abs(wrap180(o - this.delta));
          if (off < 45 && (sample === null || off < Math.abs(wrap180(sample - this.delta)))) sample = o;
        }
      }
    }
    if (sample === null) return this.delta;

    if (this.delta === null || (trusted && !this.anchored)) this.delta = sample;
    else this.delta = wrap180(this.delta + this.gain * wrap180(sample - this.delta));
    if (trusted) this.anchored = true;
    return this.delta;
  }
}

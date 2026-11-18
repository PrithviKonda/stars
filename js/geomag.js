// Magnetic declination from the World Magnetic Model (WMM2025, NOAA/NCEI and
// BGS, public domain). A phone compass reports magnetic north; the sky is laid
// out around true north, and the two differ by up to ~20 degrees in places
// people live, so the heading is corrected with this before drawing.

// Gauss coefficients in nT, indexed n*(n+1)/2 + m, with yearly change dg/dh.
export const WMM = {
  epoch: 2025,
  validUntil: 2030,
  g: [0,-29351.8,-1410.8,-2556.6,2951.1,1649.3,1361,-2404.1,1243.8,453.6,895,799.5,55.7,-281.1,12.1,-233.2,368.9,187.2,-138.7,-142,20.9,64.4,63.8,76.9,-115.7,-40.9,14.9,-60.7,79.5,-77,-8.8,59.3,15.8,2.5,-11.1,14.2,23.2,10.8,-17.5,2,-21.7,16.9,15,-16.8,0.9,4.6,7.8,3,-0.2,-2.5,-13.1,2.4,8.6,-8.7,-12.9,-1.3,-6.4,0.2,2,-1,-0.6,-0.9,1.5,0.9,-2.7,-3.9,2.9,-1.5,-2.5,2.4,-0.6,-0.1,-0.6,-0.1,1.1,-1,-0.2,2.6,-2,-0.2,0.3,1.2,-1.3,0.6,0.6,0.5,-0.1,-0.4,-0.2,-1.3,-0.7],
  h: [0,0,4545.4,0,-3133.6,-815.1,0,-56.6,237.5,-549.5,0,278.6,-133.9,212,-375.6,0,45.4,220.2,-122.9,43,106.1,0,-18.4,16.8,48.8,-59.8,10.9,72.7,0,-48.9,-14.4,-1,23.4,-7.4,-25.1,-2.3,0,7.1,-12.6,11.4,-9.7,12.7,0.7,-5.2,3.9,0,-24.8,12.2,8.3,-3.3,-5.2,7.2,-0.6,0.8,10,0,3.3,0,2.4,5.3,-9.1,0.4,-4.2,-3.8,0.9,-9.1,0,0,2.9,-0.6,0.2,0.5,-0.3,-1.2,-1.7,-2.9,-1.8,-2.3,0,-1.3,0.7,1,-1.4,0,0.6,-0.1,0.8,0.1,-1,0.1,0.2],
  dg: [0,12,9.7,-11.6,-5.2,-8,-1.3,-4.2,0.4,-15.6,-1.6,-2.4,-6,5.6,-7,0.6,1.4,0,0.6,2.2,0.9,-0.2,-0.4,0.9,1.2,-0.9,0.3,0.9,0,-0.1,-0.1,0.5,-0.1,-0.8,-0.8,0.8,-0.1,0.2,0,0.5,-0.1,0.3,0.2,0,0.2,0,-0.1,0.1,0.3,-0.3,0,0.3,-0.1,0.1,-0.1,0.1,0,0.1,0.1,0,-0.3,0,-0.1,-0.1,0,0,0,0,0,0,0,-0.1,0,0,-0.1,-0.1,-0.1,-0.1,0,0,0,0,0,0,0.1,0,0,0,-0.1,0,-0.1],
  dh: [0,0,-21.5,0,-27.7,-12.1,0,4,-0.3,-4.1,0,-1.1,4.1,1.6,-4.4,0,-0.5,2.2,0.4,1.7,1.9,0,0.3,-1.6,-0.4,0.9,0.7,0.9,0,0.6,0.5,-0.8,0,-1,0.6,-0.2,0,-0.2,0.5,-0.4,0.4,-0.5,-0.6,0.3,0.2,0,-0.3,0.3,-0.3,0.3,0.2,-0.1,-0.2,0.4,0.1,0,0,0,-0.2,0.1,-0.1,0.1,0,-0.1,0.2,0,0,0,0.1,0,0.1,0,0,0.1,0,0,0,0,0,0,0,-0.1,0.1,0,0,0,0,0,0,0,-0.1],
};

const RAD = Math.PI / 180;
const N_MAX = 12;
const EARTH_A = 6378.137; // WGS84 semi-major axis, km
const EARTH_B = 6356.7523142; // WGS84 semi-minor axis, km
const REF_RADIUS = 6371.2; // geomagnetic reference radius, km

export function decimalYear(date) {
  const y = date.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  return y + (date.getTime() - start) / (Date.UTC(y + 1, 0, 1) - start);
}

/**
 * Magnetic declination in degrees, east positive: true heading = magnetic
 * heading + declination. Past the model's five-year span the last valid year
 * is used rather than extrapolating the drift.
 */
export function declination(latDeg, lonDeg, date = new Date(), altitudeKm = 0) {
  const year = Math.min(Math.max(decimalYear(date), WMM.epoch), WMM.validUntil);
  const dt = year - WMM.epoch;

  // Geodetic latitude -> geocentric colatitude and radius.
  const lat = Math.max(-89.999, Math.min(89.999, latDeg)) * RAD;
  const e2 = 1 - (EARTH_B * EARTH_B) / (EARTH_A * EARTH_A);
  const rc = EARTH_A / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  const p = (rc + altitudeKm) * Math.cos(lat);
  const z = (rc * (1 - e2) + altitudeKm) * Math.sin(lat);
  const r = Math.hypot(p, z);
  const latC = Math.asin(z / r);
  const ct = Math.sin(latC); // cos(colatitude)
  const st = Math.cos(latC); // sin(colatitude)

  // Schmidt semi-normalised associated Legendre functions and d/d(colatitude).
  const idx = (n, m) => (n * (n + 1)) / 2 + m;
  const P = new Float64Array(idx(N_MAX, N_MAX) + 1);
  const dP = new Float64Array(P.length);
  P[0] = 1;
  for (let n = 1; n <= N_MAX; n++) {
    const k = n === 1 ? 1 : Math.sqrt(1 - 1 / (2 * n));
    P[idx(n, n)] = k * st * P[idx(n - 1, n - 1)];
    dP[idx(n, n)] = k * (st * dP[idx(n - 1, n - 1)] + ct * P[idx(n - 1, n - 1)]);
    for (let m = 0; m < n; m++) {
      const norm = Math.sqrt(n * n - m * m);
      const k2 = Math.sqrt((n - 1) * (n - 1) - m * m);
      const p1 = P[idx(n - 1, m)];
      const d1 = dP[idx(n - 1, m)];
      const p2 = m <= n - 2 ? P[idx(n - 2, m)] : 0;
      const d2 = m <= n - 2 ? dP[idx(n - 2, m)] : 0;
      P[idx(n, m)] = ((2 * n - 1) * ct * p1 - k2 * p2) / norm;
      dP[idx(n, m)] = ((2 * n - 1) * (ct * d1 - st * p1) - k2 * d2) / norm;
    }
  }

  const lon = lonDeg * RAD;
  let bTheta = 0; // southward
  let bPhi = 0; // eastward
  let bR = 0; // outward
  const ratio = REF_RADIUS / r;
  let rn = ratio * ratio;
  for (let n = 1; n <= N_MAX; n++) {
    rn *= ratio;
    for (let m = 0; m <= n; m++) {
      const i = idx(n, m);
      const g = WMM.g[i] + dt * WMM.dg[i];
      const h = WMM.h[i] + dt * WMM.dh[i];
      const cos = Math.cos(m * lon);
      const sin = Math.sin(m * lon);
      bR += (n + 1) * rn * (g * cos + h * sin) * P[i];
      bTheta -= rn * (g * cos + h * sin) * dP[i];
      bPhi += (rn * m * (g * sin - h * cos) * P[i]) / st;
    }
  }

  // Rotate the geocentric field back to the geodetic (local horizon) frame.
  const psi = latC - lat;
  const north = -bTheta * Math.cos(psi) + bR * Math.sin(psi);
  const east = bPhi;
  return Math.atan2(east, north) / RAD;
}

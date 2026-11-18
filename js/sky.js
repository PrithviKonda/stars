// The sky itself: star catalogue, Sun/Moon/planets, and the rotation that
// places them over an observer. Directions are unit vectors; catalogue
// positions are J2000 equatorial (EQJ), local ones East-North-Up (ENU).
//
// `Astronomy` is the astronomy-engine library, passed in so the same code runs
// against the vendored browser build and the npm package under test.

const RAD = Math.PI / 180;

export function unitVector(raDeg, decDeg) {
  const cd = Math.cos(decDeg * RAD);
  return [cd * Math.cos(raDeg * RAD), cd * Math.sin(raDeg * RAD), Math.sin(decDeg * RAD)];
}

export const mul3 = (a, b) => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
];

export const rotate = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

/** Compass azimuth and altitude (degrees) of an ENU direction. */
export function azAlt(enu) {
  const az = Math.atan2(enu[0], enu[1]) / RAD;
  return { az: (az + 360) % 360, alt: Math.asin(Math.max(-1, Math.min(1, enu[2]))) / RAD };
}

const WINDS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compassPoint = (azDeg) => WINDS[Math.round((((azDeg % 360) + 360) % 360) / 45) % 8];

/**
 * EQJ -> ENU rotation for a place and moment. Includes precession and
 * nutation, so a J2000 catalogue lands where the stars are tonight.
 */
export function skyMatrix(Astronomy, date, latDeg, lonDeg) {
  const time = Astronomy.MakeTime(date);
  const rot = Astronomy.Rotation_EQJ_HOR(time, new Astronomy.Observer(latDeg, lonDeg, 0));
  const m = new Array(9);
  for (let j = 0; j < 3; j++) {
    // astronomy-engine's horizontal frame is x north, y west, z up.
    const h = Astronomy.RotateVector(rot, new Astronomy.Vector(j === 0 ? 1 : 0, j === 1 ? 1 : 0, j === 2 ? 1 : 0, time));
    m[j] = -h.y;
    m[3 + j] = h.x;
    m[6 + j] = h.z;
  }
  return m;
}

const BODIES = [
  ['Sun', 'Star'], ['Moon', 'Moon'], ['Mercury', 'Planet'], ['Venus', 'Planet'], ['Mars', 'Planet'],
  ['Jupiter', 'Planet'], ['Saturn', 'Planet'], ['Uranus', 'Planet'], ['Neptune', 'Planet'],
];

/**
 * Sun, Moon and planets as seen from the observer's spot on the surface (the
 * Moon shifts by up to a degree between the Earth's centre and its surface).
 */
export function computeBodies(Astronomy, date, latDeg, lonDeg) {
  const time = Astronomy.MakeTime(date);
  const observer = new Astronomy.Observer(latDeg, lonDeg, 0);
  return BODIES.map(([name, kind]) => {
    const eq = Astronomy.Equator(name, time, observer, false, true);
    const len = Math.hypot(eq.vec.x, eq.vec.y, eq.vec.z);
    const ill = Astronomy.Illumination(name, time);
    return {
      name,
      kind,
      vec: [eq.vec.x / len, eq.vec.y / len, eq.vec.z / len],
      mag: ill.mag,
      distanceAu: eq.dist,
      litFraction: name === 'Moon' ? ill.phase_fraction : null,
    };
  });
}

/** Unpacks data/sky.json into typed arrays ready for the render loop. */
export function loadCatalog(json) {
  const n = json.stars.length / 5;
  const vec = new Float32Array(n * 3);
  const mag = new Float32Array(n);
  const bv = new Float32Array(n);
  const hip = new Int32Array(n);
  const conOfStar = new Array(n).fill('');
  const proper = new Array(n).fill('');
  const letter = new Array(n).fill('');
  for (let i = 0; i < n; i++) {
    const [ra, dec, m, color, id] = json.stars.slice(i * 5, i * 5 + 5);
    vec.set(unitVector(ra, dec), i * 3);
    mag[i] = m;
    bv[i] = color;
    hip[i] = id;
    const nm = json.names[id];
    if (nm) [proper[i], letter[i], conOfStar[i]] = nm;
  }
  const genitive = {};
  const conName = {};
  const constellations = json.constellations.map((c) => {
    genitive[c.id] = c.gen;
    // Serpens is drawn in two halves; star names just say "Serpens".
    conName[c.id] = c.name.replace(/ (Caput|Cauda)$/, '');
    return {
      id: c.id,
      name: c.name,
      label: unitVector(c.label[0], c.label[1]),
      lines: c.lines.map((line) => {
        const pts = new Float32Array(line.length * 3);
        line.forEach(([ra, dec], k) => pts.set(unitVector(ra, dec), k * 3));
        return pts;
      }),
    };
  });
  return { n, vec, mag, bv, hip, proper, letter, conOfStar, constellations, genitive, conName };
}

/** "Vega", or "α Lyrae" / "HIP 1234" when a star has no common name. */
export function starTitle(cat, i) {
  return cat.proper[i] || starDesignation(cat, i) || `HIP ${cat.hip[i]}`;
}

export function starDesignation(cat, i) {
  if (!cat.letter[i]) return '';
  return `${cat.letter[i]} ${cat.genitive[cat.conOfStar[i]] || cat.conOfStar[i]}`;
}

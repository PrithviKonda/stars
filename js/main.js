// App wiring: sensors and gestures in, a camera pose out, one frame drawn per
// animation tick, plus the Find and Settings sheets.

import { cameraFromDevice, cameraFromAzAlt, pointing, blendCamera, CompassFusion, wrap180, wrap360 } from './orientation.js';
import { declination } from './geomag.js';
import { skyMatrix, computeBodies, loadCatalog, rotate, azAlt, compassPoint, starTitle, starDesignation } from './sky.js';
import { focalLength, fovAcross, limitingMagnitude } from './view.js';
import { drawSky, pick } from './render.js';

const Astronomy = globalThis.Astronomy;
const RAD = Math.PI / 180;
const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// --- saved preferences ------------------------------------------------------
// Kept in this browser only. Storage can be unavailable (private windows), so
// every access is guarded and the app works without it.
const PREFS_KEY = 'stars.prefs.v1';
const prefs = { lines: true, names: true, camera: true, night: false, fovLong: 62, loc: null };
try {
  Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'));
} catch { /* start from defaults */ }
const savePrefs = () => {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* not saved; fine */ }
};

// Until the real location is known, assume mid-northern latitude at the
// longitude the clock implies, so the first sky shown is roughly right.
const guessLocation = () => ({ lat: 40, lon: clamp(-new Date().getTimezoneOffset() / 4, -180, 180) });

const state = {
  catalog: null,
  bodies: [],
  sky: null,
  loc: prefs.loc || guessLocation(),
  locSource: prefs.loc ? 'saved' : 'guess', // 'gps' | 'manual' | 'saved' | 'guess'
  declination: 0,
  mode: 'drag', // 'drag' | 'sensor'
  drag: { az: 180, alt: 35, fov: 75 },
  zoom: 1,
  sensor: { alpha: 0, beta: 0, gamma: 0, live: false, hasCompass: false, sawAbsolute: false, listening: false },
  userYaw: 0,
  cam: null,
  slewUntil: 0,
  video: { on: false, w: 0, h: 0, stream: null },
  selected: null,
  target: null,
  hits: [],
  targetInfo: null,
  started: false,
};
state.drag.az = state.loc.lat >= 0 ? 180 : 0;

const canvas = $('sky');
const ctx = canvas.getContext('2d');
const video = $('camera');
const fusion = new CompassFusion();
let view = { w: 0, h: 0, dpr: 1 };

// --- messages -----------------------------------------------------------------
let toastTimer = 0;
function toast(message, ms = 6000) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// --- sky state ------------------------------------------------------------------
let lastSky = 0;
let lastBodies = 0;
function refreshSky(force = false) {
  const now = Date.now();
  if (force || now - lastSky > 500) {
    state.sky = skyMatrix(Astronomy, new Date(now), state.loc.lat, state.loc.lon);
    lastSky = now;
  }
  if (force || now - lastBodies > 5000) {
    state.bodies = computeBodies(Astronomy, new Date(now), state.loc.lat, state.loc.lon);
    lastBodies = now;
  }
}

function setLocation(lat, lon, source) {
  state.loc = { lat, lon };
  state.locSource = source;
  state.declination = declination(lat, lon, new Date());
  if (source !== 'guess') {
    prefs.loc = state.loc;
    savePrefs();
  }
  refreshSky(true);
  renderLocation();
}

const formatLatLon = ({ lat, lon }) =>
  `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;

function renderLocation() {
  const notes = { gps: 'from your phone', manual: 'set by hand', saved: 'from your last visit', guess: 'a rough guess from your clock' };
  $('loc-text').textContent = `${formatLatLon(state.loc)} · ${notes[state.locSource]}`;
  const d = state.declination;
  $('decl-hint').textContent =
    `Magnetic north here is ${Math.abs(d).toFixed(0)}° ${d >= 0 ? 'east' : 'west'} of true north, which is already allowed for. `
    + 'If the sky is still off, drag it sideways until a star or the Moon sits on the real one.';
}

function requestLocation({ quiet = false } = {}) {
  if (!navigator.geolocation) {
    if (!quiet) locationFailed('This browser cannot share a location.');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => setLocation(pos.coords.latitude, pos.coords.longitude, 'gps'),
    (err) => {
      if (quiet) return;
      locationFailed(err.code === err.PERMISSION_DENIED ? 'Location is blocked for this page.' : 'Your location could not be found.');
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60 * 1000 },
  );
}

function locationFailed(reason) {
  if (state.locSource === 'saved' || state.locSource === 'manual') {
    toast(`${reason} Using ${formatLatLon(state.loc)} from before.`);
    return;
  }
  toast(`${reason} Enter your latitude and longitude so the right stars are shown.`, 9000);
  openSheet('sheet-settings');
  $('loc-lat').focus();
}

// --- sensors --------------------------------------------------------------------
const screenAngle = () => (screen.orientation && typeof screen.orientation.angle === 'number' ? screen.orientation.angle : window.orientation || 0);

function onOrientation(e) {
  if (e.alpha === null || e.beta === null || e.gamma === null) return;
  const s = state.sensor;
  let alpha = e.alpha;
  let hasCompass;
  if (typeof e.webkitCompassHeading === 'number') {
    // iOS: alpha drifts from an arbitrary start; anchor it to the compass.
    const delta = fusion.update(e.alpha, e.beta, e.gamma, e.webkitCompassHeading, e.webkitCompassAccuracy);
    hasCompass = delta !== null;
    alpha += delta || 0;
  } else if (e.type === 'deviceorientationabsolute' || e.absolute === true) {
    s.sawAbsolute = true;
    hasCompass = true;
  } else {
    // Chrome sends both event types; once the absolute one arrives, ignore the relative one.
    if (s.sawAbsolute) return;
    hasCompass = false;
  }
  s.alpha = alpha;
  s.beta = e.beta;
  s.gamma = e.gamma;
  s.hasCompass = hasCompass;
  s.live = true;
}

/**
 * Asks for motion access (must run inside a tap). Resolves 'ok' once readings
 * arrive, 'denied' if access was refused, 'none' if the device sends nothing.
 */
function enableSensors() {
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) return Promise.resolve('none');
  const permission = typeof DOE.requestPermission === 'function'
    ? DOE.requestPermission().catch(() => 'denied')
    : Promise.resolve('granted');
  return permission.then((result) => {
    if (result !== 'granted') return 'denied';
    if (!state.sensor.listening) {
      window.addEventListener('deviceorientationabsolute', onOrientation);
      window.addEventListener('deviceorientation', onOrientation);
      state.sensor.listening = true;
    }
    if (state.sensor.live) return 'ok';
    // Desktop browsers have the API but never send a reading.
    return new Promise((resolve) => {
      const t0 = performance.now();
      const check = () => {
        if (state.sensor.live) resolve('ok');
        else if (performance.now() - t0 > 1500) resolve('none');
        else setTimeout(check, 50);
      };
      check();
    });
  });
}

async function startCamera() {
  if (state.video.on) return true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('The camera is not available here, so the sky is on a dark background.');
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    state.video.stream = stream;
    video.srcObject = stream;
    await video.play();
    state.video.on = true;
    return true;
  } catch (err) {
    toast(err && err.name === 'NotAllowedError'
      ? 'The camera is blocked, so the sky is on a dark background. Allow the camera for this page to see through it.'
      : 'The camera could not start, so the sky is on a dark background.');
    return false;
  }
}

function stopCamera() {
  if (state.video.stream) state.video.stream.getTracks().forEach((t) => t.stop());
  state.video.stream = null;
  state.video.on = false;
  video.srcObject = null;
}

const syncVideoSize = () => { state.video.w = video.videoWidth; state.video.h = video.videoHeight; };
video.addEventListener('loadedmetadata', syncVideoSize);
video.addEventListener('resize', syncVideoSize);

const cameraShown = () => state.mode === 'sensor' && state.video.on && prefs.camera;

/** Switches between following the phone and dragging. Call from a tap. */
async function setMode(mode) {
  if (mode === 'sensor') {
    const sensors = await enableSensors();
    if (sensors !== 'ok') {
      state.mode = 'drag';
      toast(sensors === 'denied'
        ? 'Motion access was not allowed, so drag to look around. To steer by moving your phone, reload and allow it.'
        : 'No motion readings from this device, so drag to look around.', 8000);
      syncControls();
      return;
    }
    state.mode = 'sensor';
    state.zoom = 1;
    if (prefs.camera) await startCamera();
    // Some browsers send a compass-less reading first; judge after they settle.
    setTimeout(() => {
      if (state.mode === 'sensor' && !state.sensor.hasCompass) {
        toast('This device gives no compass heading. Drag the sky sideways to line it up with a star you know.', 9000);
      }
    }, 1500);
  } else {
    // Keep looking where the phone was pointing.
    if (state.cam) {
      const p = pointing(state.cam);
      state.drag.az = p.az;
      state.drag.alt = clamp(p.alt, -89, 89);
    }
    state.mode = 'drag';
    stopCamera();
  }
  syncControls();
}

let wakeLock = null;
async function keepAwake() {
  try {
    if (navigator.wakeLock && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* the screen may dim; nothing else depends on this */ }
}
document.addEventListener('visibilitychange', () => { if (state.started && (!wakeLock || wakeLock.released)) keepAwake(); });

// --- drawing loop ----------------------------------------------------------------
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = window.innerWidth, h = window.innerHeight;
  if (w === view.w && h === view.h && dpr === view.dpr) return;
  view = { w, h, dpr };
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
}

function currentFocal() {
  if (state.mode === 'sensor') {
    return cameraShown()
      ? focalLength(view.w, view.h, prefs.fovLong, state.zoom, state.video.w, state.video.h)
      : focalLength(view.w, view.h, prefs.fovLong, state.zoom);
  }
  return focalLength(view.w, view.h, state.drag.fov);
}

let lastFrame = 0;
let lastUi = 0;
function frame(t) {
  requestAnimationFrame(frame);
  if (!state.catalog) return;
  resize();
  refreshSky();

  const s = state.sensor;
  const target = state.mode === 'sensor'
    ? cameraFromDevice(s.alpha - state.declination + state.userYaw, s.beta, s.gamma, screenAngle())
    : cameraFromAzAlt(state.drag.az, state.drag.alt);
  const dt = Math.min(0.1, (t - lastFrame) / 1000 || 0.016);
  lastFrame = t;
  // Sensor readings jitter, so ease towards them; dragging tracks the finger
  // exactly except while gliding to something picked in Find.
  const tau = state.mode === 'sensor' ? 0.06 : t < state.slewUntil ? 0.16 : 0;
  state.cam = state.cam && tau > 0 ? blendCamera(state.cam, target, 1 - Math.exp(-dt / tau)) : target;

  const f = currentFocal();
  const showCamera = cameraShown();
  if (video.hidden === showCamera) video.hidden = !showCamera;
  video.style.transform = showCamera && state.zoom !== 1 ? `scale(${state.zoom})` : '';

  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  const out = drawSky(ctx, {
    w: view.w, h: view.h, f,
    cam: state.cam, sky: state.sky, catalog: state.catalog, bodies: state.bodies,
    limitMag: limitingMagnitude(fovAcross(Math.max(view.w, view.h), f)),
    overCamera: showCamera,
    showLines: prefs.lines, showNames: prefs.names,
    selected: state.selected, target: state.target,
  });
  state.hits = out.hits;
  state.targetInfo = out.targetInfo;

  if (t - lastUi > 120) {
    lastUi = t;
    updateReadout();
    updateGuide();
  }
}

function updateReadout() {
  const p = pointing(state.cam);
  $('readout-wind').textContent = compassPoint(p.az);
  $('readout-az').textContent = `${Math.round(p.az) % 360}°`;
  const alt = Math.round(p.alt);
  $('readout-alt').textContent = alt === 0 ? 'level' : `${Math.abs(alt)}° ${alt > 0 ? 'up' : 'down'}`;
}

// --- objects: naming, selecting, finding -------------------------------------------
function directionOf(ref) {
  const c = state.catalog;
  if (ref.kind === 'star') return Array.from(c.vec.subarray(ref.index * 3, ref.index * 3 + 3));
  if (ref.kind === 'body') return state.bodies[ref.index].vec;
  return c.constellations[ref.index].label;
}

function nameOf(ref) {
  if (ref.kind === 'star') return starTitle(state.catalog, ref.index);
  if (ref.kind === 'body') return state.bodies[ref.index].name;
  return state.catalog.constellations[ref.index].name;
}

const positionOf = (ref) => azAlt(rotate(state.sky, directionOf(ref)));

const describePosition = ({ az, alt }) => (alt > 0 ? `${Math.round(alt)}° up, ${compassPoint(az)}` : 'Below the horizon');

function select(ref) {
  state.selected = ref;
  renderCard();
}

function renderCard() {
  const ref = state.selected;
  const card = $('card');
  if (!ref) { card.hidden = true; return; }
  const c = state.catalog;
  let sub, factLabel, fact;
  if (ref.kind === 'star') {
    const con = c.conName[c.conOfStar[ref.index]];
    const designation = c.proper[ref.index] ? starDesignation(c, ref.index) : '';
    sub = [designation, con ? `Star in ${con}` : 'Star'].filter(Boolean).join(' · ');
    factLabel = 'Magnitude';
    fact = c.mag[ref.index].toFixed(2);
  } else {
    const b = state.bodies[ref.index];
    if (b.name === 'Moon') {
      sub = `${Math.round(b.litFraction * 100)}% lit · ${Math.round(b.distanceAu * 149597870.7 / 1000) * 1000} km away`;
    } else if (b.name === 'Sun') {
      sub = 'Our star · never look at it through a lens';
    } else {
      sub = `Planet · ${b.distanceAu.toFixed(2)} AU away`;
    }
    factLabel = 'Magnitude';
    fact = b.mag.toFixed(1);
  }
  const p = positionOf(ref);
  $('card-title').textContent = nameOf(ref);
  $('card-sub').textContent = sub;
  $('card-fact-label').textContent = factLabel;
  $('card-fact').textContent = fact;
  $('card-alt').textContent = p.alt >= 0 ? `${p.alt.toFixed(1)}° up` : `${Math.abs(p.alt).toFixed(1)}° below`;
  $('card-az').textContent = `${compassPoint(p.az)} ${Math.round(p.az) % 360}°`;
  card.hidden = false;
}
setInterval(() => { if (state.selected && state.sky) renderCard(); }, 2000);

function setTarget(ref) {
  state.target = ref;
  state.selected = null;
  renderCard();
  if (ref && state.mode === 'drag') {
    // No phone to point: turn the view to it instead.
    const p = positionOf(ref);
    state.drag.az = p.az;
    state.drag.alt = clamp(p.alt, -89, 89);
    state.slewUntil = performance.now() + 1200;
  }
  updateGuide();
}

function updateGuide() {
  const el = $('guide');
  if (!state.target || !state.sky) { el.hidden = true; return; }
  const name = nameOf(state.target);
  const info = state.targetInfo;
  const below = positionOf(state.target).alt < 0;
  let text;
  if (info && info.inView) text = below ? `${name} is in view, below the horizon` : `${name} is in view`;
  else if (info) text = `${name} is ${Math.round(info.away)}° away${below ? ', below the horizon' : ''}`;
  else text = `Finding ${name}`;
  if ($('guide-text').textContent !== text) $('guide-text').textContent = text;
  el.hidden = false;
}

function findItems(query) {
  const c = state.catalog;
  const q = query.trim().toLowerCase();
  const items = [];
  const bodyKinds = { Sun: 'Our star', Moon: 'Earth\'s moon' };
  state.bodies.forEach((b, index) => items.push({ ref: { kind: 'body', index }, name: b.name, kind: bodyKinds[b.name] || 'Planet' }));
  let stars = 0;
  for (let index = 0; index < c.n; index++) {
    if (!c.proper[index]) continue;
    // Without a search, list only the brightest; with one, any named star.
    if (!q && stars >= 24) break;
    stars++;
    items.push({ ref: { kind: 'star', index }, name: c.proper[index], kind: `Star in ${c.conName[c.conOfStar[index]] || 'the sky'}` });
  }
  c.constellations.forEach((con, index) => items.push({ ref: { kind: 'constellation', index }, name: con.name, kind: 'Constellation' }));
  if (!q) return items;
  const matches = items.filter((it) => it.name.toLowerCase().includes(q));
  // Names that start with the query come first.
  matches.sort((a, b) => b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q));
  return matches.slice(0, 60);
}

function renderFind() {
  const list = $('find-list');
  const items = findItems($('find-input').value);
  list.textContent = '';
  for (const item of items) {
    const p = positionOf(item.ref);
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    const left = document.createElement('span');
    left.className = 'name';
    left.textContent = item.name;
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = item.kind;
    left.append(kind);
    const where = document.createElement('span');
    where.className = p.alt > 0 ? 'where' : 'where is-down';
    where.textContent = describePosition(p);
    button.append(left, where);
    button.addEventListener('click', () => {
      closeSheets();
      setTarget(item.ref);
    });
    li.append(button);
    list.append(li);
  }
  $('find-empty').hidden = items.length > 0;
}

// --- sheets ------------------------------------------------------------------------
let sheetOpener = null;
function openSheet(id) {
  closeSheets({ restoreFocus: false });
  sheetOpener = document.activeElement;
  $(id).hidden = false;
  $('scrim').hidden = false;
  if (id === 'sheet-find') {
    $('find-input').value = '';
    renderFind();
  } else {
    syncControls();
  }
  const focusTarget = $(id).querySelector('[data-close]');
  if (focusTarget) focusTarget.focus();
}

function closeSheets({ restoreFocus = true } = {}) {
  const wasOpen = !$('scrim').hidden;
  for (const sheet of document.querySelectorAll('.sheet')) sheet.hidden = true;
  $('scrim').hidden = true;
  if (wasOpen && restoreFocus && sheetOpener && sheetOpener.focus) sheetOpener.focus();
}

function syncControls() {
  $('mode-sensor').checked = state.mode === 'sensor';
  $('mode-drag').checked = state.mode === 'drag';
  $('opt-lines').checked = prefs.lines;
  $('opt-names').checked = prefs.names;
  $('opt-camera').checked = prefs.camera;
  $('opt-fov').value = prefs.fovLong;
  $('fov-out').textContent = `${prefs.fovLong}°`;
  const yaw = Math.round(wrap180(state.userYaw));
  $('yaw-out').textContent = `${yaw > 0 ? '+' : ''}${yaw}°`;
  $('btn-night').setAttribute('aria-pressed', String(prefs.night));
  document.body.classList.toggle('night', prefs.night);
  renderLocation();
}

// --- gestures ----------------------------------------------------------------------
const pointers = new Map();
let gesture = null;

function panBy(dx, dy) {
  const f = currentFocal();
  const alt = pointing(state.cam).alt;
  // Near the zenith a sideways drag has to turn the view further to keep the
  // sky under the finger.
  const turn = (dx / f / RAD) / Math.max(0.25, Math.cos(alt * RAD));
  if (state.mode === 'drag') {
    state.slewUntil = 0;
    state.drag.az = wrap360(state.drag.az - turn);
    state.drag.alt = clamp(state.drag.alt + dy / f / RAD, -89, 89);
  } else {
    // Following the phone: a sideways drag corrects the compass.
    state.userYaw = wrap180(state.userYaw + turn);
    const yaw = Math.round(state.userYaw);
    toast(`Compass corrected by ${yaw > 0 ? '+' : ''}${yaw}°. Reset it in Settings.`, 2500);
  }
}

function zoomBy(scale) {
  if (state.mode === 'sensor') state.zoom = clamp(state.zoom * scale, 1, 5);
  else state.drag.fov = clamp(state.drag.fov / scale, 20, 110);
}

const pinchDistance = () => {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
};

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) gesture = { x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, pinch: 0 };
  else if (pointers.size === 2 && gesture) { gesture.moved = true; gesture.pinch = pinchDistance(); }
});

canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p || !gesture) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX;
  p.y = e.clientY;
  if (pointers.size === 2) {
    const d = pinchDistance();
    if (gesture.pinch > 0 && d > 0) zoomBy(d / gesture.pinch);
    gesture.pinch = d;
  } else if (pointers.size === 1) {
    if (!gesture.moved && Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0) > 8) gesture.moved = true;
    if (gesture.moved) panBy(dx, dy);
  }
});

function endPointer(e) {
  if (!pointers.delete(e.pointerId) || pointers.size > 0 || !gesture) return;
  const tap = e.type === 'pointerup' && !gesture.moved && performance.now() - gesture.t0 < 600;
  gesture = null;
  if (!tap) return;
  const hit = pick(state.hits, e.clientX, e.clientY);
  select(hit ? { kind: hit.kind, index: hit.index } : null);
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomBy(Math.exp(-e.deltaY * 0.0015));
}, { passive: false });

canvas.addEventListener('keydown', (e) => {
  const step = 40;
  const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
  if (moves[e.key]) { panBy(...moves[e.key]); e.preventDefault(); }
  else if (e.key === '+' || e.key === '=') zoomBy(1.2);
  else if (e.key === '-') zoomBy(1 / 1.2);
});

// Safari's own page pinch would fight the sky pinch.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });

// --- controls ----------------------------------------------------------------------
$('btn-find').addEventListener('click', () => openSheet('sheet-find'));
$('btn-settings').addEventListener('click', () => openSheet('sheet-settings'));
$('btn-night').addEventListener('click', () => { prefs.night = !prefs.night; savePrefs(); syncControls(); });
$('scrim').addEventListener('click', () => closeSheets());
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => closeSheets());
$('find-input').addEventListener('input', renderFind);
$('card-close').addEventListener('click', () => select(null));
$('guide-stop').addEventListener('click', () => setTarget(null));

$('mode-sensor').addEventListener('change', () => setMode('sensor'));
$('mode-drag').addEventListener('change', () => setMode('drag'));
$('opt-lines').addEventListener('change', (e) => { prefs.lines = e.target.checked; savePrefs(); });
$('opt-names').addEventListener('change', (e) => { prefs.names = e.target.checked; savePrefs(); });
$('opt-camera').addEventListener('change', (e) => {
  prefs.camera = e.target.checked;
  savePrefs();
  if (prefs.camera && state.mode === 'sensor') startCamera();
  else if (!prefs.camera) stopCamera();
});
$('opt-fov').addEventListener('input', (e) => {
  prefs.fovLong = Number(e.target.value);
  $('fov-out').textContent = `${prefs.fovLong}°`;
  savePrefs();
});
$('yaw-reset').addEventListener('click', () => { state.userYaw = 0; syncControls(); });
$('loc-gps').addEventListener('click', () => requestLocation());
$('loc-set').addEventListener('click', () => {
  const lat = Number.parseFloat($('loc-lat').value);
  const lon = Number.parseFloat($('loc-lon').value);
  const hint = $('loc-hint');
  if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) {
    hint.textContent = 'Latitude runs from -90 to 90 and longitude from -180 to 180. South and west are negative.';
    return;
  }
  hint.textContent = 'North and east are positive. A degree or so of error barely moves the stars.';
  setLocation(lat, lon, 'manual');
});

async function start(wantSensors) {
  // Motion permission has to be requested straight from the tap, before any await.
  const mode = wantSensors ? setMode('sensor') : Promise.resolve();
  $('welcome').hidden = true;
  document.body.classList.remove('pre-start');
  state.started = true;
  canvas.focus({ preventScroll: true });
  await mode;
  requestLocation();
  keepAwake();
}
$('start').addEventListener('click', () => start(true));
$('start-drag').addEventListener('click', () => start(false));

// --- boot --------------------------------------------------------------------------
async function boot() {
  syncControls();
  state.declination = declination(state.loc.lat, state.loc.lon, new Date());
  try {
    const res = await fetch('data/sky.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.catalog = loadCatalog(await res.json());
  } catch (err) {
    $('welcome').hidden = true;
    document.body.classList.remove('pre-start');
    toast('The star catalogue did not load. Check your connection and reload the page.', 60000);
    console.error('Could not load data/sky.json', err);
    return;
  }
  refreshSky(true);
  if (!window.isSecureContext) {
    toast('Camera, compass and location only work over HTTPS. Open this page from an https:// address to use them.', 12000);
  }
}
window.addEventListener('resize', resize);
requestAnimationFrame(frame);
boot();

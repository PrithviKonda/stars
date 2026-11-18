// End-to-end check of the real page in Chromium: npm run test:e2e
//
// Drives the app the way a person would (taps, typing, phone movement via
// synthetic sensor events) with the clock pinned to the 8 April 2024 solar
// eclipse over Dallas, where the right answers are known independently.
// Needs Playwright with Chromium available to Node (it is not a dependency of
// this repo). Screenshots land in test/e2e/shots/.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as Astronomy from 'astronomy-engine';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const geomagnetism = require('geomagnetism');

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, 'shots');
mkdirSync(shots, { recursive: true });

const PORT = 8000 + Math.floor(Math.random() * 1000);
const URL = `http://localhost:${PORT}/`;
const WHEN = new Date(Date.UTC(2024, 3, 8, 18, 42, 30));
const DALLAS = { latitude: 32.78, longitude: -96.8 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };

// Independent expectations, straight from the reference libraries.
const observer = new Astronomy.Observer(DALLAS.latitude, DALLAS.longitude, 0);
const horizonOf = (body) => {
  const eq = Astronomy.Equator(body, WHEN, observer, true, true);
  return Astronomy.Horizon(WHEN, observer, eq.ra, eq.dec);
};
const SUN = horizonOf('Sun');
Astronomy.DefineStar('Star1', 2.5303, 89.2641, 430); // Polaris, J2000
const POLARIS = horizonOf('Star1');
const DECLINATION = geomagnetism.model(WHEN).point([DALLAS.latitude, DALLAS.longitude]).decl;
// Chromium asks for these before it delivers orientation readings.
const SENSORS = ['accelerometer', 'gyroscope', 'magnetometer'];
const WINDS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const wind = (az) => WINDS[Math.round(az / 45) % 8];

const server = spawn(process.execPath, [join(here, '../../tools/serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve) => server.stdout.once('data', resolve));

const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
let failures = 0;

/** Opens the app in a fresh phone-sized context. */
async function open({ permissions = ['geolocation', 'camera'], init } = {}) {
  const context = await browser.newContext({ ...PHONE, geolocation: DALLAS, permissions });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.clock.setFixedTime(WHEN);
  if (init) await page.addInitScript(init);
  await page.goto(URL);
  await page.waitForFunction(() => document.querySelector('#sky').width > 0);
  return { context, page, errors };
}

async function scenario(name, fn, options) {
  const { context, page, errors } = await open(options);
  let step = 'opening the page';
  const at = (s) => { step = s; };
  try {
    await fn(page, at);
    assert.deepEqual(errors, [], 'the page logged errors');
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    const shot = join(shots, `FAILED-${name.replace(/\W+/g, '-')}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    const ui = await page.evaluate(() => ({
      readout: document.querySelector('.readout').innerText.replace(/\s+/g, ' '),
      toast: document.querySelector('#toast').hidden ? null : document.querySelector('#toast').textContent,
      guide: document.querySelector('#guide').hidden ? null : document.querySelector('#guide-text').textContent,
    })).catch(() => null);
    console.log(`FAIL ${name}\n     while: ${step}\n     ${String(err.message).split('\n').join('\n     ')}\n     screen: ${JSON.stringify(ui)}\n     screenshot: ${shot}`);
  } finally {
    await context.close();
  }
}

const text = (page, sel) => page.locator(sel).innerText();
const readout = async (page) => (await text(page, '.readout')).replace(/\s+/g, ' ').trim();

/** Keeps sending phone orientation readings, like a real sensor does. */
async function holdPhone(page, reading) {
  await page.evaluate((r) => {
    clearInterval(window.__sensorTimer);
    window.__sensorTimer = setInterval(() => {
      const e = new DeviceOrientationEvent(r.type, { alpha: r.alpha, beta: r.beta, gamma: r.gamma, absolute: r.type === 'deviceorientationabsolute' });
      if (r.compass !== undefined) {
        Object.defineProperty(e, 'webkitCompassHeading', { value: r.compass });
        Object.defineProperty(e, 'webkitCompassAccuracy', { value: 10 });
      }
      window.dispatchEvent(e);
    }, 16);
  }, reading);
}

// Android-style absolute reading that points the camera at a true azimuth/altitude.
// The phone reports magnetic north, so the declination is added back in.
const absolutePose = (az, alt) => ({ type: 'deviceorientationabsolute', alpha: (360 - az + DECLINATION + 360) % 360, beta: 90 + alt, gamma: 0 });

async function find(page, name) {
  await page.getByRole('button', { name: 'Find' }).click();
  await page.getByPlaceholder('Star, planet or constellation').fill(name);
  return page.locator('#find-list button').filter({ has: page.locator('.name', { hasText: new RegExp(`^${name}`) }) }).first();
}

await scenario('drag mode finds the eclipsed Sun from Dallas', async (page, at) => {
  at('checking the welcome screen');
  await page.screenshot({ path: join(shots, '1-welcome.png') });
  assert.ok(await page.getByRole('heading', { name: 'Stars' }).isVisible(), 'welcome heading should be visible');

  at('starting in drag mode');
  await page.getByRole('button', { name: 'Look around by dragging instead' }).click();
  assert.ok(await page.locator('#welcome').isHidden(), 'welcome should close after starting');

  at('checking that the phone location was picked up');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.waitForFunction(() => document.querySelector('#loc-text').textContent.includes('from your phone'));
  assert.equal(await text(page, '#loc-text'), '32.78° N, 96.80° W · from your phone');
  await page.screenshot({ path: join(shots, '2-settings.png') });
  await page.getByRole('button', { name: 'Close' }).click();

  at('searching for the Sun');
  const row = await find(page, 'Sun');
  const where = await row.locator('.where').innerText();
  assert.equal(where, `${Math.round(SUN.altitude)}° up, ${wind(SUN.azimuth)}`, 'the Find list should show where the Sun is');
  await page.screenshot({ path: join(shots, '3-find.png') });
  await row.click();

  at('waiting for the view to turn to the Sun');
  await page.waitForFunction(() => document.querySelector('#guide-text').textContent === 'Sun is in view');
  await page.waitForFunction((alt) => document.querySelector('#readout-alt').textContent === `${alt}° up`, Math.round(SUN.altitude));
  assert.equal(await readout(page), `${wind(SUN.azimuth)} ${Math.round(SUN.azimuth)}° ${Math.round(SUN.altitude)}° up`);

  at('tapping the centre of the screen, where Sun and Moon overlap');
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.touchscreen.tap(195, 422);
  const title = await text(page, '#card-title');
  assert.ok(['Sun', 'Moon'].includes(title), `tapping the eclipse should select the Sun or Moon, got "${title}"`);
  assert.match(await text(page, '#card-alt'), new RegExp(`^${SUN.altitude.toFixed(0).slice(0, 1)}\\d\\.\\d° up$`));
  await page.screenshot({ path: join(shots, '4-eclipse-card.png') });

  at('dragging the sky');
  const before = await readout(page);
  await page.mouse.move(100, 400);
  await page.mouse.down();
  await page.mouse.move(250, 400, { steps: 5 });
  await page.mouse.up();
  // The readout refreshes a few times a second, so give it a moment.
  await page.waitForFunction((was) => document.querySelector('.readout').innerText.replace(/\s+/g, ' ').trim() !== was, before, { timeout: 2000 })
    .catch(() => assert.fail('dragging should turn the view, but the heading did not change'));
  const after = await readout(page);
  const [azBefore, azAfter] = [before, after].map((r) => Number(r.match(/(\d+)°/)[1]));
  assert.ok(((azBefore - azAfter + 360) % 360) < 180, `dragging right should turn the view left (azimuth ${azBefore} -> ${azAfter})`);
});

await scenario('following the phone: pointing at Polaris shows Polaris', async (page, at) => {
  at('starting with motion sensors');
  await holdPhone(page, absolutePose(POLARIS.azimuth, POLARIS.altitude));
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#camera').hidden, null, { timeout: 5000 });

  at('reading the heading while aimed at Polaris');
  const expected = `N ${Math.round(POLARIS.azimuth) % 360}° ${Math.round(POLARIS.altitude)}° up`;
  await page.waitForFunction((want) => document.querySelector('.readout').innerText.replace(/\s+/g, ' ').trim() === want, expected, { timeout: 5000 });

  at('asking to find Polaris');
  await (await find(page, 'Polaris')).click();
  await page.waitForFunction(() => document.querySelector('#guide-text').textContent === 'Polaris is in view');
  await page.screenshot({ path: join(shots, '5-ar-polaris.png') });

  at('tapping Polaris at the centre');
  await page.touchscreen.tap(195, 422);
  assert.equal(await text(page, '#card-title'), 'Polaris');
  assert.equal(await text(page, '#card-sub'), 'α Ursae Minoris · Star in Ursa Minor');

  at('turning the phone to face east at the horizon');
  await holdPhone(page, absolutePose(90, 0));
  const away = Math.round(Math.acos(Math.cos(POLARIS.altitude * Math.PI / 180) * Math.cos((90 - POLARIS.azimuth) * Math.PI / 180)) * 180 / Math.PI);
  await page.waitForFunction((want) => document.querySelector('#guide-text').textContent === want, `Polaris is ${away}° away`, { timeout: 5000 });
  assert.equal(await readout(page), 'E 90° level');
  await page.screenshot({ path: join(shots, '6-ar-guide-arrow.png') });

  at('correcting the compass by dragging sideways');
  await page.mouse.move(100, 400);
  await page.mouse.down();
  await page.mouse.move(160, 400, { steps: 4 });
  await page.mouse.up();
  // The view eases to the corrected heading; once settled, the heading and the
  // stated correction have to agree.
  await page.waitForFunction(() => {
    const m = document.querySelector('#toast').textContent.match(/^Compass corrected by \+(\d+)°\. Reset it in Settings\.$/);
    return m && Number(m[1]) > 0 && document.querySelector('#readout-az').textContent === `${90 - Number(m[1])}°`;
  }, null, { timeout: 3000 }).catch(() => assert.fail('dragging the sky right should turn the heading left of east by the amount the message states'));
  const az = Number((await readout(page)).match(/(\d+)°/)[1]);
  assert.ok(az < 90 && az > 70, `a 60 px drag should correct by a few degrees, got heading ${az}`);

  at('switching on night mode');
  await page.getByRole('button', { name: 'Night' }).click();
  assert.equal(await page.getByRole('button', { name: 'Night' }).getAttribute('aria-pressed'), 'true');
  await page.screenshot({ path: join(shots, '7-night.png') });
}, { permissions: [...SENSORS, 'geolocation', 'camera'] });

await scenario('iPhone-style sensors: drifting alpha is anchored to the compass', async (page, at) => {
  at('starting with a permission prompt that is granted');
  // The phone really faces 200 degrees magnetic; its alpha started from an arbitrary zero 140 degrees off.
  const facing = 200, drift = 140;
  const pose = (beta) => ({ type: 'deviceorientation', alpha: (360 - facing - drift + 720) % 360, beta, gamma: 0, compass: facing });
  await holdPhone(page, pose(50));
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const trueHeading = Math.round(facing + DECLINATION);
  await page.waitForFunction((want) => document.querySelector('#readout-az').textContent === want, `${trueHeading}°`, { timeout: 5000 });
  assert.equal(await text(page, '#readout-alt'), '40° down', 'held at 50 degrees of tilt the camera looks 40 degrees below the horizon');

  at('raising the phone to look 40 degrees up at the sky');
  await holdPhone(page, { ...pose(130), compass: (facing + 180) % 360 }); // a top-edge compass flips past upright
  await page.waitForFunction(() => document.querySelector('#readout-alt').textContent === '40° up', null, { timeout: 5000 });
  await page.waitForTimeout(400);
  assert.equal(await text(page, '#readout-az'), `${trueHeading}°`, 'the heading must not flip when the compass does');
}, { init: () => { window.DeviceOrientationEvent.requestPermission = () => Promise.resolve('granted'); } });

await scenario('motion permission refused falls back to dragging', async (page, at) => {
  at('starting with a permission prompt that is refused');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#toast').hidden);
  assert.equal(await text(page, '#toast'), 'Motion access was not allowed, so drag to look around. To steer by moving your phone, reload and allow it.');
  assert.ok(await page.locator('#camera').isHidden(), 'the camera should stay off when there is nothing to steer it');
  await page.getByRole('button', { name: 'Settings' }).click();
  assert.ok(await page.locator('#mode-drag').isChecked(), 'Settings should show dragging as the active mode');
}, { init: () => { window.DeviceOrientationEvent.requestPermission = () => Promise.resolve('denied'); } });

await scenario('a device with no motion sensors falls back to dragging', async (page, at) => {
  at('starting where motion access is allowed but nothing ever reports');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#toast').hidden, null, { timeout: 5000 });
  assert.equal(await text(page, '#toast'), 'No motion readings from this device, so drag to look around.');
  assert.ok(await page.locator('#camera').isHidden(), 'the camera should stay off when there is nothing to steer it');
}, { permissions: [...SENSORS, 'geolocation', 'camera'] });

await scenario('a phone without a compass says so and still follows the phone', async (page, at) => {
  at('starting with relative-only orientation readings');
  await holdPhone(page, { type: 'deviceorientation', alpha: 0, beta: 120, gamma: 0 });
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#readout-alt').textContent === '30° up', null, { timeout: 5000 });
  await page.waitForFunction(() => /no compass heading/.test(document.querySelector('#toast').textContent), null, { timeout: 5000 });
}, { permissions: [...SENSORS, 'geolocation', 'camera'] });

await scenario('location refused: asks for coordinates and uses them', async (page, at) => {
  at('starting without location permission');
  await page.getByRole('button', { name: 'Look around by dragging instead' }).click();
  await page.waitForFunction(() => !document.querySelector('#sheet-settings').hidden, null, { timeout: 5000 });
  assert.match(await text(page, '#toast'), /Enter your latitude and longitude/);

  at('entering a bad latitude');
  await page.getByLabel('Latitude').fill('123');
  await page.getByLabel('Longitude').fill('151.2');
  await page.getByRole('button', { name: 'Set', exact: true }).click();
  assert.match(await text(page, '#loc-hint'), /Latitude runs from -90 to 90/);

  at('entering Sydney');
  await page.getByLabel('Latitude').fill('-33.87');
  await page.getByRole('button', { name: 'Set', exact: true }).click();
  assert.equal(await text(page, '#loc-text'), '33.87° S, 151.20° E · set by hand');
  await page.getByRole('button', { name: 'Close' }).click();

  at('checking the sky is now the southern one');
  const row = await find(page, 'Polaris');
  assert.equal(await row.locator('.where').innerText(), 'Below the horizon', 'Polaris never rises over Sydney');
  await page.keyboard.press('Escape');

  at('reloading: the location is remembered');
  await page.reload();
  await page.getByRole('button', { name: 'Look around by dragging instead' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  assert.match(await text(page, '#loc-text'), /^33\.87° S, 151\.20° E/);
}, { permissions: [] });

await browser.close();
server.kill();
console.log(failures ? `\n${failures} scenario(s) failed` : '\nall scenarios passed');
process.exit(failures ? 1 : 0);

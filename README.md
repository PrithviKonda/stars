# Stars

Hold your phone up to the sky and see which stars, planets and constellations are in front of you. The page puts a labelled sky over the camera picture, using the phone's compass and tilt sensors to know where you are pointing and your location to work out what is overhead right now.

It is a plain web page: no app to install, no account, no build step. Your location is used on the device only and is never sent anywhere.

## Using it on your phone

Camera, compass and location only work on pages served over **HTTPS**, so the page has to be hosted somewhere. The quickest way with this repository is GitHub Pages:

1. On GitHub, open **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, pick the branch that holds this code and the `/ (root)` folder, and save.
3. After a minute, open `https://<your-username>.github.io/stars/` on your phone.

Then tap **Start** and allow motion, camera and location when asked.

- **Find** searches stars, planets and constellations and points an arrow toward the one you pick.
- **Tap** a star or planet for its name, brightness and position.
- **Pinch** to zoom.
- **Night** turns everything red to protect your night vision.
- If the sky looks rotated compared to the real one, **drag it sideways** until a bright star or the Moon lines up. Phone compasses are easily thrown off by a few degrees, especially near metal or indoors.
- If stars match in the middle of the screen but drift toward the edges, adjust **Settings → Camera field of view**.

No sensors (a laptop, say)? Choose **Look around by dragging instead** and the same sky becomes a map you can drag and zoom.

## Running it locally

```sh
npm install
npm start          # http://localhost:8080
```

On the same machine `localhost` counts as secure, so location works; a phone on your network will not get camera or sensors over plain `http://`.

## What is in the sky

- 5,044 stars down to magnitude 6 (about what the unaided eye sees from a dark site), with common names and Bayer/Flamsteed designations.
- 88 constellations with their figures (Serpens is drawn as its two halves).
- Sun, Moon and the planets Mercury to Neptune, computed for your spot on the Earth's surface.

## How it works

| File | Job |
| --- | --- |
| `js/orientation.js` | Phone sensor angles to a camera pose. On iPhones, where the browser's rotation angle drifts from an arbitrary start, it is anchored to the compass heading. |
| `js/geomag.js` | World Magnetic Model (WMM2025): the difference between magnetic north, which the compass reports, and true north, which the sky is laid out around. |
| `js/sky.js` | Star catalogue, Sun/Moon/planet positions, and the rotation from catalogue coordinates to your local sky. Uses [Astronomy Engine](https://github.com/cosinekitty/astronomy). |
| `js/view.js` | Matching the overlay's scale to the camera picture. |
| `js/render.js` | Drawing a frame and working out what a tap hit. |
| `js/main.js` | Permissions, gestures, Find and Settings. |
| `tools/build-data.mjs` | Rebuilds `data/sky.json` and the `vendor/` files from the npm packages (`npm run build:data`). |

## Tests

```sh
npm test           # unit and property tests for the maths
npm run test:e2e   # drives the real page in Chromium (needs Playwright available to Node)
```

The unit tests check the star positions against Astronomy Engine's own horizon calculation, the magnetic declination against a reference WMM implementation, and real-world anchors such as Polaris sitting at your latitude and the Moon covering the Sun over Dallas on 8 April 2024. The end-to-end run simulates a phone's sensor readings, including an iPhone-style drifting compass.

**Not yet verified on physical phones.** Sensor behaviour differs between devices in ways a simulator cannot show, in particular what an iPhone's compass heading refers to once the phone is tilted past upright. The code is written to cope with either behaviour, and dragging the sky sideways corrects any remaining offset.

## Limits

- The camera's real field of view is not reported by browsers, so the default (62° along the long side) is a typical value for a phone's main camera.
- Atmospheric refraction is ignored (it lifts objects by up to half a degree right at the horizon).
- The magnetic model is valid through 2029.

## Credits

- Star and constellation data: [d3-celestial](https://github.com/ofrohn/d3-celestial) by Olaf Frohn (BSD 3-Clause).
- Positions of the Sun, Moon and planets: [Astronomy Engine](https://github.com/cosinekitty/astronomy) by Don Cross (MIT).
- World Magnetic Model coefficients: NOAA NCEI and the British Geological Survey (public domain).
- Typefaces: Marcellus and Instrument Sans (SIL Open Font License).

Licence texts for the bundled files are in `vendor/licenses/`.

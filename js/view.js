// Screen geometry: how many pixels a degree of sky takes up.

const RAD = Math.PI / 180;

/**
 * Focal length in CSS pixels. `fovLongDeg` is the field of view along the
 * longer side of the picture. With a camera feed shown `object-fit: cover`,
 * the feed is scaled until it fills the screen, so the overlay has to use the
 * same scale or stars drift off their real counterparts toward the edges.
 */
export function focalLength(viewW, viewH, fovLongDeg, zoom = 1, videoW = 0, videoH = 0) {
  const tan = Math.tan((fovLongDeg * RAD) / 2);
  if (videoW > 0 && videoH > 0) {
    const scale = Math.max(viewW / videoW, viewH / videoH);
    return ((scale * Math.max(videoW, videoH)) / 2 / tan) * zoom;
  }
  return (Math.max(viewW, viewH) / 2 / tan) * zoom;
}

/** Field of view (degrees) across `sizePx` pixels at focal length `f`. */
export const fovAcross = (sizePx, f) => (2 * Math.atan(sizePx / 2 / f)) / RAD;

/** Faintest magnitude worth drawing: more stars as the view narrows. */
export function limitingMagnitude(fovDeg) {
  return Math.max(4, Math.min(6.5, 5 + 1.2 * Math.log2(60 / fovDeg)));
}

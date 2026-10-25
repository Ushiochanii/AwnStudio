// Pixel -> millimetre scale of a page.
//
// A calibration is {method, mmPerPx: [sx, sy], ...}. Grid calibration from the
// service is anisotropic (independent x / y periods of the 5 mm graph paper);
// two-point and direct-ratio calibrations are isotropic.
// Lengths follow the service exactly: Douglas-Peucker at 1 px, then the arc
// length with independent x / y scales.

import {distance, simplify} from './geometry.mjs';

export const GRID_MM = 5;
export const MEASURE_TOLERANCE_PX = 1;

const positive = v => Number.isFinite(v) && v > 0;

export function fromGrid({x_period_px, y_period_px, adequate = true, qc_reasons = []}) {
  if (!positive(x_period_px) || !positive(y_period_px)) throw new Error('invalid grid periods');
  return {
    method: 'grid',
    mmPerPx: [GRID_MM / x_period_px, GRID_MM / y_period_px],
    periodsPx: [x_period_px, y_period_px],
    adequate: Boolean(adequate),
    qcReasons: [...qc_reasons]
  };
}

export function fromTwoPoints(points, knownMm) {
  const px = distance(points[0], points[1]);
  if (!positive(px) || !positive(knownMm)) throw new Error('invalid two-point calibration');
  const r = knownMm / px;
  return {method: 'two_point', mmPerPx: [r, r], points: points.map(p => [...p]), knownMm, adequate: true, qcReasons: []};
}

export function fromRatio(mmPerPx) {
  if (!positive(mmPerPx)) throw new Error('invalid mm/px');
  return {method: 'ratio', mmPerPx: [mmPerPx, mmPerPx], adequate: true, qcReasons: []};
}

export function isValid(calibration) {
  const s = calibration?.mmPerPx;
  return Array.isArray(s) && s.length === 2 && positive(s[0]) && positive(s[1]);
}

// Mean scale, for display and for converting a length typed in mm.
export const meanMmPerPx = c => (isValid(c) ? (c.mmPerPx[0] + c.mmPerPx[1]) / 2 : null);

// Periods the service expects when it should measure with this calibration.
export function servicePeriods(c) {
  if (!isValid(c)) return null;
  return {x_period_px: GRID_MM / c.mmPerPx[0], y_period_px: GRID_MM / c.mmPerPx[1]};
}

export function lengthMm(path, calibration) {
  if (!Array.isArray(path) || path.length < 2 || !isValid(calibration)) return null;
  const [sx, sy] = calibration.mmPerPx;
  const points = simplify(path, MEASURE_TOLERANCE_PX);
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot((points[i][0] - points[i - 1][0]) * sx, (points[i][1] - points[i - 1][1]) * sy);
  }
  return total;
}

export function describe(c) {
  if (!isValid(c)) return null;
  const [sx, sy] = c.mmPerPx;
  return Math.abs(sx - sy) / Math.max(sx, sy) < 1e-4 ? `${sx.toFixed(5)} mm/px` : `${sx.toFixed(5)} × ${sy.toFixed(5)} mm/px`;
}

// Planar geometry in image pixel coordinates. Points are [x, y] arrays.

export const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}

export const clonePoints = points => (points ?? []).map(p => [Number(p[0]), Number(p[1])]);

// Douglas-Peucker simplification; the endpoints are always kept.
export function simplify(points, tolerance = 1) {
  if (points.length < 3 || tolerance <= 0) return clonePoints(points);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const limit = tolerance * tolerance;
  while (stack.length) {
    const [start, end] = stack.pop();
    let farthest = 0, index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = segmentDistanceSq(points[i], points[start], points[end]);
      if (d > farthest) { farthest = d; index = i; }
    }
    if (index >= 0 && farthest > limit) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  return clonePoints(points.filter((_, i) => keep[i]));
}

function projectOnSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], den = dx * dx + dy * dy;
  const t = den ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / den)) : 0;
  return {t, point: [a[0] + t * dx, a[1] + t * dy]};
}

function segmentDistanceSq(p, a, b) {
  const {point} = projectOnSegment(p, a, b);
  return (p[0] - point[0]) ** 2 + (p[1] - point[1]) ** 2;
}

// Closest point on a polyline (or closed ring) to p.
export function nearestOnPath(points, p, closed = false) {
  let best = {index: -1, distance: Infinity, point: p};
  const n = points.length;
  for (let i = 0; i < n - (closed ? 0 : 1); i++) {
    const {point} = projectOnSegment(p, points[i], points[(i + 1) % n]);
    const d = distance(point, p);
    if (d < best.distance) best = {index: i, distance: d, point};
  }
  return best;
}

export function nearestVertex(points, p) {
  let best = {index: -1, distance: Infinity};
  points.forEach((q, index) => {
    const d = distance(p, q);
    if (d < best.distance) best = {index, distance: d};
  });
  return best;
}

export function pointInPolygon(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(area) / 2;
}

export function bounds(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return {x0, y0, x1, y1};
}

export function unionBounds(list) {
  return bounds(list.flatMap(b => [[b.x0, b.y0], [b.x1, b.y1]]));
}

// Parse the exterior rings of a WKT POLYGON / MULTIPOLYGON. Holes are dropped:
// a spikelet outline is drawn and edited as its outer boundary only.
export function parseWktRings(wkt) {
  const text = String(wkt ?? '').trim();
  const type = text.slice(0, text.indexOf('(')).trim().toUpperCase();
  if (type !== 'POLYGON' && type !== 'MULTIPOLYGON') return [];
  const rings = [];
  let depth = 0, start = -1, ringIndex = 0;
  const outer = type === 'POLYGON' ? 2 : 3;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') {
      depth++;
      if (depth === outer) start = i + 1;
      if (depth === outer - 1) ringIndex = 0;
    } else if (c === ')') {
      if (depth === outer) {
        if (ringIndex === 0) {
          const ring = text.slice(start, i).split(',').map(pair => pair.trim().split(/\s+/).slice(0, 2).map(Number));
          if (ring.length > 1 && distance(ring[0], ring.at(-1)) === 0) ring.pop();
          if (ring.length >= 3 && ring.every(p => p.every(Number.isFinite))) rings.push(ring);
        }
        ringIndex++;
      }
      depth--;
    }
  }
  return rings;
}

// Spikelets are numbered in reading order: rows top to bottom, each row left to right.
export function readingOrder(items, polygonOf = item => item.polygon) {
  const boxes = items.map(item => {
    const b = bounds(polygonOf(item));
    return {item, x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, h: b.y1 - b.y0};
  });
  const heights = boxes.map(b => b.h).sort((a, b) => a - b);
  const gap = (heights[Math.floor(heights.length / 2)] || 1) * 1.5;
  const rows = [];
  for (const box of boxes.sort((a, b) => a.y - b.y)) {
    let row = rows.at(-1);
    if (!row || box.y - row.y > gap) rows.push(row = {y: box.y, items: []});
    row.items.push(box);
    row.y = row.items.reduce((s, v) => s + v.y, 0) / row.items.length;
  }
  return rows.flatMap(row => row.items.sort((a, b) => a.x - b.x).map(b => b.item));
}

// Manual corrections of one spikelet record. Every geometry change marks the
// record as edited and clears its confirmation; the automatic evidence
// (`candidates`, `autoRep`) is never modified.

import {clonePoints, distance, simplify} from './geometry.mjs';

// Automatic geometry is pixel-dense; it is reduced to editable vertices the
// first time the person touches it. 1 px matches the measurement tolerance,
// so the reported length is unchanged by the reduction.
const EDIT_TOLERANCE = {line: 1, polygon: 1.5};
const MAX_RAW_VERTICES = 60;
const MIN_VERTICES = {line: 2, polygon: 3};

function reduce(points, kind) {
  if (kind === 'line') return simplify(points, EDIT_TOLERANCE.line);
  const ring = simplify([...points, points[0]], EDIT_TOLERANCE.polygon);
  ring.pop();
  return ring.length >= 3 ? ring : clonePoints(points);
}

export function editPoints(s, kind) {
  const points = s[kind];
  if (!points?.length || s.reduced?.[kind] || points.length <= MAX_RAW_VERTICES) return points ?? [];
  s.reducedCache ??= {};
  const cached = s.reducedCache[kind];
  if (cached && cached.source === points) return cached.points;
  const reduced = reduce(points, kind);
  s.reducedCache[kind] = {source: points, points: reduced};
  return reduced;
}

// Swap the dense geometry for its editable vertices before an edit.
export function prepare(s, kind) {
  if (kind === 'polygon' && !s.autoPolygon && s.origin === 'auto') s.autoPolygon = clonePoints(s.polygon);
  s[kind] = clonePoints(editPoints(s, kind));
  s.reduced = {...s.reduced, [kind]: true};
}

function touched(s) {
  s.modified = true;
  s.confirmed = false;
}

export function moveVertex(s, kind, index, point) {
  if (!s[kind]?.[index]) return false;
  s[kind][index] = [point[0], point[1]];
  touched(s);
  return true;
}

export function insertVertex(s, kind, index, point) {
  prepare(s, kind);
  s[kind].splice(index, 0, [point[0], point[1]]);
  touched(s);
}

export function removeVertex(s, kind, index) {
  prepare(s, kind);
  if (s[kind].length <= MIN_VERTICES[kind]) return false;
  s[kind].splice(index, 1);
  touched(s);
  return true;
}

// Drop consecutive duplicates that double-clicks leave behind.
export function cleanDraft(points, minGap = 0.5) {
  const out = [];
  for (const p of points) if (!out.length || distance(out.at(-1), p) > minGap) out.push([p[0], p[1]]);
  return out;
}

export function setLine(s, points) {
  s.line = cleanDraft(points);
  s.reduced = {...s.reduced, line: true};
  s.rep = null;
  touched(s);
}

export function useCandidate(s, k) {
  const candidate = s.candidates[k];
  if (!candidate) return false;
  s.rep = k;
  s.line = clonePoints(candidate.path);
  s.reduced = {...s.reduced, line: false};
  s.confirmed = false;
  s.modified = k !== s.autoRep || Boolean(s.reduced?.polygon);
  return true;
}

export function restoreAutomatic(s) {
  if (s.origin !== 'auto') return false;
  if (s.autoPolygon) s.polygon = s.autoPolygon;
  delete s.autoPolygon;
  s.reduced = {};
  s.rep = s.autoRep;
  s.line = s.autoRep === null ? [] : clonePoints(s.candidates[s.autoRep].path);
  s.modified = false;
  s.confirmed = false;
  return true;
}

// The serializable part of a record (caches are dropped).
export function persistable(s) {
  const {reducedCache, ...rest} = s;
  return rest;
}

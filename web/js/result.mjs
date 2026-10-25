// The service result contract (awnstudio.results.PageResult.to_json) and the
// editable spikelet records the workbench derives from it.
//
// Editable spikelet:
//   {uid, name, polygon, confidence, candidates: [{path, score, serviceMm, meta}],
//    rep, autoRep, line, origin: 'auto' | 'manual', modified, confirmed}
// `candidates` and `rep` are the immutable automatic evidence; `line` is the
// measurement path the person may redraw. Review never alters the evidence.

import {clonePoints, parseWktRings, polygonArea, readingOrder} from './geometry.mjs';
import {fromGrid} from './calibration.mjs';

export function validateServiceResult(data) {
  if (!data || typeof data !== 'object') throw new Error('result is not an object');
  if (!Array.isArray(data.spikelets)) throw new Error('result has no spikelets');
  for (const s of data.spikelets) {
    if (typeof s.id !== 'string' || typeof s.geometry_wkt !== 'string' || !Array.isArray(s.awns)) {
      throw new Error('malformed spikelet record');
    }
  }
  return data;
}

function largestRing(wkt) {
  const rings = parseWktRings(wkt);
  return rings.length ? rings.reduce((a, b) => (polygonArea(b) > polygonArea(a) ? b : a)) : null;
}

export function spikeletsFromResult(data) {
  validateServiceResult(data);
  const records = data.spikelets.map(s => {
    const polygon = largestRing(s.geometry_wkt);
    if (!polygon) return null;
    const candidates = s.awns
      .filter(a => Array.isArray(a.path_px) && a.path_px.length >= 2)
      .map(a => ({
        path: clonePoints(a.path_px),
        score: Number.isFinite(a.score) ? a.score : null,
        serviceMm: Number.isFinite(a.length_mm) ? a.length_mm : null,
        meta: {...(a.meta ?? {})}
      }));
    const rep = Number.isInteger(s.representative) && candidates[s.representative] ? s.representative : null;
    return {
      uid: s.id,
      name: '',
      polygon,
      confidence: Number.isFinite(s.meta?.confidence) ? s.meta.confidence : null,
      candidates,
      rep,
      autoRep: rep,
      line: rep === null ? [] : clonePoints(candidates[rep].path),
      origin: 'auto',
      modified: false,
      confirmed: false
    };
  }).filter(Boolean);
  readingOrder(records).forEach((record, i) => { record.name = String(i + 1); });
  return records;
}

export function calibrationFromResult(data) {
  return fromGrid({
    x_period_px: data.x_period_px,
    y_period_px: data.y_period_px,
    adequate: data.calibration?.adequate ?? true,
    qc_reasons: data.calibration?.qc_reasons ?? []
  });
}

export function runInfo(data) {
  return {
    pageId: data.page_id ?? null,
    method: data.method ?? null,
    model: data.model ?? null,
    elapsedS: Number.isFinite(data.elapsed_s) ? data.elapsed_s : null,
    meta: {...(data.meta ?? {})}
  };
}

export function newManualSpikelet(spikelets, polygon) {
  let n = 1;
  const names = new Set(spikelets.map(s => s.name));
  while (names.has(String(n))) n++;
  let uid;
  do uid = 'M' + Math.random().toString(36).slice(2, 8); while (spikelets.some(s => s.uid === uid));
  return {
    uid, name: String(n), polygon: clonePoints(polygon), confidence: null,
    candidates: [], rep: null, autoRep: null, line: [], origin: 'manual', modified: true, confirmed: false
  };
}

export function validName(name, spikelets, uid) {
  const text = String(name ?? '').trim();
  return text.length > 0 && text.length <= 80 && !spikelets.some(s => s.uid !== uid && s.name === text);
}

// Representative candidate shown for a spikelet (null when the person drew the path).
export const representative = s => (s.rep === null ? null : s.candidates[s.rep] ?? null);

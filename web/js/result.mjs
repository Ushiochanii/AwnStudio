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
  const growth = data.stages?.growth ?? {};
  const alternatives = data.stages?.alternatives ?? {};
  const records = data.spikelets.map(s => {
    const polygon = largestRing(s.geometry_wkt);
    if (!polygon) return null;
    // Awns keep their service order: growth[k] belongs to awns[k].
    const chosen = s.awns.map((a, k) => ({
      path: clonePoints(a.path_px),
      score: Number.isFinite(a.score) ? a.score : null,
      serviceMm: Number.isFinite(a.length_mm) ? a.length_mm : null,
      meta: {...(a.meta ?? {})},
      growth: growth[s.id]?.[k] ?? null,
      serviceIndex: k
    }));
    const candidates = chosen.filter(c => c.path.length >= 2);
    for (const alt of alternatives[s.id] ?? []) {
      if (!Array.isArray(alt.path) || alt.path.length < 2) continue;
      candidates.push({
        path: clonePoints(alt.path),
        score: Number.isFinite(alt.score) ? alt.score : null,
        serviceMm: Number.isFinite(alt.length_mm) ? alt.length_mm : null,
        meta: {hops: alt.hops ?? null},
        growth: null,
        alternative: true
      });
    }
    const repIndex = candidates.findIndex(c => c.serviceIndex === s.representative && !c.alternative);
    const rep = Number.isInteger(s.representative) && repIndex >= 0 ? repIndex : null;
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
    modelId: data.model_id ?? null,
    linkModels: data.link_models ?? null,
    protocol: data.protocol && Number.isFinite(data.protocol.intercept) && Number.isFinite(data.protocol.slope) ? {...data.protocol} : null,
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

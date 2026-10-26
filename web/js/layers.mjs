// Display layers derived from the service's reconstruction stages.
//
//   evidence    primary detection masks (spikelets and awns, with confidence)
//   growth      each chosen awn traced hop by hop from its root branch (seed)
//   candidates  every awn candidate of a spikelet; the representative in gold
//   edits       the editable measurement result (the default working view)
//
// Stages are display data only. They never change a measurement.

export const LAYERS = Object.freeze(['evidence', 'growth', 'candidates', 'edits']);

// Hop colours: seed, then one colour per growth hop (cycled after the last).
export const GROWTH_COLORS = Object.freeze(['#11a3c4', '#3f7bd9', '#7657c8', '#d1772f', '#c64e52', '#9b4aa6']);
export const growthColor = hop => (hop <= 0 ? GROWTH_COLORS[0] : GROWTH_COLORS[1 + ((hop - 1) % (GROWTH_COLORS.length - 1))]);

export const EVIDENCE_COLORS = Object.freeze({spikelet: '#2f8a6a', awn: '#3c6fd0'});

// Opacity of an awn mask grows with its confidence (0.25 .. 1 -> 0.08 .. 0.42).
export function evidenceOpacity(confidence) {
  if (!Number.isFinite(confidence)) return 0.26;
  const t = Math.max(0, Math.min(1, (confidence - 0.25) / 0.75));
  return 0.08 + 0.34 * Math.sqrt(t);
}

// The stages kept with a page (everything except the per-spikelet parts, which
// live on the spikelet records).
export function pageLayersFromResult(result) {
  const stages = result?.stages;
  if (!stages) return null;
  return {
    evidence: (stages.evidence ?? []).filter(item => Array.isArray(item.rings) && item.rings.length),
    timings: {...(stages.timings ?? {})}
  };
}

export function layerCounts(page) {
  const awns = page.spikelets.flatMap(s => s.candidates);
  return {
    evidence: page.layers?.evidence?.length ?? 0,
    growth: awns.filter(c => c.growth?.hops?.length).length,
    candidates: awns.length,
    edits: page.spikelets.length
  };
}

export const maxHop = spikelets =>
  Math.max(0, ...spikelets.flatMap(s => s.candidates.map(c => (c.growth?.hops?.length ?? 1) - 1)));

// Tile windows of the service's tiled detection (same rule as
// awnstudio.detection.tile_windows), used to draw the live scan.
export function tileWindows(width, height, size = 640, stride = 320) {
  const starts = length => {
    const out = new Set();
    for (let v = 0; v < Math.max(1, length - size + 1); v += stride) out.add(v);
    out.add(Math.max(0, length - size));
    return [...out].sort((a, b) => a - b);
  };
  const tiles = [];
  for (const y of starts(height)) for (const x of starts(width)) tiles.push([x, y, Math.min(x + size, width), Math.min(y + size, height)]);
  return tiles;
}

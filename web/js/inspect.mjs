// Step-by-step account of how one awn candidate was reconstructed:
// seed (root branch) -> growth hops -> measurement path. Read-only.

export function inspectionSteps(candidate) {
  if (!candidate) return [];
  const hops = candidate.growth?.hops ?? [];
  const steps = [];
  if (hops.length) {
    steps.push({kind: 'seed', path: hops[0].path, lengthMm: hops[0].length_mm, pRoot: candidate.growth.p_root ?? candidate.meta?.p_root ?? null});
    hops.slice(1).forEach((hop, i) => steps.push({kind: 'hop', hop: i + 1, path: hop.path, lengthMm: hop.length_mm, gap: Boolean(hop.gap)}));
  }
  steps.push({kind: 'final', path: candidate.path, score: candidate.score, serviceMm: candidate.serviceMm, alternative: Boolean(candidate.alternative)});
  return steps;
}

// Paths visible at a given step: everything up to and including it.
export function visibleSteps(steps, step) {
  return steps.slice(0, Math.max(0, Math.min(steps.length, step + 1)));
}

// Cumulative grown length (mm) after each step, for the step labels.
export function grownLength(steps, step) {
  return visibleSteps(steps, step).filter(s => s.kind !== 'final').reduce((sum, s) => sum + (s.lengthMm ?? 0), 0);
}

// Review state of a spikelet. Triage only reads existing evidence; it never
// changes geometry or the measurement.

import {representative} from './result.mjs';

export const STATUS = Object.freeze({
  automatic: 'automatic',
  needsReview: 'needs_review',
  modified: 'modified',
  confirmed: 'confirmed',
  missing: 'missing'
});

export const DEFAULT_SCORE_THRESHOLD = 0.5;
const WEAK_SPIKELET = 0.5;
const LONG_CHAIN_HOPS = 3;

export function reviewReasons(spikelet, {threshold = DEFAULT_SCORE_THRESHOLD, calibration = null} = {}) {
  const reasons = [];
  if (calibration && calibration.adequate === false) reasons.push('calibration_qc');
  if (spikelet.confidence !== null && spikelet.confidence < WEAK_SPIKELET) reasons.push('weak_spikelet');
  const rep = representative(spikelet);
  if (rep && !spikelet.modified) {
    if (rep.score !== null && rep.score < threshold) reasons.push('low_score');
    if (rep.meta?.gaps > 0) reasons.push('gap_bridged');
    if (rep.meta?.hops >= LONG_CHAIN_HOPS) reasons.push('long_chain');
  }
  return reasons;
}

export function reviewStatus(spikelet, options) {
  if (!Array.isArray(spikelet.line) || spikelet.line.length < 2) return STATUS.missing;
  if (spikelet.modified || spikelet.origin === 'manual') return spikelet.confirmed ? STATUS.confirmed : STATUS.modified;
  if (spikelet.confirmed) return STATUS.confirmed;
  return reviewReasons(spikelet, options).length ? STATUS.needsReview : STATUS.automatic;
}

// Filters offered in the results table.
export const FILTERS = Object.freeze({
  all: () => true,
  pending: status => status !== STATUS.confirmed,
  needs_review: status => status === STATUS.needsReview || status === STATUS.missing,
  modified: status => status === STATUS.modified,
  confirmed: status => status === STATUS.confirmed,
  missing: status => status === STATUS.missing
});

// How urgently a spikelet that needs review should be looked at: reasons are
// weighted, several reasons add up. Used to order the "Needs review" list.
const REASON_WEIGHT = {gap_bridged: 3, low_score: 2.5, long_chain: 1.5, weak_spikelet: 2, calibration_qc: 1};

export function reviewSeverity(spikelet, options) {
  const reasons = reviewReasons(spikelet, options);
  if (!reasons.length) return {score: 0, level: 0};
  let score = reasons.reduce((sum, r) => sum + (REASON_WEIGHT[r] ?? 1), 0) + (reasons.length - 1) * 0.75;
  const rep = representative(spikelet);
  if (rep?.score !== null && rep?.score !== undefined && rep.score < 0.2) score += 1;
  if (rep?.meta?.gaps >= 2) score += 1;
  return {score, level: score >= 5 ? 3 : score >= 3 ? 2 : 1};
}

export const canConfirm = spikelet => Array.isArray(spikelet.line) && spikelet.line.length >= 2;

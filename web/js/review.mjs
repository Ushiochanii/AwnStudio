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

export const canConfirm = spikelet => Array.isArray(spikelet.line) && spikelet.line.length >= 2;

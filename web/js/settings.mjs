// Persisted preferences (localStorage). Unknown or malformed values fall back to defaults.

import {DEFAULT_SCORE_THRESHOLD} from './review.mjs';

const KEY = 'awnstudio.settings';

export const DEFAULTS = Object.freeze({
  language: 'en',
  theme: 'system',
  threshold: DEFAULT_SCORE_THRESHOLD,
  autoCalibrate: true,
  measureAfterImport: false,
  confirmReplace: true,
  autoAdvance: true,
  restore: true,
  serviceBase: '',
  layers: {photo: true, dim: false, outlines: true, candidates: false, paths: true, labels: true},
  layout: {sidebar: 250, panel: 340}
});

export function normalizeSettings(raw, defaults = DEFAULTS) {
  const out = structuredClone(defaults);
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(defaults)) {
    const given = raw[key];
    if (given === undefined) continue;
    if (value && typeof value === 'object') out[key] = normalizeSettings(given, value);
    else if (typeof given === typeof value) out[key] = given;
  }
  if (!['en', 'zh', 'ja'].includes(out.language)) out.language = defaults.language;
  if (!['system', 'light', 'dark'].includes(out.theme)) out.theme = defaults.theme;
  if (!(out.threshold >= 0 && out.threshold <= 1)) out.threshold = defaults.threshold;
  return out;
}

export function loadSettings(storage = globalThis.localStorage, fallbackLanguage = 'en') {
  let raw = null;
  try { raw = JSON.parse(storage?.getItem(KEY) ?? 'null'); } catch { raw = null; }
  return normalizeSettings(raw ?? {language: fallbackLanguage});
}

export function saveSettings(settings, storage = globalThis.localStorage) {
  try { storage?.setItem(KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}

// Persisted preferences (localStorage). Unknown or malformed values fall back to defaults.

import {LAYERS} from './layers.mjs';
import {DEFAULT_SCORE_THRESHOLD} from './review.mjs';

const KEY = 'awnstudio.settings';

export const DEFAULTS = Object.freeze({
  // input
  autoResolution: true,
  autoCalibrate: true,
  openCalibrationAfterImport: false,
  // measurement
  modelId: '', // '' = the service default (YOLO 11N)
  measureAfterImport: false,
  runAfterCalibration: false,
  continueBatchAfterError: true,
  livePreview: true,
  completionAnimation: true,
  confirmReplace: true,
  applyProtocol: true,
  // display
  defaultLayer: 'edits',
  defaultMode: 'measure',
  threshold: DEFAULT_SCORE_THRESHOLD,
  showPool: false,
  spikeletContext: true,
  autoFocus: true,
  // editing
  autoAdvance: true,
  confirmDestructive: false,
  rememberLayout: true,
  // storage
  restore: true,
  confirmProjectReplace: true,
  // general
  language: 'en',
  theme: 'system',
  showDiagnostics: true,
  serviceBase: '',
  layers: {photo: true, dim: false, outlines: true, paths: true, labels: true},
  layout: {sidebar: 248, panel: 340}
});

const CHOICES = {
  language: ['en', 'zh', 'ja'],
  theme: ['system', 'light', 'dark'],
  defaultLayer: LAYERS,
  defaultMode: ['measure', 'inspect']
};

export function normalizeSettings(raw, defaults = DEFAULTS) {
  const out = structuredClone(defaults);
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(defaults)) {
    const given = raw[key];
    if (given === undefined) continue;
    if (value && typeof value === 'object') out[key] = normalizeSettings(given, value);
    else if (typeof given === typeof value) out[key] = given;
  }
  for (const [key, allowed] of Object.entries(CHOICES)) {
    if (key in out && !allowed.includes(out[key])) out[key] = defaults[key];
  }
  if ('threshold' in out && !(out.threshold >= 0 && out.threshold <= 1)) out.threshold = defaults.threshold;
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

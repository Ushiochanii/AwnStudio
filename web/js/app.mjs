// AwnStudio workbench: wires state, viewer, service and panels together.

import {createApi} from './api.mjs';
import * as cal from './calibration.mjs';
import * as edits from './edits.mjs';
import {csvName, detailedCsv, exportablePages, simpleCsv, summaryCsv, zip} from './export.mjs';
import {bounds, distance, polygonArea, unionBounds} from './geometry.mjs';
import {createHistory} from './history.mjs';
import {applyTranslations, setLocale, t} from './i18n.mjs';
import {applyIcons} from './icons.mjs';
import {grownLength, inspectionSteps, visibleSteps} from './inspect.mjs';
import {layerCounts, maxHop, pageLayersFromResult, tileWindows} from './layers.mjs';
import {blobToDataUrl, buildProject, dataUrlToBlob, parseProject, serializePage} from './project.mjs';
import {calibrationFromResult, newManualSpikelet, representative, runInfo, spikeletsFromResult, validName} from './result.mjs';
import {canConfirm, FILTERS, reviewReasons, reviewSeverity, reviewStatus, STATUS} from './review.mjs';
import {DEFAULTS, loadSettings, saveSettings} from './settings.mjs';
import {SHORTCUTS} from './shortcuts.mjs';
import {histogram, summarize} from './stats.mjs';
import * as store from './store.mjs';
import {createViewer} from './viewer.mjs';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

// English is the product language; other locales are opt-in translations.
const settings = loadSettings(localStorage, 'en');
const state = {
  pages: [],
  currentId: null,
  selected: new Set(),
  primaryUid: null,
  selectedNodes: [], // vertices picked with the box tool: {uid, kind, index}
  tool: 'select',
  draft: null, // {kind: 'awn' | 'spikelet' | 'ruler', points, targetUid}
  rulerLine: null, // last drawn two-point calibration line
  threshold: settings.threshold,
  filter: 'all',
  search: '',
  sort: {key: 'name', dir: 'asc'},
  lengthRange: null, // [min, max) from a histogram bin
  rowHover: null,
  displayLayer: settings.defaultLayer,
  mode: settings.defaultMode,
  inspectCandidate: null,
  inspectStep: 0,
  candidateCursor: new Map(),
  sourcePinned: false,
  ctrlHeld: false,
  photoHidden: false,
  reveal: null, // completion animation: {stage, hop, t}
  live: null, // live detection preview: {pageId, evidence, tiles, stage, tileRects}
  checkedPages: new Set(),
  service: {state: 'unknown', info: null},
  models: [],
  measuring: false,
  batch: null, // {total, done, failed, skipped, stop, started, current}
  calContinuation: null, // 'run' when calibration was opened to start a measurement
  restored: false
};
const histories = new Map();
const api = () => createApi({base: settings.serviceBase.replace(/\/$/, '')});
const autosave = store.createAutosave(record => store.putPage(record));
const REVIEW_SEEN_KEY = 'awnstudio.reviewSeen';
const seenReview = new Set((() => { try { return JSON.parse(localStorage.getItem(REVIEW_SEEN_KEY) ?? '[]'); } catch { return []; } })());
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------- helpers

const current = () => state.pages.find(p => p.id === state.currentId) ?? null;
const spikeletByUid = (page, uid) => page?.spikelets.find(s => s.uid === uid) ?? null;
const primary = () => spikeletByUid(current(), state.primaryUid);
const reviewOptions = page => ({threshold: state.threshold, calibration: page?.calibration ?? null});
const statusOf = (s, page = current()) => reviewStatus(s, reviewOptions(page));
const lengthOf = (s, page = current()) => cal.lengthMm(s.line, page?.calibration);
const fmt = (value, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits));
const historyOf = page => {
  if (!histories.has(page.id)) histories.set(page.id, createHistory({limit: 70}));
  return histories.get(page.id);
};
const snapshot = page => structuredClone({spikelets: page.spikelets.map(edits.persistable), calibration: page.calibration});
const MIN_SPIKELET_AREA_PX = 25;
const byName = new Intl.Collator(undefined, {numeric: true});
const uid = () => (crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sourcePreview = () => state.sourcePinned || state.ctrlHeld;
const editable = () => state.mode === 'measure' && state.displayLayer === 'edits' && !sourcePreview();
const seenKey = (page, s) => `${page.id}::${s.uid}`;

function toast(message, kind = 'info', action = null) {
  const el = $('#toast');
  $('#toast-text').textContent = message;
  const button = $('#toast-action');
  button.hidden = !action;
  button.onclick = null;
  if (action) {
    button.textContent = action.label;
    button.onclick = () => {
      el.classList.remove('show');
      action.run();
    };
  }
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), action ? 7000 : kind === 'error' ? 6000 : 3200);
}

const undoAction = () => ({label: t('action.undo'), run: undo});

function ask(text, dialogId = '#confirm-dialog') {
  const dialog = $(dialogId);
  if (dialogId === '#confirm-dialog') $('#confirm-text').textContent = text;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), {once: true}));
}

let downloadUrl = null;
function download(name, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], {type});
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(blob);
  const link = $('#download-link');
  link.href = downloadUrl;
  link.download = name;
  $('#download-name').textContent = name;
  $('#download-size').textContent = t('download.size', {kb: (blob.size / 1024).toFixed(1)});
  const text = $('#download-text');
  text.hidden = true;
  text.value = '';
  if (!/zip|json/.test(blob.type) && blob.size <= 2 * 1024 * 1024) {
    blob.text().then(value => {
      text.value = value.replace(/^﻿/, '');
      text.hidden = false;
    });
  }
  for (const dialog of $$('dialog[open]')) dialog.close();
  $('#download-dialog').showModal();
}

// ---------------------------------------------------------------- persistence

function record(page, order = state.pages.indexOf(page)) {
  return {
    id: page.id, name: page.name, width: page.width, height: page.height, blob: page.blob,
    calibration: page.calibration, run: page.run, measuredAt: page.measuredAt, exportedAt: page.exportedAt ?? null,
    layers: page.layers ?? null, resolution: page.resolution ?? null,
    spikelets: page.spikelets.map(edits.persistable), order
  };
}

function changed(page, {ui = true} = {}) {
  autosave.schedule(page.id, () => record(page));
  if (ui) renderAll();
}

let saveState = null;
const renderSaveState = () => { $('#save-state').textContent = saveState ? t(`save.${saveState}`) : ''; };
autosave.onState((kind, error) => {
  saveState = kind;
  renderSaveState();
  if (kind === 'error') toast(t('save.errorDetail', {error: error?.message ?? ''}), 'error');
});

async function makeRuntimePage(data) {
  const page = {
    id: data.id ?? uid(),
    name: data.name,
    width: data.width,
    height: data.height,
    blob: data.blob,
    url: URL.createObjectURL(data.blob),
    calibration: data.calibration ?? null,
    run: data.run ?? null,
    measuredAt: data.measuredAt ?? null,
    exportedAt: data.exportedAt ?? null,
    layers: data.layers ?? null,
    resolution: data.resolution ?? null,
    spikelets: data.spikelets ?? [],
    job: null,
    image: null,
    thumb: null
  };
  makeThumb(page);
  return page;
}

async function makeThumb(page) {
  try {
    const bitmap = await createImageBitmap(page.blob, {resizeWidth: 132, resizeQuality: 'medium'});
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    page.thumb = canvas.toDataURL('image/jpeg', 0.72);
    bitmap.close?.();
    renderImageList();
  } catch { /* thumbnails are optional */ }
}

function loadImage(page) {
  if (page.image || page.imageLoading) return;
  page.imageLoading = true;
  const img = new Image();
  img.onload = () => {
    page.image = img;
    page.imageLoading = false;
    viewer.render();
  };
  img.src = page.url;
}

async function restore() {
  try {
    if (!settings.restore) return;
    const rows = (await store.loadPages()).sort((a, b) => a.order - b.order);
    const restored = [];
    for (const row of rows) if (!state.pages.some(p => p.id === row.id)) restored.push(await makeRuntimePage(row));
    // Pages imported while the autosave was loading stay after the restored ones.
    state.pages = [...restored, ...state.pages];
    if (!current() && state.pages.length) openPage(state.pages[0].id);
    else renderAll();
    if (restored.length) toast(t('save.restored', {n: restored.length}));
  } catch (error) {
    console.warn('restore failed', error);
    toast(t('save.restoreFailed'), 'error');
  } finally {
    state.restored = true;
  }
}

// ---------------------------------------------------------------- import

function readImageSize(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      resolve({width: img.naturalWidth, height: img.naturalHeight});
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      reject(new Error(t('import.decodeFailed')));
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

// Resolution gate: pages far from the scale the model was trained at are
// resampled before measurement (or refused when too small, unless forced).
async function gateResolution(blob, name) {
  if (!settings.autoResolution || !serviceUsable(false)) return {blob, resolution: null};
  let assessment;
  try {
    assessment = await api().resolution(blob);
    if (assessment.status === 'too_low') {
      $('#resolution-text').textContent = t('resolution.text', {name});
      if (!(await ask(null, '#resolution-dialog'))) {
        toast(t('resolution.cancelled', {name}));
        return null;
      }
      assessment = await api().resolution(blob, {force: true});
    }
  } catch {
    return {blob, resolution: null};
  }
  if (assessment.status === 'unassessed') {
    toast(t('resolution.unassessed'));
    return {blob, resolution: {action: 'unassessed'}};
  }
  if (!['upscaled', 'downscaled'].includes(assessment.action)) return {blob, resolution: {action: 'checked'}};
  const resized = await api().resize(blob, assessment.scale_factor);
  toast(t(`resolution.${assessment.action}`, {name}), assessment.forced ? 'error' : 'info');
  return {blob: resized, resolution: {action: assessment.action, scale: assessment.scale_factor, forced: Boolean(assessment.forced)}};
}

async function importFiles(files) {
  const images = [...files]
    .filter(f => /^image\/(jpeg|png|webp)$/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name))
    .sort((a, b) => byName.compare(a.webkitRelativePath || a.name, b.webkitRelativePath || b.name));
  if (!images.length) {
    toast(t('import.noneSupported'), 'error');
    return;
  }
  $('#import-dialog').close();
  const added = [];
  for (const file of images) {
    const name = file.webkitRelativePath || file.name;
    try {
      const gated = await gateResolution(file, name);
      if (!gated) continue;
      const {width, height} = await readImageSize(gated.blob);
      const page = await makeRuntimePage({name, width, height, blob: gated.blob, resolution: gated.resolution});
      state.pages.push(page);
      added.push(page);
      changed(page, {ui: false});
    } catch (error) {
      toast(t('import.failed', {name}) + ' ' + error.message, 'error');
    }
  }
  if (!added.length) return;
  openPage(added.at(-1).id);
  toast(t('import.done', {n: added.length}));
  if (settings.autoCalibrate && serviceUsable(false)) {
    for (const page of added) if (!page.calibration) await detectGrid(page, {quiet: true});
  }
  const uncalibrated = added.find(p => !p.calibration);
  if (settings.openCalibrationAfterImport && uncalibrated) {
    openPage(uncalibrated.id);
    openCalibration();
  } else if (settings.measureAfterImport && serviceUsable(false)) {
    runBatch(added);
  }
}

// ---------------------------------------------------------------- pages

function openPage(id) {
  if (state.draft?.points.length) toast(t('draw.cancelledBySwitch'));
  autosave.flush();
  state.currentId = id;
  clearSelection();
  state.draft = null;
  state.rulerLine = null;
  state.lengthRange = null;
  state.reveal = null;
  const page = current();
  state.displayLayer = page?.run ? settings.defaultLayer : 'edits';
  state.mode = page?.run ? settings.defaultMode : 'measure';
  setTool('select');
  if (page) loadImage(page);
  viewer.resetFit();
  renderAll();
}

function clearSelection() {
  state.selected.clear();
  state.primaryUid = null;
  state.selectedNodes = [];
  state.inspectCandidate = null;
  state.inspectStep = 0;
}

async function deletePages(ids) {
  if (!ids.length || !(await ask(t('ask.deleteImages', {n: ids.length})))) return;
  for (const id of ids) {
    const page = state.pages.find(p => p.id === id);
    if (!page) continue;
    autosave.cancel(id);
    URL.revokeObjectURL(page.url);
    histories.delete(id);
    await store.deletePage(id).catch(() => {});
  }
  state.pages = state.pages.filter(p => !ids.includes(p.id));
  state.checkedPages.clear();
  if (!current()) state.currentId = state.pages[0]?.id ?? null;
  openPage(state.currentId);
  toast(t('images.removed', {n: ids.length}));
}

// ---------------------------------------------------------------- editing

function edit(mutate, page = current()) {
  if (!page) return;
  const before = snapshot(page);
  if (mutate(page) === false) return;
  historyOf(page).checkpoint(before);
  changed(page);
}

function restoreSnapshot(page, snap) {
  page.spikelets = snap.spikelets;
  page.calibration = snap.calibration;
  const uids = new Set(page.spikelets.map(s => s.uid));
  for (const u of [...state.selected]) if (!uids.has(u)) state.selected.delete(u);
  if (!uids.has(state.primaryUid)) state.primaryUid = [...state.selected].at(-1) ?? null;
  state.selectedNodes = [];
  changed(page);
}

function undo() {
  const page = current();
  if (!page || state.mode !== 'measure') return;
  const snap = historyOf(page).undo(snapshot(page));
  if (snap) restoreSnapshot(page, snap);
}

function redo() {
  const page = current();
  if (!page || state.mode !== 'measure') return;
  const snap = historyOf(page).redo(snapshot(page));
  if (snap) restoreSnapshot(page, snap);
}

function select(uidValue, {additive = false, reveal = true, focus = false} = {}) {
  const changedSpikelet = uidValue !== state.primaryUid;
  if (!additive) state.selected.clear();
  state.selectedNodes = [];
  if (uidValue) {
    if (additive && state.selected.has(uidValue)) state.selected.delete(uidValue);
    else state.selected.add(uidValue);
  }
  state.primaryUid = uidValue && state.selected.has(uidValue) ? uidValue : [...state.selected].at(-1) ?? null;
  if (changedSpikelet) {
    state.inspectCandidate = null;
    state.inspectStep = Infinity;
  }
  const page = current();
  const s = primary();
  if (s && statusOf(s, page) === STATUS.needsReview) markSeen(page, s);
  renderPanels();
  viewer.render();
  if (reveal) $(`#rows tr[data-uid="${CSS.escape(state.primaryUid ?? '')}"]`)?.scrollIntoView({block: 'nearest'});
  if (focus) focusSelection(true);
}

function markSeen(page, s) {
  const key = seenKey(page, s);
  if (seenReview.has(key)) return;
  seenReview.add(key);
  try { localStorage.setItem(REVIEW_SEEN_KEY, JSON.stringify([...seenReview].slice(-5000))); } catch { /* optional */ }
}

function visibleSpikelets(page = current()) {
  if (!page) return [];
  const test = FILTERS[state.filter] ?? FILTERS.all;
  const query = state.search.trim().toLowerCase();
  const range = state.lengthRange;
  const inRange = s => {
    if (!range) return true;
    const length = lengthOf(s, page);
    return length !== null && length >= range[0] && length < range[1];
  };
  const list = page.spikelets.filter(s => test(statusOf(s, page)) && inRange(s) && (!query || s.name.toLowerCase().includes(query)));
  return sortSpikelets(list, page);
}

const STATUS_ORDER = [STATUS.missing, STATUS.needsReview, STATUS.modified, STATUS.automatic, STATUS.confirmed];

function sortSpikelets(list, page) {
  const {key, dir} = state.sort;
  // The review queue is worked most-urgent first unless another order was chosen.
  if (state.filter === 'needs_review' && key === 'name' && dir === 'asc') {
    return list.map(s => ({s, v: reviewSeverity(s, reviewOptions(page)).score}))
      .sort((a, b) => b.v - a.v || byName.compare(a.s.name, b.s.name)).map(x => x.s);
  }
  const value = {
    name: s => s.name,
    length: s => lengthOf(s, page),
    score: s => representative(s)?.score ?? null,
    status: s => STATUS_ORDER.indexOf(statusOf(s, page))
  }[key];
  const sign = dir === 'asc' ? 1 : -1;
  return list.map(s => ({s, v: value(s)})).sort((a, b) => {
    if (a.v === null && b.v === null) return byName.compare(a.s.name, b.s.name);
    if (a.v === null) return 1; // missing values last in both directions
    if (b.v === null) return -1;
    const c = typeof a.v === 'string' ? byName.compare(a.v, b.v) : a.v - b.v;
    return c * sign || byName.compare(a.s.name, b.s.name);
  }).map(x => x.s);
}

function step(delta) {
  const list = visibleSpikelets();
  if (!list.length) return;
  const index = list.findIndex(s => s.uid === state.primaryUid);
  const next = list[(index + delta + list.length) % list.length];
  select(next.uid, {focus: settings.autoFocus});
}

function confirmSpikelets(list, value = true) {
  const order = visibleSpikelets();
  const targets = list.filter(s => !value || canConfirm(s));
  if (!targets.length) {
    toast(t('detail.cannotConfirm'), 'error');
    return;
  }
  const uids = new Set(targets.map(s => s.uid));
  edit(page => page.spikelets.forEach(s => { if (uids.has(s.uid)) s.confirmed = value; }));
  if (value && targets.length > 1) toast(t('results.confirmedN', {n: targets.length}));
  if (value && targets.length === 1 && settings.autoAdvance) {
    const at = order.findIndex(s => s.uid === targets[0].uid);
    const ordered = [...order.slice(at + 1), ...order.slice(0, Math.max(0, at))];
    const next = ordered.find(s => statusOf(s) !== STATUS.confirmed);
    if (next) select(next.uid, {focus: settings.autoFocus});
  }
}

async function deleteSelected() {
  const page = current();
  if (!page || !editable()) return;
  if (state.selectedNodes.length) return deleteNodes();
  const uids = [...state.selected];
  if (!uids.length) return;
  if (settings.confirmDestructive && !(await ask(t('ask.deleteSpikelets', {n: uids.length})))) return;
  edit(p => { p.spikelets = p.spikelets.filter(s => !uids.includes(s.uid)); });
  clearSelection();
  renderAll();
  toast(t('detail.deleted', {n: uids.length}), 'info', undoAction());
}

// Delete the vertices picked with the box tool. A path left with fewer than two
// vertices is cleared; an outline left with fewer than three removes the spikelet.
function deleteNodes() {
  const nodes = state.selectedNodes;
  edit(page => {
    const byKey = new Map();
    for (const n of nodes) {
      const key = `${n.uid}|${n.kind}`;
      if (!byKey.has(key)) byKey.set(key, {uid: n.uid, kind: n.kind, indices: new Set()});
      byKey.get(key).indices.add(n.index);
    }
    const removed = new Set();
    for (const {uid: id, kind, indices} of byKey.values()) {
      const s = spikeletByUid(page, id);
      if (!s) continue;
      edits.prepare(s, kind);
      const keep = s[kind].filter((_, i) => !indices.has(i));
      if (kind === 'line' && keep.length < 2) s.line = [];
      else if (kind === 'polygon' && keep.length < 3) removed.add(id);
      else s[kind] = keep;
      s.modified = true;
      s.confirmed = false;
    }
    page.spikelets = page.spikelets.filter(s => !removed.has(s.uid));
  });
  toast(t('draw.deletedVertices', {n: nodes.length}), 'info', undoAction());
  clearSelection();
  renderAll();
}

function deleteAwn() {
  const s = primary();
  if (!s || s.line.length < 2) return;
  edit(page => {
    const target = spikeletByUid(page, s.uid);
    target.line = [];
    target.rep = null;
    target.modified = true;
    target.confirmed = false;
  });
  toast(t('detail.awnDeleted', {id: s.name}), 'info', undoAction());
}

function focusSelection(keepZoom = false) {
  const page = current();
  const chosen = page?.spikelets.filter(s => state.selected.has(s.uid)) ?? [];
  if (!chosen.length) return;
  const box = unionBounds(chosen.map(s => bounds([...s.polygon, ...s.line])));
  if (keepZoom) {
    const v = viewer.view;
    const canvas = $('#canvas');
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    const [sx, sy] = [cx * v.scale + v.tx, cy * v.scale + v.ty];
    const visible = sx > 60 && sy > 60 && sx < canvas.clientWidth - 60 && sy < canvas.clientHeight - 60;
    if (visible && v.scale > 0.25) return;
  }
  const pad = page.width * 0.025;
  viewer.fitBox({x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad}, 0, {animate: true});
}

// ---------------------------------------------------------------- tools and drafts

function setTool(tool) {
  if (tool !== 'select' && !current()) {
    toast(t('common.importFirst'));
    tool = 'select';
  }
  if (tool === 'awn' && !primary()) {
    toast(t('hint.needSelection'));
    tool = 'select';
  }
  // Drawing and vertex tools work on the editable result.
  if (['awn', 'spikelet', 'box'].includes(tool)) {
    state.displayLayer = 'edits';
    state.mode = 'measure';
  }
  state.tool = tool;
  state.selectedNodes = [];
  state.draft = ['select', 'box'].includes(tool) ? null : {kind: tool, points: [], targetUid: state.primaryUid};
  $('#canvas-wrap').dataset.tool = tool;
  for (const b of $$('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  renderDrawBar();
  renderLayerSwitch();
  renderMode();
  viewer?.render();
}

function addDraftPoint(p) {
  if (!state.draft) return;
  state.draft.points.push(p);
  if (state.draft.kind === 'ruler' && state.draft.points.length === 2) finishDraft();
  renderDrawBar();
}

function undoDraftPoint() {
  if (!state.draft?.points.length) return;
  state.draft.points.pop();
  renderDrawBar();
  viewer.render();
}

function finishDraft() {
  const draft = state.draft;
  if (!draft) return;
  const points = edits.cleanDraft(draft.points, 1);
  if (draft.kind === 'awn') {
    if (points.length < 2) return toast(t('draw.lineMinPoints'));
    const s = spikeletByUid(current(), draft.targetUid);
    if (s) edit(page => edits.setLine(spikeletByUid(page, s.uid), points));
    setTool('select');
    select(draft.targetUid);
    toast(current().calibration ? t('draw.awnUpdated', {id: s?.name ?? ''}) : t('draw.awnNeedsCalibration', {id: s?.name ?? ''}));
  } else if (draft.kind === 'spikelet') {
    if (points.length < 3) return toast(t('draw.polygonMinVertices'));
    if (polygonArea(points) < MIN_SPIKELET_AREA_PX) return toast(t('draw.tooSmall'), 'error');
    let created = null;
    edit(page => {
      created = newManualSpikelet(page.spikelets, points);
      page.spikelets.push(created);
    });
    select(created.uid);
    setTool('awn');
    toast(t('draw.spikeletCreated', {id: created.name}));
  } else if (draft.kind === 'ruler' && points.length === 2) {
    if (distance(points[0], points[1]) < 1) {
      state.draft.points = [];
      return toast(t('draw.calibrationLineShort'));
    }
    state.rulerLine = points;
    setTool('select');
    openCalibration('line');
  }
  renderDrawBar();
}

function renderDrawBar() {
  const draft = state.draft;
  $('#draw-bar').hidden = !draft || draft.kind === 'ruler';
  $('#draw-finish').disabled = !draft || draft.points.length < (draft.kind === 'awn' ? 2 : 3);
  if (draft) {
    const s = spikeletByUid(current(), draft.targetUid);
    $('#draw-text').textContent = draft.kind === 'awn'
      ? t('draw.awnFor', {id: s?.name ?? '', n: draft.points.length})
      : t('draw.points', {n: draft.points.length});
    $('#draw-finish').textContent = draft.kind === 'awn' ? t('draw.finishAwn') : t('draw.finishSpikelet');
  }
  $('#hint').textContent = t(`hint.${state.tool}`);
}

// ---------------------------------------------------------------- viewer host

function inspectionScene() {
  const s = primary();
  if (state.mode !== 'inspect' || !s || sourcePreview()) return null;
  const k = state.inspectCandidate ?? s.rep ?? 0;
  const candidate = s.candidates[k];
  if (!candidate) return null;
  const steps = inspectionSteps(candidate);
  const stepIndex = Math.min(state.inspectStep, steps.length - 1);
  return {
    steps: visibleSteps(steps, stepIndex),
    pool: settings.showPool ? s.candidates.filter((_, i) => i !== k).map(c => c.path) : null
  };
}

const viewer = createViewer($('#canvas'), {
  scene() {
    const page = current();
    const live = state.live && state.live.pageId === page?.id ? state.live : null;
    return {
      page,
      image: page?.image ?? null,
      spikelets: page?.spikelets ?? [],
      evidence: page?.layers?.evidence ?? null,
      selected: state.selected,
      selectedNodes: state.selectedNodes,
      primary: primary(),
      tool: state.tool,
      editable: editable(),
      layers: settings.layers,
      displayLayer: state.displayLayer,
      live,
      reveal: state.reveal,
      inspect: page ? inspectionScene() : null,
      sourcePreview: sourcePreview(),
      photoHidden: state.photoHidden,
      spikeletContext: settings.spikeletContext,
      threshold: state.threshold,
      draft: state.draft && state.draft.kind !== 'ruler' ? state.draft : null,
      ruler: state.draft?.kind === 'ruler' ? state.draft.points : state.rulerLine,
      showCandidatesOfSelected: state.mode === 'measure',
      hoverUid: state.rowHover,
      candidateCursor: s => (s.uid === state.primaryUid ? state.candidateCursor.get(s.uid) ?? (state.mode === 'inspect' ? state.inspectCandidate : undefined) : undefined),
      statusOf: s => statusOf(s, page),
      labelOf: s => `${s.name} · ${fmt(lengthOf(s, page))}`
    };
  },
  editPoints: (s, kind) => edits.editPoints(s, kind),
  select: (u, options) => select(u, options),
  selectCandidate(u, k) {
    select(u);
    state.inspectCandidate = k;
    state.candidateCursor.set(u, k);
    state.inspectStep = Infinity;
    setMode('inspect');
  },
  selectMany(uids) {
    for (const u of uids) state.selected.add(u);
    state.primaryUid = uids.at(-1) ?? state.primaryUid;
    renderPanels();
  },
  selectNodes(nodes) {
    clearSelection();
    state.selectedNodes = nodes;
    const first = nodes[0];
    if (first) {
      state.selected.add(first.uid);
      state.primaryUid = first.uid;
    }
    toast(nodes.length ? t('draw.selectedVertices', {n: nodes.length}) : t('draw.noVertices'));
    renderPanels();
    viewer.render();
  },
  beginVertexDrag(s, kind) {
    s.dragBefore = snapshot(current());
    edits.prepare(s, kind);
  },
  moveVertex: (s, kind, index, point) => edits.moveVertex(s, kind, index, point),
  endVertexDrag(s) {
    const page = current();
    historyOf(page).checkpoint(s.dragBefore);
    delete s.dragBefore;
    changed(page);
  },
  insertVertex: (s, kind, index, point) => edit(page => edits.insertVertex(spikeletByUid(page, s.uid), kind, index, point)),
  removeVertex: (s, kind, index) => edit(page => edits.removeVertex(spikeletByUid(page, s.uid), kind, index)),
  addDraftPoint,
  undoDraftPoint,
  finishDraft,
  focus: s => select(s.uid, {focus: true}),
  onCursor(p) {
    $('#cursor').textContent = p ? `${Math.round(p[0])}, ${Math.round(p[1])} px` : '';
  },
  onHover(id) {
    for (const tr of $$('#rows tr[data-hover]')) delete tr.dataset.hover;
    const s = spikeletByUid(current(), id);
    if (s) $(`#rows tr[data-uid="${CSS.escape(id)}"]`)?.setAttribute('data-hover', '');
    $('#hover-info').textContent = s ? `${t('col.id')} ${s.name} · ${fmt(lengthOf(s))} mm · ${t(`status.${statusOf(s)}`)}` : '';
  },
  onView(v) {
    $('#zoom-level').textContent = `${Math.round(v.scale * 100)}%`;
  },
  onRendered: () => positionFloating()
}, {minimap: $('#minimap')});

// Floating controls that follow the selection on the canvas.
function positionFloating() {
  const page = current();
  const s = primary();
  const wrap = $('#canvas-wrap');
  const W = wrap.clientWidth, H = wrap.clientHeight;
  const place = (el, [x, y], dx, dy) => {
    const w = el.offsetWidth || 90, h = el.offsetHeight || 28;
    el.style.left = `${Math.max(8, Math.min(W - w - 8, x + dx))}px`;
    el.style.top = `${Math.max(8, Math.min(H - h - 8, y + dy))}px`;
  };
  const confirmButton = $('#floating-confirm');
  const showConfirm = Boolean(page && s && editable() && state.tool === 'select' && s.line.length >= 2 && !state.reveal && state.selected.size === 1);
  confirmButton.hidden = !showConfirm;
  if (showConfirm) {
    confirmButton.textContent = s.confirmed ? t('floating.reopen') : t('floating.confirm');
    confirmButton.dataset.confirmed = String(s.confirmed);
    place(confirmButton, viewer.project(s.line.at(-1)), 12, -14);
  }
  const nav = $('#candidate-nav');
  const showNav = Boolean(page && s && state.displayLayer === 'candidates' && s.candidates.length && !sourcePreview() && !state.reveal);
  nav.hidden = !showNav;
  if (showNav) {
    const n = s.candidates.length;
    const k = state.candidateCursor.get(s.uid) ?? s.rep ?? 0;
    $('#cand-pos').textContent = `${k + 1} / ${n}`;
    $('#cand-prev').disabled = $('#cand-next').disabled = n < 2;
    const active = k === s.rep;
    $('#cand-use').textContent = active ? '★' : '☆';
    $('#cand-use').title = active ? t('detail.isRepresentative') : t('detail.useCandidate');
    const b = bounds(s.polygon);
    place(nav, viewer.project([(b.x0 + b.x1) / 2, b.y1]), -(nav.offsetWidth || 140) * 0.4, 12);
  }
}

// ---------------------------------------------------------------- service

function serviceUsable(report = true) {
  const ok = ['ready', 'idle', 'busy', 'loading'].includes(state.service.state);
  if (!ok && report) toast(t('error.service'), 'error');
  return ok;
}

async function checkService() {
  try {
    const info = await api().health();
    const model = info.model?.state;
    state.service = {
      info,
      state: model === 'disabled' ? 'edit-only' : model === 'error' ? 'error' : info.busy ? 'busy' : model === 'ready' ? 'ready' : model === 'loading' ? 'loading' : 'idle'
    };
    if (!state.models.length) {
      const catalog = await api().models().catch(() => ({models: []}));
      state.models = catalog.models ?? [];
      renderModels();
    }
  } catch {
    state.service = {state: 'offline', info: null};
  }
  renderService();
  renderStage();
  renderBatch();
}

function renderModels() {
  const select = $('#model-select');
  const models = state.models.length ? state.models : [{id: '', name: t('model.none'), available: false}];
  select.replaceChildren(...models.map(m => {
    const option = new Option(m.name, m.id);
    option.disabled = !m.available;
    return option;
  }));
  select.disabled = state.models.length < 2;
}

function renderService() {
  const box = $('#model-box');
  const s = state.service.state;
  box.dataset.state = s;
  box.title = state.service.info?.model?.weights ?? '';
  $('#service-retry').hidden = s !== 'offline' && s !== 'error';
  $('#samples-open').hidden = s === 'offline';
  if (!state.measuring && !state.batch) {
    const key = {ready: 'ready', idle: 'idle', busy: 'busy', loading: 'loading', offline: 'offline', 'edit-only': 'editOnly', error: 'error'}[s];
    const device = state.service.info?.model?.device === 'cpu' ? 'CPU' : 'GPU';
    if (key && !$('#model-status').dataset.sticky) $('#model-status').textContent = t(`service.${key}`, {device});
  }
}

async function detectGrid(page, {quiet = false} = {}) {
  try {
    const result = await api().calibrate(page.blob);
    const grid = cal.fromGrid(result);
    edit(p => { p.calibration = grid; }, page);
    if (!quiet) toast(t('cal.applied'));
    return grid;
  } catch (error) {
    if (!quiet) toast(t('error.calibrate', {error: error.message}), 'error');
    return null;
  }
}

function hasReview(page) {
  return page.spikelets.some(s => s.confirmed || s.modified || s.origin === 'manual');
}

let elapsedTimer = 0;
function startElapsed() {
  const el = $('#model-elapsed');
  const started = performance.now();
  el.hidden = false;
  clearInterval(elapsedTimer);
  const tick = () => { el.textContent = formatElapsed(performance.now() - started); };
  tick();
  elapsedTimer = setInterval(tick, 100);
  return () => {
    clearInterval(elapsedTimer);
    tick();
    return performance.now() - started;
  };
}

function formatElapsed(ms) {
  const s = Math.max(0, ms) / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`;
}

// A status line that stays until the next measurement (completion summary).
function setModelStatus(text, sticky = false) {
  const el = $('#model-status');
  el.textContent = text;
  if (sticky) el.dataset.sticky = '1';
  else delete el.dataset.sticky;
}

async function measure(page, {askReplace = true, prefix = ''} = {}) {
  if (!serviceUsable()) return false;
  if (!page.calibration) {
    state.calContinuation = 'run';
    if (page.id !== state.currentId) openPage(page.id);
    openCalibration('grid');
    toast(t('model.calibrateFirst'));
    return false;
  }
  if (askReplace && settings.confirmReplace && hasReview(page) && !(await ask(t('ask.replace', {name: page.name})))) return false;
  const controller = new AbortController();
  page.job = {state: 'queued', stage: 'queued', progress: 0, controller};
  state.measuring = true;
  if (settings.livePreview) {
    state.live = {pageId: page.id, evidence: [], tiles: {done: 0, total: 0}, stage: 'queued', tileRects: tileWindows(page.width, page.height)};
  }
  const stopElapsed = startElapsed();
  setModelStatus(prefix + t('model.submitting'));
  renderAll();
  try {
    const job = await api().measure(page.blob, {
      name: page.name,
      periods: cal.servicePeriods(page.calibration),
      signal: controller.signal,
      onEvidence(items) {
        if (state.live?.pageId === page.id) state.live.evidence.push(...items);
      },
      onProgress(j) {
        Object.assign(page.job, {state: j.state, stage: j.stage, progress: j.progress ?? 0, tiles: j.tiles});
        if (state.live?.pageId === page.id) Object.assign(state.live, {tiles: j.tiles, stage: j.stage});
        setModelStatus(prefix + t(`job.stage.${j.stage ?? 'queued'}`, {done: j.tiles?.done ?? 0, total: j.tiles?.total ?? 0}));
        renderJob();
        renderImageList();
        renderBatch();
        viewer.render();
      }
    });
    const elapsed = stopElapsed();
    const result = job.result;
    if (result.width && (result.width !== page.width || result.height !== page.height)) {
      throw new Error(t('error.sizeMismatch', {service: `${result.width}×${result.height}`, browser: `${page.width}×${page.height}`}));
    }
    state.live = null;
    edit(p => {
      p.spikelets = spikeletsFromResult(result);
      p.layers = pageLayersFromResult(result);
      p.run = {...runInfo(result), periods: {x: result.x_period_px, y: result.y_period_px}, qc: result.calibration ?? null};
      if (p.calibration.method === 'grid') p.calibration = calibrationFromResult(result);
      p.measuredAt = new Date().toISOString();
    }, page);
    page.job = {state: 'done', progress: 1};
    const awns = page.spikelets.filter(s => s.line.length >= 2).length;
    setModelStatus(prefix + t('model.complete', {spikelets: page.spikelets.length, awns, seconds: (elapsed / 1000).toFixed(1)}), true);
    if (page.id === state.currentId) {
      clearSelection();
      if (settings.completionAnimation && !reducedMotion() && !state.batch) await playReveal(page);
      state.displayLayer = settings.defaultLayer;
      state.mode = settings.defaultMode;
      toast(t('measure.done', {name: page.name, n: page.spikelets.length}), 'info', undoAction());
    }
    return true;
  } catch (error) {
    stopElapsed();
    state.live = null;
    if (controller.signal.aborted) {
      page.job = null;
      toast(t('job.cancelled', {name: page.name}));
      setModelStatus(t('job.cancelled', {name: page.name}), true);
      return false;
    }
    page.job = {state: 'error', error: error.message};
    setModelStatus(t('model.didNotFinish', {message: error.message}), true);
    toast(t('error.measure', {name: page.name, error: error.message}), 'error');
    return false;
  } finally {
    state.measuring = false;
    renderAll();
    checkService();
  }
}

// Completion reveal: evidence -> seeds -> each growth hop -> candidates ->
// the measurement paths drawn from root to tip.
async function playReveal(page) {
  const show = async (layer, reveal, ms) => {
    if (state.currentId !== page.id) return false;
    state.displayLayer = layer;
    state.reveal = reveal;
    renderLayerSwitch();
    viewer.render();
    await sleep(ms);
    return state.currentId === page.id;
  };
  const hops = maxHop(page.spikelets);
  const growth = page.spikelets.some(s => s.candidates.some(c => c.growth));
  if (page.layers?.evidence?.length && !(await show('evidence', {stage: 'evidence'}, 520))) return endReveal();
  if (growth) {
    for (let hop = 0; hop <= hops; hop++) if (!(await show('growth', {stage: 'growth', hop}, hop ? 420 : 520))) return endReveal();
    if (!(await show('candidates', {stage: 'candidates'}, 520))) return endReveal();
  }
  state.displayLayer = 'edits';
  renderLayerSwitch();
  const started = performance.now();
  const duration = 900;
  await new Promise(resolve => {
    const frame = now => {
      const tt = Math.min(1, (now - started) / duration);
      state.reveal = {stage: 'trace', t: tt};
      viewer.render();
      if (tt < 1 && state.currentId === page.id) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
  endReveal();
}

function endReveal() {
  state.reveal = null;
  viewer.render();
}

async function runBatch(pages) {
  if (state.batch) return;
  const candidates = pages ?? state.pages.filter(p => !p.run && p.job?.state !== 'running');
  const todo = candidates.filter(p => p.calibration);
  const skipped = candidates.length - todo.length;
  if (!todo.length) {
    toast(skipped ? t('batch.allUncalibrated', {n: skipped}) : t('batch.none'));
    return;
  }
  if (!serviceUsable()) return;
  state.batch = {total: todo.length, done: 0, failed: 0, skipped, stop: false, started: Date.now(), current: null};
  renderBatch();
  let last = null;
  for (const [i, page] of todo.entries()) {
    if (state.batch.stop) break;
    if (!state.pages.includes(page)) continue;
    state.batch.current = page;
    const ok = await measure(page, {askReplace: false, prefix: `[${i + 1}/${todo.length}] `});
    if (ok) {
      state.batch.done++;
      last = page;
    } else {
      state.batch.failed++;
      if (!settings.continueBatchAfterError || !serviceUsable(false)) state.batch.stop = true;
    }
    renderBatch();
  }
  const b = state.batch;
  state.batch = null;
  const notRun = b.total - b.done - b.failed;
  const message = t('batch.complete', {done: b.done, failed: b.failed, skipped: b.skipped + notRun});
  setModelStatus(message, true);
  toast(message);
  if (last && last.id !== state.currentId) openPage(last.id);
  renderAll();
}

function renderBatch() {
  const b = state.batch;
  const usable = serviceUsable(false);
  const pending = state.pages.filter(p => !p.run && p.calibration).length;
  $('#measure-pending').hidden = Boolean(b);
  $('#measure-pending').disabled = !usable || !pending;
  $('#measure-pending').textContent = pending ? t('batch.runCount', {n: pending}) : t('batch.run');
  $('#measure-pending').title = usable ? '' : t('error.service');
  $('#batch-stop').hidden = !b;
  $('#batch-stop').disabled = Boolean(b?.stop);
  $('#batch-progress').hidden = !b;
  if (!b) return;
  const partial = b.current?.job?.progress ?? 0;
  const finished = b.done + b.failed;
  $('#batch-bar').style.width = `${Math.round(((finished + Math.min(1, partial)) / b.total) * 100)}%`;
  const elapsed = (Date.now() - b.started) / 1000;
  const eta = finished > 0 ? (elapsed / finished) * (b.total - finished) : null;
  $('#batch-text').textContent = t('batch.progress', {done: finished, total: b.total}) +
    (eta !== null ? ' · ' + t('batch.eta', {time: formatDuration(eta)}) : '') +
    (b.stop ? ' · ' + t('batch.stopping') : '');
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

// ---------------------------------------------------------------- calibration dialog

function setCalMode(mode) {
  for (const input of $$('[name="cal-mode"]')) input.checked = input.value === mode;
  for (const section of $$('[data-cal]')) section.hidden = section.dataset.cal !== mode;
}

function openCalibration(mode = null) {
  const page = current();
  if (!page) return toast(t('common.importFirst'));
  const c = page.calibration;
  $('#cal-current').textContent = c ? t('cal.current', {value: cal.describe(c), method: t(`method.${c.method}`)}) : t('cal.none');
  $('#cal-grid-result').textContent = c?.method === 'grid'
    ? t('cal.gridResult', {x: c.periodsPx[0].toFixed(2), y: c.periodsPx[1].toFixed(2)}) + (c.adequate ? ' · ' + t('cal.qcPassed') : ' · ' + t('cal.gridWarn', {reasons: c.qcReasons.join(', ')}))
    : '';
  const line = state.rulerLine ?? (c?.method === 'two_point' ? c.points : null);
  $('#cal-pixels').textContent = line ? t('cal.pixels', {px: distance(line[0], line[1]).toFixed(2)}) : t('cal.noLine');
  $('#cal-mm').value = c?.method === 'two_point' && !state.rulerLine ? c.knownMm : '';
  $('#cal-unit').value = '1';
  $('#cal-ratio').value = c ? cal.meanMmPerPx(c).toPrecision(8) : '';
  $('#cal-grid').disabled = !serviceUsable(false);
  $('#cal-propagate').checked = false;
  $('#cal-error').textContent = '';
  setCalMode(mode ?? (state.rulerLine ? 'line' : c?.method === 'two_point' ? 'line' : c?.method === 'ratio' ? 'ratio' : 'grid'));
  if (!$('#calibration-dialog').open) $('#calibration-dialog').showModal();
  if (state.rulerLine) $('#cal-mm').focus();
}

function applyCalibration(calibration) {
  const page = current();
  const propagate = $('#cal-propagate').checked;
  edit(p => {
    p.calibration = calibration;
    for (const s of p.spikelets) s.confirmed = false;
  }, page);
  let others = 0;
  if (propagate) {
    for (const p of state.pages) {
      if (p === page || p.calibration || p.width !== page.width || p.height !== page.height) continue;
      edit(q => { q.calibration = structuredClone(calibration); }, p);
      others++;
    }
  }
  state.rulerLine = null;
  const continuation = state.calContinuation;
  state.calContinuation = null;
  $('#calibration-dialog').close('applied');
  toast(others ? t('cal.appliedMore', {n: others}) : t('cal.applied'));
  if (continuation === 'run' || (settings.runAfterCalibration && !page.run && serviceUsable(false))) queueMicrotask(() => measure(page));
}

// ---------------------------------------------------------------- project and export

async function saveProject() {
  if (!state.pages.length) return toast(t('export.nothing'));
  await autosave.flush();
  const pages = [];
  for (const page of state.pages) pages.push(serializePage(record(page), await blobToDataUrl(page.blob)));
  const stamp = new Date().toISOString().slice(0, 10);
  download(`awnstudio-project-${stamp}.json`, JSON.stringify(buildProject(pages)), 'application/json');
}

async function openProject(file) {
  let data;
  try {
    data = parseProject(JSON.parse(await file.text()));
  } catch (error) {
    toast(t('project.invalid', {error: error.message}), 'error');
    return;
  }
  if (state.pages.length && settings.confirmProjectReplace && !(await ask(t('ask.openProject', {n: state.pages.length})))) return;
  const pages = [];
  for (const row of data.pages) {
    const blob = await dataUrlToBlob(row.image);
    const size = await readImageSize(blob);
    if (size.width !== row.width || size.height !== row.height) {
      toast(t('project.dimensionMismatch', {name: row.name}), 'error');
      return;
    }
    pages.push(await makeRuntimePage({...row, blob}));
  }
  await clearWorkspace(false);
  state.pages = pages;
  for (const page of pages) changed(page, {ui: false});
  openPage(state.pages[0]?.id ?? null);
  toast(t('project.opened', {n: state.pages.length}));
}

async function clearWorkspace(confirmFirst = true) {
  if (confirmFirst && !(await ask(t('ask.clear')))) return;
  for (const page of state.pages) {
    autosave.cancel(page.id);
    URL.revokeObjectURL(page.url);
  }
  state.pages = [];
  histories.clear();
  state.checkedPages.clear();
  await store.clearPages().catch(() => {});
  openPage(null);
}

function openExport() {
  const pages = exportablePages(state.pages);
  if (!pages.length) return toast(t('export.nothing'));
  const pending = pages.reduce((n, p) => n + p.spikelets.filter(s => statusOf(s, p) !== STATUS.confirmed).length, 0);
  const missing = pages.reduce((n, p) => n + p.spikelets.filter(s => s.line.length < 2).length, 0);
  const uncalibrated = pages.filter(p => !cal.isValid(p.calibration)).length;
  $('#export-summary').textContent = t('export.summary', {pages: pages.length, spikelets: pages.reduce((n, p) => n + p.spikelets.length, 0), pending, missing}) +
    (uncalibrated ? ' ' + t('export.uncalibrated', {n: uncalibrated}) : '');
  $('#export-current').disabled = !current()?.spikelets.length;
  $('#export-dialog').showModal();
}

function markExported(pages) {
  const now = new Date().toISOString();
  for (const page of pages) {
    page.exportedAt = now;
    changed(page, {ui: false});
  }
  renderSteps();
}

// ---------------------------------------------------------------- samples

async function openSamples() {
  const list = $('#sample-list');
  list.replaceChildren();
  $('#samples-dialog').showModal();
  try {
    const samples = await api().samples();
    if (!samples.length) list.append(Object.assign(document.createElement('li'), {textContent: t('samples.none')}));
    for (const sample of samples) {
      const li = document.createElement('li');
      const button = Object.assign(document.createElement('button'), {type: 'button', textContent: sample.id});
      button.addEventListener('click', () => loadSample(sample.id, button));
      li.append(button);
      list.append(li);
    }
  } catch (error) {
    list.append(Object.assign(document.createElement('li'), {textContent: error.message}));
  }
}

async function loadSample(id, button) {
  button.disabled = true;
  button.textContent = t('samples.loading');
  try {
    const client = api();
    const [blob, result] = await Promise.all([fetch(client.sampleImageUrl(id)).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.blob();
    }), client.sampleResult(id)]);
    const {width, height} = await readImageSize(blob);
    const page = await makeRuntimePage({
      name: `${id}.JPG`, width, height, blob,
      calibration: calibrationFromResult(result),
      run: {...runInfo(result), periods: {x: result.x_period_px, y: result.y_period_px}, qc: result.calibration ?? null, sample: true},
      layers: pageLayersFromResult(result),
      spikelets: spikeletsFromResult(result),
      measuredAt: result.measured_at ?? null
    });
    state.pages.push(page);
    changed(page, {ui: false});
    $('#samples-dialog').close();
    openPage(page.id);
    toast(t('samples.loaded', {name: page.name}));
  } catch (error) {
    toast(error.message, 'error');
    button.disabled = false;
    button.textContent = id;
  }
}

// ---------------------------------------------------------------- rendering

function renderAll() {
  renderImageList();
  renderStage();
  renderPanels();
  renderSteps();
  renderBatch();
  renderLayerSwitch();
  renderMode();
  viewer.render();
}

function renderPanels() {
  renderResults();
  renderDetail();
  renderInspect();
  const page = current();
  const measuring = state.mode === 'measure';
  $('#undo').disabled = !page || !measuring || !historyOf(page).canUndo;
  $('#redo').disabled = !page || !measuring || !historyOf(page).canRedo;
  $('#delete-selection').disabled = !editable() || (!state.selected.size && !state.selectedNodes.length);
  $('#focus').disabled = !state.selected.size;
  for (const b of $$('[data-tool]')) b.disabled = !page || (!['select', 'ruler'].includes(b.dataset.tool) && !measuring);
  $('#source-preview').disabled = $('#background-toggle').disabled = !page;
  $('#source-preview').setAttribute('aria-pressed', String(state.sourcePinned));
  $('#background-toggle').setAttribute('aria-pressed', String(state.photoHidden));
  $('#original-badge').hidden = !sourcePreview() || !page;
  $('#original-badge').textContent = state.sourcePinned ? t('canvas.originalPinned') : t('canvas.original');
  positionFloating();
}

function renderImageList() {
  const list = $('#image-list');
  $('#image-count').textContent = state.pages.length;
  list.replaceChildren(...state.pages.map(page => {
    const li = document.createElement('li');
    li.dataset.id = page.id;
    li.setAttribute('aria-current', String(page.id === state.currentId));
    const check = Object.assign(document.createElement('input'), {type: 'checkbox', checked: state.checkedPages.has(page.id)});
    check.setAttribute('aria-label', t('images.selectOne', {name: page.name}));
    check.addEventListener('click', event => event.stopPropagation());
    check.addEventListener('change', () => {
      check.checked ? state.checkedPages.add(page.id) : state.checkedPages.delete(page.id);
      renderImageListTools();
    });
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (page.thumb) thumb.style.backgroundImage = `url(${page.thumb})`;
    const text = document.createElement('div');
    const name = Object.assign(document.createElement('div'), {className: 'name', textContent: page.name, title: page.name});
    const sub = document.createElement('div');
    sub.className = 'sub';
    const job = page.job?.state;
    if (job && job !== 'done') {
      const pill = Object.assign(document.createElement('span'), {className: 'pill', textContent: t(`job.${job}`)});
      pill.dataset.job = job;
      sub.append(pill);
    }
    const n = page.spikelets.length;
    const done = page.spikelets.filter(s => statusOf(s, page) === STATUS.confirmed).length;
    if (!cal.isValid(page.calibration)) {
      const pill = Object.assign(document.createElement('span'), {className: 'pill', textContent: t('images.uncalibrated')});
      pill.dataset.state = 'uncalibrated';
      sub.append(pill);
    }
    sub.append(document.createTextNode(n ? t('images.confirmed', {done, n}) : page.run ? t('images.measured', {n}) : cal.isValid(page.calibration) ? t('images.ready') : ''));
    text.append(name, sub);
    li.append(check, thumb, text);
    if (n) {
      const bar = document.createElement('div');
      bar.className = 'bar progress';
      bar.append(Object.assign(document.createElement('i'), {style: `width: ${(100 * done) / n}%`}));
      li.append(bar);
    }
    li.addEventListener('click', () => openPage(page.id));
    return li;
  }));
  renderImageListTools();
}

function renderImageListTools() {
  const total = state.pages.length, count = state.checkedPages.size;
  const all = $('#select-all-images');
  all.checked = total > 0 && count === total;
  all.indeterminate = count > 0 && count < total;
  all.disabled = !total;
  $('#delete-images').disabled = !count;
  $('#delete-images').textContent = count ? t('images.deleteCount', {n: count}) : t('images.deleteSelected');
}

function renderStage() {
  const page = current();
  $('#empty').hidden = Boolean(page);
  $('#toolbar').hidden = $('#layers').hidden = $('#zoom-controls').hidden = !page;
  $('#page-name').textContent = page?.name ?? t('canvas.start');
  const meta = [];
  if (page) {
    meta.push(`${page.width} × ${page.height} px`);
    meta.push(page.run?.sample ? t('canvas.sourceSample') : t('canvas.sourceLocal'));
    meta.push(page.calibration ? t('canvas.calibrated') : t('canvas.calibrationRequired'));
    if (page.resolution?.action === 'upscaled') meta.push(t('canvas.upscaled'));
    if (page.resolution?.action === 'downscaled') meta.push(t('canvas.downscaled'));
  }
  $('#page-meta').textContent = page ? meta.join(' · ') : t('canvas.importOrSample');
  const chip = $('#calibration-chip');
  chip.hidden = !page;
  if (page) {
    const c = page.calibration;
    chip.dataset.state = !c ? 'missing' : c.adequate === false ? 'warn' : 'ok';
    chip.textContent = c ? cal.describe(c) + (c.adequate === false ? ' · ' + t('chip.qc') : '') : t('chip.none');
  }
  $('#calibrate-open').disabled = !page;
  const busy = page?.job && ['queued', 'running'].includes(page.job.state);
  const usable = serviceUsable(false);
  $('#measure-run').disabled = !page || busy || !usable || Boolean(state.batch);
  $('#measure-run').textContent = page?.run ? t('action.remeasure') : t('action.measure');
  $('#measure-run').title = usable ? '' : t('error.service');
  const used = page?.run?.periods, now = cal.servicePeriods(page?.calibration);
  $('#stale-notice').hidden = !(used && now && (Math.abs(used.x - now.x_period_px) > 1e-6 * used.x || Math.abs(used.y - now.y_period_px) > 1e-6 * used.y));
  renderJob();
}

function renderJob() {
  const page = current();
  const job = page?.job;
  const active = job && ['queued', 'running'].includes(job.state);
  $('#job-strip').hidden = !active;
  if (!active) return;
  $('#job-bar').style.width = `${Math.round((job.progress ?? 0) * 100)}%`;
  $('#job-text').textContent = t(`job.stage.${job.stage ?? 'queued'}`, {done: job.tiles?.done ?? 0, total: job.tiles?.total ?? 0});
  $('#job-tiles').textContent = job.tiles?.total ? t('job.tiles', {done: job.tiles.done, total: job.tiles.total, n: state.live?.evidence.length ?? 0}) : '';
  $('#job-cancel').disabled = !job.controller || job.controller.signal.aborted;
}

function renderSteps() {
  const page = current();
  const total = page?.spikelets.length ?? 0;
  const confirmed = page?.spikelets.filter(s => statusOf(s, page) === STATUS.confirmed).length ?? 0;
  const done = {
    import: Boolean(page),
    calibrate: cal.isValid(page?.calibration),
    measure: Boolean(page?.run || total),
    review: total > 0 && confirmed === total,
    export: Boolean(page?.exportedAt)
  };
  const order = ['import', 'calibrate', 'measure', 'review', 'export'];
  const firstOpen = order.find(k => !done[k]);
  const reachable = {import: true, calibrate: Boolean(page), measure: Boolean(page), review: total > 0, export: state.pages.some(p => p.spikelets.length)};
  for (const li of $$('#steps li')) {
    li.dataset.state = done[li.dataset.step] ? 'done' : li.dataset.step === firstOpen ? 'current' : 'todo';
    li.querySelector('button').disabled = !reachable[li.dataset.step];
  }
}

// Segmented controls: the shared indicator slides to the selected option.
function moveSlider(container, button) {
  const slider = container.querySelector('.slider');
  if (!button || !slider) return;
  slider.style.width = `${button.offsetWidth}px`;
  slider.style.transform = `translateX(${button.offsetLeft}px)`;
}

function renderLayerSwitch() {
  const page = current();
  const switcher = $('#layer-switch');
  const live = Boolean(state.live && state.live.pageId === page?.id);
  switcher.hidden = !page || (!page.run && !live) || sourcePreview();
  const counts = page ? layerCounts(page) : {};
  const shown = live ? 'evidence' : state.displayLayer;
  for (const button of $$('[data-layer-view]')) {
    const key = button.dataset.layerView;
    button.setAttribute('aria-selected', String(key === shown));
    button.disabled = live || (key !== 'edits' && !counts[key]);
    $(`#count-${key}`).textContent = live && key === 'evidence' ? state.live.evidence.length : counts[key] || '';
  }
  moveSlider(switcher, switcher.querySelector('[aria-selected="true"]'));
  $('#growth-legend').hidden = !page || shown !== 'growth' || sourcePreview();
  $('#layer-note').textContent = page && (page.run || live) && !sourcePreview() ? t(`layer.note.${live ? 'live' : shown}`) : '';
}

function renderMode() {
  const switcher = $('.mode-switch');
  for (const button of $$('[data-mode]')) button.setAttribute('aria-selected', String(button.dataset.mode === state.mode));
  for (const body of $$('[data-body]')) body.hidden = body.dataset.body !== state.mode;
  moveSlider(switcher, switcher.querySelector('[aria-selected="true"]'));
}

function setMode(mode) {
  state.mode = mode;
  if (mode === 'inspect') {
    if (!['select', 'ruler'].includes(state.tool)) setTool('select');
    state.selectedNodes = [];
  }
  renderMode();
  renderPanels();
  renderLayerSwitch();
  viewer.render();
}

function setDisplayLayer(layer) {
  state.displayLayer = layer;
  state.selectedNodes = [];
  if (layer !== 'edits' && ['awn', 'spikelet', 'box'].includes(state.tool)) setTool('select');
  renderLayerSwitch();
  renderPanels();
  viewer.render();
}

function renderResults() {
  const page = current();
  const all = page?.spikelets ?? [];
  const statuses = all.map(s => statusOf(s, page));
  const lengths = all.map(s => lengthOf(s, page)).filter(v => v !== null);
  const stats = summarize(lengths);
  $('#stats').hidden = !all.length;
  $('#summary').replaceChildren(...[
    [all.length, 'summary.spikelets'],
    [stats.n, 'summary.measured'],
    [stats.sd === null ? fmt(stats.mean) : `${fmt(stats.mean, 1)}±${fmt(stats.sd, 1)}`, 'summary.mean'],
    [fmt(stats.median, 1), 'summary.median']
  ].map(([value, label]) => {
    const div = document.createElement('div');
    div.append(Object.assign(document.createElement('b'), {textContent: value}), Object.assign(document.createElement('span'), {textContent: t(label)}));
    return div;
  }));
  renderReviewProgress(statuses);
  renderHistogram(lengths);
  for (const b of $$('#filters [data-filter]')) {
    const test = FILTERS[b.dataset.filter];
    b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter));
    b.textContent = t(`filter.${b.dataset.filter}`);
    b.append(Object.assign(document.createElement('small'), {textContent: ` ${statuses.filter(test).length}`}));
  }
  const rows = visibleSpikelets(page);
  const options = reviewOptions(page);
  $('#rows').replaceChildren(...rows.map(s => {
    const tr = document.createElement('tr');
    tr.dataset.uid = s.uid;
    tr.tabIndex = 0;
    tr.setAttribute('aria-selected', String(state.selected.has(s.uid)));
    const status = statusOf(s, page);
    const badge = Object.assign(document.createElement('span'), {className: 'badge', textContent: t(`status.${status}`)});
    badge.dataset.status = status;
    if (status === STATUS.needsReview) {
      badge.dataset.severity = String(reviewSeverity(s, options).level);
      tr.title = reviewReasons(s, options).map(r => t(`reason.${r}`)).join(' · ');
      if (!seenReview.has(seenKey(page, s))) tr.classList.add('unseen');
    }
    const score = representative(s)?.score;
    const cells = [[s.name, 'id'], [fmt(lengthOf(s, page)), 'num length'], [fmt(score, 2), 'num score']]
      .map(([text, className]) => Object.assign(document.createElement('td'), {textContent: text, className}));
    cells[0].title = t('results.editIdHint');
    const statusCell = document.createElement('td');
    statusCell.append(badge);
    tr.append(...cells, statusCell);
    return tr;
  }));
  $('#no-rows').hidden = rows.length > 0 || !all.length;
  $('#confirm-visible').disabled = !rows.some(s => canConfirm(s) && statusOf(s, page) !== STATUS.confirmed);
  for (const b of $$('.sort')) {
    if (b.dataset.sort === state.sort.key) b.dataset.dir = state.sort.dir;
    else delete b.dataset.dir;
  }
}

const STATUS_COLORS = [STATUS.confirmed, STATUS.modified, STATUS.automatic, STATUS.needsReview, STATUS.missing];

function renderReviewProgress(statuses) {
  const bar = $('#review-progress');
  const n = statuses.length || 1;
  bar.replaceChildren(...STATUS_COLORS.map(status => {
    const count = statuses.filter(s => s === status).length;
    const i = document.createElement('i');
    i.style.width = `${(100 * count) / n}%`;
    i.style.background = `var(--st-${status})`;
    i.title = `${t(`status.${status}`)}: ${count}`;
    return i;
  }));
  bar.title = t('summary.confirmedOf', {done: statuses.filter(s => s === STATUS.confirmed).length, n: statuses.length});
}

function renderHistogram(lengths) {
  const svg = $('#histogram');
  const bins = histogram(lengths);
  const max = Math.max(1, ...bins.map(b => b.count));
  const W = 300, H = 64, gap = 2;
  const w = bins.length ? W / bins.length : W;
  const ns = 'http://www.w3.org/2000/svg';
  const range = state.lengthRange;
  svg.replaceChildren(...bins.map((b, i) => {
    const rect = document.createElementNS(ns, 'rect');
    const h = (b.count / max) * (H - 4);
    rect.setAttribute('x', String(i * w + gap / 2));
    rect.setAttribute('y', String(H - h));
    rect.setAttribute('width', String(Math.max(1, w - gap)));
    rect.setAttribute('height', String(Math.max(b.count ? 1.5 : 0, h)));
    rect.setAttribute('rx', '1.5');
    if (range && range[0] === b.x0 && range[1] === b.x1) rect.classList.add('selected');
    const title = document.createElementNS(ns, 'title');
    title.textContent = t('summary.bin', {x0: +b.x0.toFixed(2), x1: +b.x1.toFixed(2), n: b.count});
    rect.append(title);
    rect.addEventListener('click', () => {
      state.lengthRange = range && range[0] === b.x0 ? null : [b.x0, b.x1];
      renderResults();
    });
    return rect;
  }));
  svg.setAttribute('aria-label', t('summary.histogram'));
  const axis = $('#hist-axis');
  axis.replaceChildren();
  if (bins.length) {
    const left = Object.assign(document.createElement('span'), {textContent: `${+bins[0].x0.toFixed(2)} mm`});
    const mid = document.createElement('span');
    if (range) {
      mid.textContent = t('summary.range', {x0: +range[0].toFixed(2), x1: +range[1].toFixed(2)}) + ' ';
      const clear = Object.assign(document.createElement('button'), {className: 'link small', type: 'button', textContent: t('summary.clearRange')});
      clear.onclick = () => { state.lengthRange = null; renderResults(); };
      mid.append(clear);
    }
    const right = Object.assign(document.createElement('span'), {textContent: `${+bins.at(-1).x1.toFixed(2)} mm`});
    axis.append(left, mid, right);
  }
}

function renderDetail() {
  const page = current();
  const s = primary();
  const detail = $('#detail');
  detail.hidden = !s;
  if (!s) return;
  const multi = state.selected.size > 1;
  const status = statusOf(s, page);
  const name = $('#detail-name');
  if (document.activeElement !== name) name.value = s.name;
  name.removeAttribute('aria-invalid');
  name.disabled = !editable();
  $('#detail-length').textContent = fmt(lengthOf(s, page));
  const badge = $('#detail-status');
  badge.dataset.status = status;
  badge.textContent = multi ? t('detail.multi', {n: state.selected.size}) : t(`status.${status}`);
  $('#detail-origin').textContent = t(s.origin === 'manual' ? 'origin.manual' : s.modified ? 'origin.edited' : 'origin.auto');
  $('#detail-reasons').replaceChildren(...reviewReasons(s, reviewOptions(page)).map(r => Object.assign(document.createElement('li'), {textContent: t(`reason.${r}`)})));
  $('#detail-confirm').textContent = s.confirmed && !multi ? t('detail.unconfirm') : t('detail.confirm');
  $('#detail-confirm').disabled = !canConfirm(s);
  const canEdit = editable();
  $('#detail-redraw').disabled = !canEdit;
  $('#detail-reset').disabled = !canEdit || s.origin !== 'auto' || (!s.modified && !s.confirmed);
  $('#detail-delete').disabled = !canEdit;
  $('#detail-delete-awn').disabled = !canEdit || s.line.length < 2;
}

function renderInspect() {
  const page = current();
  const s = primary();
  const k = s ? state.inspectCandidate ?? s.rep ?? 0 : null;
  const candidate = s?.candidates[k] ?? null;
  $('#inspect-empty').hidden = Boolean(candidate);
  $('#inspect-empty').textContent = s ? t('inspect.unavailable') : t('inspect.empty');
  $('#inspect').hidden = !candidate;
  renderRunInfo(page);
  if (!candidate) return;
  const steps = inspectionSteps(candidate);
  const max = steps.length - 1;
  if (state.inspectStep > max) state.inspectStep = max;
  const stepIndex = state.inspectStep;
  const stepData = steps[stepIndex];
  $('#inspect-title').textContent = `${t('col.id')} ${s.name}` + (s.candidates.length > 1 ? ` · ${t('detail.candidate', {k: k + 1, n: s.candidates.length})}` : '');
  const stageLabel = stepData.kind === 'seed' ? t('inspect.stage.seed')
    : stepData.kind === 'hop' ? t('inspect.stage.hop', {current: stepData.hop, total: steps.filter(st => st.kind === 'hop').length})
      : t('inspect.stage.final');
  $('#inspect-stage-badge').textContent = stageLabel;
  $('#inspect-step-label').textContent = stageLabel;
  fillFacts($('#inspect-summary'), [
    ['inspect.pRoot', fmt(candidate.growth?.p_root ?? candidate.meta?.p_root, 3)],
    ['inspect.hops', steps.filter(st => st.kind === 'hop').length],
    ['inspect.gaps', steps.filter(st => st.gap).length],
    ['inspect.currentLength', `${fmt(cal.lengthMm(candidate.path, page.calibration))} mm`],
    ['inspect.candidateCount', s.candidates.length]
  ]);
  const slider = $('#inspect-slider');
  slider.max = String(max);
  slider.value = String(stepIndex);
  slider.disabled = max === 0;
  $('#inspect-back').disabled = stepIndex <= 0;
  $('#inspect-forward').disabled = stepIndex >= max;
  const detail = stepData.kind === 'seed'
    ? [['inspect.detail.rootProbability', fmt(stepData.pRoot, 3)], ['inspect.detail.segment', `${fmt(stepData.lengthMm)} mm`]]
    : stepData.kind === 'hop'
      ? [['inspect.detail.segment', `${fmt(stepData.lengthMm)} mm`], ['inspect.detail.join', stepData.gap ? t('inspect.gapJoin') : t('inspect.junctionJoin')], ['inspect.detail.grown', `${fmt(grownLength(steps, stepIndex))} mm`]]
      : [['inspect.score', fmt(stepData.score, 3)], ['inspect.serviceLength', fmt(stepData.serviceMm, 3)], ['inspect.currentLength', fmt(cal.lengthMm(stepData.path, page.calibration), 3)],
        ['inspect.detail.kind', stepData.alternative ? t('inspect.alternative') : k === s.rep ? t('inspect.representative') : t('inspect.branch')]];
  fillFacts($('#inspect-step-detail'), detail);
  $('#inspect-pool').checked = settings.showPool;
  $('#inspect-candidates').replaceChildren(...s.candidates.map((c, i) => {
    const tr = document.createElement('tr');
    tr.setAttribute('aria-current', String(i === s.rep));
    tr.setAttribute('aria-selected', String(i === k));
    tr.append(...[i + 1 + (c.alternative ? '*' : ''), fmt(cal.lengthMm(c.path, page.calibration)), fmt(c.score, 3), c.meta?.hops ?? '—', c.meta?.gaps ?? '—']
      .map((v, j) => Object.assign(document.createElement('td'), {textContent: v, className: j ? 'num' : ''})));
    tr.addEventListener('click', () => {
      state.inspectCandidate = i;
      state.candidateCursor.set(s.uid, i);
      state.inspectStep = Infinity;
      renderPanels();
      viewer.render();
    });
    return tr;
  }));
}

function renderRunInfo(page) {
  const run = page?.run;
  $('#run-info').hidden = !run;
  if (!run) return;
  const qc = run.qc;
  fillFacts($('#inspect-run'), [
    ['inspect.method', run.method ?? '—'],
    ['inspect.model', run.model ?? '—'],
    ['inspect.elapsed', run.elapsedS ? `${run.elapsedS.toFixed(1)} s` : '—'],
    ['inspect.measuredAt', page.measuredAt ? new Date(page.measuredAt).toLocaleString() : '—'],
    ['inspect.periods', run.periods ? `${run.periods.x.toFixed(2)} × ${run.periods.y.toFixed(2)}` : '—'],
    ['inspect.qc', !qc ? '—' : qc.adequate ? t('inspect.qcOk') : (qc.qc_reasons ?? []).join(', ') || t('inspect.none')]
  ]);
  const entries = Object.entries(page.layers?.timings ?? {});
  $('#timing-panel').hidden = !settings.showDiagnostics || !entries.length;
  const total = entries.reduce((sum, [, v]) => sum + v, 0) || 1;
  $('#timing-bars').replaceChildren(...entries.map(([key, value]) => {
    const row = document.createElement('div');
    row.className = 'timing-row';
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.append(Object.assign(document.createElement('i'), {style: `width: ${(100 * value) / total}%`}));
    row.append(Object.assign(document.createElement('span'), {textContent: t(`timing.${key}`)}), bar,
      Object.assign(document.createElement('span'), {className: 'mono', textContent: `${value.toFixed(2)} s`}));
    return row;
  }));
}

function fillFacts(dl, facts) {
  dl.replaceChildren(...facts.flatMap(([key, value]) => [
    Object.assign(document.createElement('dt'), {textContent: t(key)}),
    Object.assign(document.createElement('dd'), {textContent: String(value)})
  ]));
}

function setInspectStep(value) {
  if (!primary()) return;
  state.inspectStep = Math.max(0, Number(value) || 0);
  renderInspect();
  viewer.render();
}

// Inline ID editing in the results table.
function beginIdEdit(cell, s) {
  if (cell.querySelector('input') || !editable()) return;
  const original = s.name;
  const input = Object.assign(document.createElement('input'), {className: 'id-input', value: original, maxLength: 80});
  let settled = false;
  const finish = save => {
    if (settled) return;
    settled = true;
    const value = input.value.trim();
    if (!save || value === original) {
      cell.textContent = original;
      return;
    }
    if (!validName(value, current().spikelets, s.uid)) {
      toast(t('detail.nameTaken'), 'error');
      cell.textContent = original;
      return;
    }
    edit(page => { spikeletByUid(page, s.uid).name = value; });
  };
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      settled = true;
      cell.textContent = original;
    }
  });
  input.addEventListener('blur', () => finish(true));
  cell.replaceChildren(input);
  input.focus();
  input.select();
}

// ---------------------------------------------------------------- settings and theme

function applyTheme() {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  viewer?.render();
}

function applyLanguage() {
  setLocale(settings.language);
  applyTranslations();
  renderService();
  renderSaveState();
  renderDrawBar();
  renderModels();
  renderAll();
}

function applyLayout() {
  const root = document.documentElement.style;
  root.setProperty('--sidebar-w', `${settings.layout.sidebar}px`);
  root.setProperty('--panel-w', `${settings.layout.panel}px`);
}

function persistSettings() {
  saveSettings(settings);
}

function openSettings(section = 'input') {
  const form = $('#settings-form');
  for (const el of form.elements) {
    if (!el.name || !(el.name in settings)) continue;
    if (el.type === 'checkbox') el.checked = settings[el.name];
    else el.value = settings[el.name];
  }
  showSettingsSection(section);
  $('#settings-dialog').showModal();
}

function showSettingsSection(section) {
  for (const b of $$('[data-section]')) b.setAttribute('aria-pressed', String(b.dataset.section === section));
  for (const panel of $$('[data-panel]')) panel.hidden = panel.dataset.panel !== section;
}

function openHelp() {
  $('#shortcut-list').replaceChildren(...SHORTCUTS.map(({keys, label}) => {
    const row = document.createElement('div');
    const name = Object.assign(document.createElement('span'), {textContent: t(label)});
    const combo = document.createElement('span');
    keys.forEach((k, i) => {
      if (i) combo.append(' ');
      combo.append(Object.assign(document.createElement('kbd'), {textContent: k}));
    });
    row.append(name, combo);
    return row;
  }));
  $('#help-dialog').showModal();
}

// ---------------------------------------------------------------- event wiring

function wire() {
  const openImport = () => $('#import-dialog').showModal();
  $('#import-open').onclick = $('#empty-import').onclick = openImport;
  $('#choose-files').onclick = () => $('#file-input').click();
  $('#choose-folder').onclick = () => $('#folder-input').click();
  $('#dropzone').onclick = () => $('#file-input').click();
  $('#dropzone').onkeydown = e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      $('#file-input').click();
    }
  };
  for (const id of ['#file-input', '#folder-input']) {
    $(id).onchange = e => { importFiles(e.target.files); e.target.value = ''; };
  }
  const hasFiles = e => [...(e.dataTransfer?.types ?? [])].includes('Files');
  for (const zone of [$('#dropzone'), $('#canvas-wrap')]) {
    zone.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      zone.classList.remove('dragover');
      importFiles(e.dataTransfer.files);
    });
  }
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', e => { if (hasFiles(e)) e.preventDefault(); });

  $('#select-all-images').onchange = e => {
    state.checkedPages = new Set(e.target.checked ? state.pages.map(p => p.id) : []);
    renderImageList();
  };
  $('#delete-images').onclick = () => deletePages([...state.checkedPages]);
  $('#measure-pending').onclick = () => runBatch();
  $('#batch-stop').onclick = () => {
    if (state.batch) state.batch.stop = true;
    setModelStatus(t('batch.stopping'));
    renderBatch();
  };
  $('#samples-open').onclick = $('#empty-sample').onclick = openSamples;
  $('#service-retry').onclick = () => { state.models = []; checkService(); };
  $('#help-open').onclick = openHelp;
  $('#job-cancel').onclick = () => {
    current()?.job?.controller?.abort();
    renderJob();
  };
  $('#zoom-in').onclick = () => viewer.zoomBy(1.25);
  $('#zoom-out').onclick = () => viewer.zoomBy(0.8);
  $('#zoom-level').onclick = () => viewer.fit({animate: true});

  const stepActions = {
    import: openImport,
    calibrate: () => { state.rulerLine = null; openCalibration(); },
    measure: () => current() && measure(current()),
    review: () => {
      state.filter = 'needs_review';
      setDisplayLayer('edits');
      setMode('measure');
      renderResults();
      const first = visibleSpikelets()[0];
      if (first) select(first.uid, {focus: true});
    },
    export: openExport
  };
  for (const li of $$('#steps li')) li.querySelector('button').onclick = () => stepActions[li.dataset.step]();

  $('#measure-run').onclick = () => current() && measure(current());
  $('#calibrate-open').onclick = () => { state.rulerLine = null; openCalibration(); };
  $('#calibration-chip').onclick = () => { state.rulerLine = null; openCalibration(current()?.calibration ? 'ratio' : 'grid'); };
  for (const input of $$('[name="cal-mode"]')) input.onchange = () => setCalMode(input.value);
  $('#cal-grid').onclick = async () => {
    const button = $('#cal-grid');
    button.disabled = true;
    button.textContent = t('cal.detecting');
    $('#cal-grid-result').textContent = t('cal.detectingGrid');
    try {
      const result = await api().calibrate(current().blob);
      applyCalibration(cal.fromGrid(result));
    } catch (error) {
      $('#cal-grid-result').textContent = '';
      $('#cal-error').textContent = t('error.calibrate', {error: error.message});
    } finally {
      button.disabled = false;
      button.textContent = t('cal.detect');
    }
  };
  $('#cal-draw').onclick = () => {
    $('#calibration-dialog').close('draw');
    setTool('ruler');
  };
  $('#cal-apply-two').onclick = () => {
    const page = current();
    const line = state.rulerLine ?? (page.calibration?.method === 'two_point' ? page.calibration.points : null);
    const value = Number($('#cal-mm').value) * Number($('#cal-unit').value);
    if (!line) return void ($('#cal-error').textContent = t('cal.needLine'));
    if (!(value > 0)) return void ($('#cal-error').textContent = t('cal.invalid'));
    applyCalibration(cal.fromTwoPoints(line, value));
  };
  $('#cal-apply-ratio').onclick = () => {
    const value = Number($('#cal-ratio').value);
    if (!(value > 0)) return void ($('#cal-error').textContent = t('cal.invalid'));
    applyCalibration(cal.fromRatio(value));
  };
  $('#calibration-dialog').addEventListener('close', () => {
    const reason = $('#calibration-dialog').returnValue;
    if (state.tool !== 'ruler') state.rulerLine = null;
    if (reason !== 'draw' && reason !== 'applied') state.calContinuation = null;
    viewer.render();
  });

  for (const b of $$('[data-tool]')) b.onclick = () => setTool(b.dataset.tool);
  $('#undo').onclick = undo;
  $('#redo').onclick = redo;
  $('#focus').onclick = () => focusSelection();
  $('#delete-selection').onclick = deleteSelected;
  $('#source-preview').onclick = () => {
    state.sourcePinned = !state.sourcePinned;
    renderPanels();
    renderLayerSwitch();
    viewer.render();
  };
  $('#background-toggle').onclick = () => {
    state.photoHidden = !state.photoHidden;
    renderPanels();
    viewer.render();
  };
  $('#draw-finish').onclick = finishDraft;
  $('#draw-cancel').onclick = () => setTool('select');
  for (const b of $$('[data-layer-view]')) b.onclick = () => setDisplayLayer(b.dataset.layerView);
  for (const b of $$('[data-mode]')) b.onclick = () => setMode(b.dataset.mode);
  $('#floating-confirm').onclick = () => $('#detail-confirm').click();

  for (const input of $$('[data-layer]')) {
    input.checked = Boolean(settings.layers[input.dataset.layer]);
    input.onchange = () => {
      settings.layers[input.dataset.layer] = input.checked;
      persistSettings();
      viewer.render();
    };
  }
  const threshold = $('#threshold');
  threshold.value = state.threshold;
  $('#threshold-value').textContent = state.threshold.toFixed(2);
  threshold.oninput = () => {
    state.threshold = Number(threshold.value);
    $('#threshold-value').textContent = state.threshold.toFixed(2);
    renderAll();
  };

  for (const b of $$('[data-filter]')) b.onclick = () => { state.filter = b.dataset.filter; renderResults(); };
  $('#search').oninput = e => { state.search = e.target.value; renderResults(); };
  $('#rows').onclick = e => {
    const tr = e.target.closest('tr[data-uid]');
    if (!tr || e.target.closest('input')) return;
    select(tr.dataset.uid, {additive: e.ctrlKey || e.metaKey, reveal: false, focus: settings.autoFocus});
  };
  $('#rows').ondblclick = e => {
    const cell = e.target.closest('td.id');
    const tr = e.target.closest('tr[data-uid]');
    if (!cell || !tr) return;
    const s = spikeletByUid(current(), tr.dataset.uid);
    if (s) beginIdEdit(cell, s);
  };
  $('#rows').onkeydown = e => {
    const tr = e.target.closest('tr[data-uid]');
    if (tr && e.key === 'Enter' && !e.target.closest('input')) {
      e.preventDefault();
      e.stopPropagation();
      select(tr.dataset.uid, {focus: settings.autoFocus});
    }
  };
  $('#rows').addEventListener('pointerover', e => {
    const id = e.target.closest('tr[data-uid]')?.dataset.uid ?? null;
    if (id === state.rowHover) return;
    state.rowHover = id;
    viewer.render();
  });
  $('#rows').addEventListener('pointerleave', () => {
    state.rowHover = null;
    viewer.render();
  });
  for (const b of $$('.sort')) {
    b.onclick = () => {
      const key = b.dataset.sort;
      state.sort = {key, dir: state.sort.key === key && state.sort.dir === 'asc' ? 'desc' : 'asc'};
      renderResults();
    };
  }
  $('#confirm-visible').onclick = () => confirmSpikelets(visibleSpikelets().filter(s => statusOf(s) !== STATUS.confirmed));

  const name = $('#detail-name');
  name.onchange = () => {
    const page = current();
    const s = primary();
    if (!s) return;
    if (!validName(name.value, page.spikelets, s.uid)) {
      name.setAttribute('aria-invalid', 'true');
      toast(t('detail.nameTaken'), 'error');
      return;
    }
    edit(p => { spikeletByUid(p, s.uid).name = name.value.trim(); });
  };
  name.onkeydown = e => { if (e.key === 'Enter') name.blur(); };
  $('#detail-confirm').onclick = () => {
    const page = current();
    const chosen = page.spikelets.filter(s => state.selected.has(s.uid));
    const unconfirm = chosen.length === 1 && chosen[0].confirmed;
    confirmSpikelets(chosen, !unconfirm);
  };
  $('#detail-redraw').onclick = () => setTool('awn');
  $('#detail-reset').onclick = () => edit(page => edits.restoreAutomatic(spikeletByUid(page, state.primaryUid)));
  $('#detail-delete').onclick = deleteSelected;
  $('#detail-delete-awn').onclick = deleteAwn;

  const moveCandidate = delta => {
    const s = primary();
    if (!s?.candidates.length) return;
    const n = s.candidates.length;
    const k = state.candidateCursor.get(s.uid) ?? s.rep ?? 0;
    const next = (k + delta + n) % n;
    state.candidateCursor.set(s.uid, next);
    state.inspectCandidate = next;
    state.inspectStep = Infinity;
    renderPanels();
    viewer.render();
  };
  $('#cand-prev').onclick = () => moveCandidate(-1);
  $('#cand-next').onclick = () => moveCandidate(1);
  $('#cand-use').onclick = () => {
    const s = primary();
    if (!s) return;
    const k = state.candidateCursor.get(s.uid) ?? s.rep;
    if (k === null || k === undefined || k === s.rep) return;
    edit(page => edits.useCandidate(spikeletByUid(page, s.uid), k));
    toast(t('detail.candidatePromoted', {k: k + 1}), 'info', undoAction());
  };

  $('#inspect-slider').oninput = e => setInspectStep(e.target.value);
  $('#inspect-back').onclick = () => setInspectStep(state.inspectStep - 1);
  $('#inspect-forward').onclick = () => setInspectStep(state.inspectStep + 1);
  $('#inspect-pool').onchange = e => {
    settings.showPool = e.target.checked;
    persistSettings();
    viewer.render();
  };
  $('#inspect-focus').onclick = () => focusSelection();

  $('#open-project').onclick = () => $('#project-input').click();
  $('#project-input').onchange = e => {
    if (e.target.files[0]) openProject(e.target.files[0]);
    e.target.value = '';
  };
  $('#save-project').onclick = saveProject;
  $('#export-open').onclick = openExport;
  $('#export-current').onclick = () => {
    const page = current();
    if (!cal.isValid(page.calibration)) return toast(t('export.calibrateCurrent'), 'error');
    download(csvName(page), simpleCsv(page), 'text/csv;charset=utf-8');
    markExported([page]);
  };
  $('#export-all').onclick = () => {
    const pages = exportablePages(state.pages);
    if (pages.some(p => !cal.isValid(p.calibration))) return toast(t('export.calibrateBatch'), 'error');
    const used = new Set();
    download('awnstudio-results.zip', new Blob([zip(pages.map(p => ({name: csvName(p, used), content: simpleCsv(p)})))], {type: 'application/zip'}));
    markExported(pages);
  };
  $('#export-detailed').onclick = () => {
    download('awnstudio-detailed-results.csv', detailedCsv(state.pages, {threshold: state.threshold}), 'text/csv;charset=utf-8');
    markExported(exportablePages(state.pages));
  };
  $('#export-stats').onclick = () => {
    download('awnstudio-summary.csv', summaryCsv(state.pages, {threshold: state.threshold}), 'text/csv;charset=utf-8');
  };

  const form = $('#settings-form');
  $('#settings-open').onclick = () => openSettings();
  for (const b of $$('[data-section]')) b.onclick = () => showSettingsSection(b.dataset.section);
  form.onchange = e => {
    const el = e.target;
    if (!el.name || !(el.name in settings)) return;
    settings[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    if (el.name === 'threshold' && settings.threshold >= 0 && settings.threshold <= 1) {
      state.threshold = settings.threshold;
      $('#threshold').value = state.threshold;
      $('#threshold-value').textContent = state.threshold.toFixed(2);
    }
    if (el.name === 'rememberLayout' && !settings.rememberLayout) {
      settings.layout = structuredClone(DEFAULTS.layout);
      applyLayout();
    }
    persistSettings();
    if (el.name === 'language') applyLanguage();
    if (el.name === 'theme') applyTheme();
    if (el.name === 'serviceBase') { state.models = []; checkService(); }
    renderAll();
  };
  $('#clear-workspace').onclick = async () => {
    $('#settings-dialog').close();
    await clearWorkspace(true);
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  for (const handle of $$('[data-resize]')) {
    const key = handle.dataset.resize;
    const setWidth = width => {
      settings.layout[key] = Math.round(Math.min(key === 'sidebar' ? 420 : 520, Math.max(key === 'sidebar' ? 180 : 260, width)));
      applyLayout();
      viewer.render();
      renderLayerSwitch();
      renderMode();
    };
    handle.addEventListener('pointerdown', down => {
      const start = settings.layout[key];
      handle.setPointerCapture(down.pointerId);
      const move = e => setWidth(start + (key === 'sidebar' ? 1 : -1) * (e.clientX - down.clientX));
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', () => {
        handle.removeEventListener('pointermove', move);
        if (settings.rememberLayout) persistSettings();
      }, {once: true});
    });
    handle.addEventListener('dblclick', () => {
      setWidth(DEFAULTS.layout[key]);
      if (settings.rememberLayout) persistSettings();
    });
    handle.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      const direction = e.key === 'ArrowRight' ? 1 : -1;
      setWidth(settings.layout[key] + (key === 'sidebar' ? direction : -direction) * 10);
      if (settings.rememberLayout) persistSettings();
    });
  }

  window.addEventListener('keydown', onKey);
  // Drawing completion goes before focused buttons or rows can consume Enter.
  window.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing || !['awn', 'spikelet'].includes(state.tool) || $('dialog[open]')) return;
    if (e.target.matches?.('textarea, input:not([type="range"]), select')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.repeat) finishDraft();
  }, true);
  window.addEventListener('keyup', e => {
    if (e.key === 'Control' && state.ctrlHeld) {
      state.ctrlHeld = false;
      renderPanels();
      renderLayerSwitch();
      viewer.render();
    }
  });
  window.addEventListener('blur', () => {
    if (!state.ctrlHeld) return;
    state.ctrlHeld = false;
    renderPanels();
    renderLayerSwitch();
    viewer.render();
  });
  window.addEventListener('pagehide', () => { autosave.flush(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autosave.flush();
  });
  window.addEventListener('beforeunload', e => {
    if (saveState === 'dirty' || saveState === 'saving') {
      autosave.flush();
      e.preventDefault();
      e.returnValue = '';
    }
  });
  window.addEventListener('resize', () => {
    renderLayerSwitch();
    renderMode();
  });
}

function onKey(e) {
  const target = e.target;
  if (target.closest?.('input, select, textarea, dialog[open]')) return;
  if (e.key === 'Control' && !e.repeat && current()) {
    state.ctrlHeld = true;
    renderPanels();
    renderLayerSwitch();
    viewer.render();
    return;
  }
  if (e.key === '?') {
    e.preventDefault();
    openHelp();
    return;
  }
  if (!current()) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (ctrl && key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (ctrl && key === 'y') { e.preventDefault(); redo(); return; }
  if (ctrl) return;
  if (state.mode === 'inspect' && (key === 'arrowleft' || key === 'arrowright')) {
    e.preventDefault();
    setInspectStep(state.inspectStep + (key === 'arrowright' ? 1 : -1));
    return;
  }
  const layerKeys = {1: 'evidence', 2: 'growth', 3: 'candidates', 4: 'edits'};
  if (key in layerKeys) {
    const layer = layerKeys[key];
    if (current().run && (layer === 'edits' || layerCounts(current())[layer])) {
      e.preventDefault();
      setDisplayLayer(layer);
    }
    return;
  }
  const actions = {
    v: () => setTool('select'),
    h: () => setTool('select'),
    b: () => setTool('box'),
    n: () => setTool('spikelet'),
    p: () => setTool('spikelet'),
    a: () => setTool('awn'),
    l: () => setTool('awn'),
    r: () => setTool('ruler'),
    f: () => focusSelection(),
    0: () => viewer.fit({animate: true}),
    '=': () => viewer.zoomBy(1.25),
    '+': () => viewer.zoomBy(1.25),
    '-': () => viewer.zoomBy(0.8),
    c: () => $('#detail-confirm').click(),
    j: () => step(1),
    k: () => step(-1),
    arrowdown: () => step(1),
    arrowup: () => step(-1),
    ',': () => $('#cand-prev').click(),
    '.': () => $('#cand-next').click(),
    u: () => $('#cand-use').click(),
    escape: () => {
      if (state.tool !== 'select') setTool('select');
      else {
        clearSelection();
        renderPanels();
        viewer.render();
      }
    },
    enter: () => (state.draft ? finishDraft() : state.primaryUid ? $('#detail-confirm').click() : null),
    delete: () => (state.draft ? undoDraftPoint() : deleteSelected()),
    backspace: () => (state.draft ? undoDraftPoint() : deleteSelected())
  };
  const action = actions[key];
  if (action) {
    e.preventDefault();
    action();
  }
}

// ---------------------------------------------------------------- start

applyIcons(document);
applyLayout();
applyTheme();
wire();
applyLanguage();
setTool('select');
checkService();
setInterval(checkService, 15000);
document.body.classList.add('enter');
setTimeout(() => document.body.classList.remove('enter'), 900);
for (const el of $$('.layer-switch, .mode-switch')) {
  el.classList.add('no-anim');
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('no-anim')));
}
restore();

// Exposed for debugging in the browser console only.
window.awnstudio = {state, settings, current, viewer};

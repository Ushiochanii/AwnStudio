// AwnStudio workbench: wires state, viewer, service and panels together.

import {createApi} from './api.mjs';
import * as cal from './calibration.mjs';
import * as edits from './edits.mjs';
import {csvName, detailedCsv, exportablePages, simpleCsv, summaryCsv, zip} from './export.mjs';
import {bounds, distance, polygonArea, unionBounds} from './geometry.mjs';
import {createHistory} from './history.mjs';
import {applyTranslations, guessLocale, setLocale, t} from './i18n.mjs';
import {applyIcons} from './icons.mjs';
import {blobToDataUrl, buildProject, dataUrlToBlob, parseProject, serializePage} from './project.mjs';
import {calibrationFromResult, newManualSpikelet, representative, runInfo, spikeletsFromResult, validName} from './result.mjs';
import {canConfirm, FILTERS, reviewReasons, reviewStatus, STATUS} from './review.mjs';
import {loadSettings, saveSettings} from './settings.mjs';
import {SHORTCUTS} from './shortcuts.mjs';
import {histogram, summarize} from './stats.mjs';
import * as store from './store.mjs';
import {createViewer} from './viewer.mjs';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const settings = loadSettings(localStorage, guessLocale(navigator.languages ?? [navigator.language]));
const state = {
  pages: [],
  currentId: null,
  selected: new Set(),
  primaryUid: null,
  tool: 'select',
  draft: null, // {kind: 'awn' | 'spikelet' | 'ruler', points, targetUid}
  rulerLine: null, // last drawn two-point calibration line
  threshold: settings.threshold,
  filter: 'all',
  search: '',
  sort: {key: 'name', dir: 'asc'},
  lengthRange: null, // [min, max) from a histogram bin
  rowHover: null,
  restored: false,
  tab: 'results',
  candidateCursor: new Map(),
  checkedPages: new Set(),
  service: {state: 'unknown', info: null},
  batch: null // {total, done, stop}
};
const histories = new Map();
const api = () => createApi({base: settings.serviceBase.replace(/\/$/, '')});
const autosave = store.createAutosave(record => store.putPage(record));

// ---------------------------------------------------------------- helpers

const current = () => state.pages.find(p => p.id === state.currentId) ?? null;
const spikeletByUid = (page, uid) => page?.spikelets.find(s => s.uid === uid) ?? null;
const primary = () => spikeletByUid(current(), state.primaryUid);
const reviewOptions = page => ({threshold: state.threshold, calibration: page?.calibration ?? null});
const statusOf = (s, page = current()) => reviewStatus(s, reviewOptions(page));
const lengthOf = (s, page = current()) => cal.lengthMm(s.line, page?.calibration);
const fmt = (value, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits));
const historyOf = page => {
  if (!histories.has(page.id)) histories.set(page.id, createHistory());
  return histories.get(page.id);
};
const snapshot = page => structuredClone({spikelets: page.spikelets.map(edits.persistable), calibration: page.calibration});
const MIN_SPIKELET_AREA_PX = 25;
const byName = new Intl.Collator(undefined, {numeric: true});
const uid = () => (crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2));

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
  toast.timer = setTimeout(() => el.classList.remove('show'), action ? 7000 : kind === 'error' ? 6000 : 2800);
}

const undoAction = () => ({label: t('action.undo'), run: undo});

function ask(text) {
  const dialog = $('#confirm-dialog');
  $('#confirm-text').textContent = text;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), {once: true}));
}

function download(name, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], {type});
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {href: url, download: name});
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ---------------------------------------------------------------- persistence

function record(page, order = state.pages.indexOf(page)) {
  return {
    id: page.id, name: page.name, width: page.width, height: page.height, blob: page.blob,
    calibration: page.calibration, run: page.run, measuredAt: page.measuredAt, exportedAt: page.exportedAt ?? null,
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
    const bitmap = await createImageBitmap(page.blob, {resizeWidth: 120, resizeQuality: 'medium'});
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    page.thumb = canvas.toDataURL('image/jpeg', 0.7);
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
  if (!settings.restore) return;
  try {
    const rows = (await store.loadPages()).sort((a, b) => a.order - b.order);
    const restored = [];
    for (const row of rows) if (!state.pages.some(p => p.id === row.id)) restored.push(await makeRuntimePage(row));
    // Pages imported while the autosave was loading stay after the restored ones.
    state.pages = [...restored, ...state.pages];
    if (!current() && state.pages.length) openPage(state.pages[0].id);
    else renderAll();
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
      reject(new Error('decode failed'));
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

async function importFiles(files) {
  const images = [...files].filter(f => /^image\/(jpeg|png|webp)$/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name));
  const added = [];
  for (const file of images) {
    try {
      const {width, height} = await readImageSize(file);
      const page = await makeRuntimePage({name: file.name, width, height, blob: file});
      state.pages.push(page);
      added.push(page);
      changed(page, {ui: false});
    } catch {
      toast(t('import.failed', {name: file.name}), 'error');
    }
  }
  if (!added.length) return;
  $('#import-dialog').close();
  if (!state.currentId || !current()) openPage(added[0].id);
  renderAll();
  toast(t('import.done', {n: added.length}));
  if (settings.autoCalibrate && serviceUsable(false)) {
    for (const page of added) if (!page.calibration) await detectGrid(page, {quiet: true});
  }
  if (settings.measureAfterImport && serviceUsable(false)) runBatch(added);
}

// ---------------------------------------------------------------- pages

function openPage(id) {
  autosave.flush();
  state.currentId = id;
  state.selected.clear();
  state.primaryUid = null;
  state.draft = null;
  state.rulerLine = null;
  state.lengthRange = null;
  setTool('select');
  const page = current();
  if (page) loadImage(page);
  viewer.resetFit();
  renderAll();
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
  changed(page);
}

function undo() {
  const page = current();
  if (!page) return;
  const snap = historyOf(page).undo(snapshot(page));
  if (snap) restoreSnapshot(page, snap);
}

function redo() {
  const page = current();
  if (!page) return;
  const snap = historyOf(page).redo(snapshot(page));
  if (snap) restoreSnapshot(page, snap);
}

function select(uidValue, {additive = false, reveal = true} = {}) {
  if (!additive) state.selected.clear();
  if (uidValue) {
    if (additive && state.selected.has(uidValue)) state.selected.delete(uidValue);
    else state.selected.add(uidValue);
  }
  state.primaryUid = uidValue && state.selected.has(uidValue) ? uidValue : [...state.selected].at(-1) ?? null;
  renderPanels();
  viewer.render();
  if (reveal) $(`#rows tr[data-uid="${CSS.escape(state.primaryUid ?? '')}"]`)?.scrollIntoView({block: 'nearest'});
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
  select(next.uid);
  focusSelection(true);
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
    if (next) {
      select(next.uid);
      focusSelection(true);
    }
  }
}

async function deleteSelected() {
  const page = current();
  const uids = [...state.selected];
  if (!page || !uids.length) return;
  edit(p => { p.spikelets = p.spikelets.filter(s => !state.selected.has(s.uid)); });
  select(null);
  toast(t('detail.deleted', {n: uids.length}), 'info', undoAction());
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
  const pad = Math.max(box.x1 - box.x0, box.y1 - box.y0) * 0.6 + 40;
  viewer.fitBox({x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad}, 0, {animate: true});
}

// ---------------------------------------------------------------- tools and drafts

function setTool(tool) {
  if (tool === 'awn' && !primary()) {
    toast(t('hint.needSelection'));
    tool = 'select';
  }
  state.tool = tool;
  state.draft = tool === 'select' ? null : {kind: tool, points: [], targetUid: state.primaryUid};
  $('#canvas-wrap').dataset.tool = tool;
  for (const b of $$('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  renderDrawBar();
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
  if (draft.kind === 'awn' && points.length >= 2) {
    const s = spikeletByUid(current(), draft.targetUid);
    if (s) edit(page => edits.setLine(spikeletByUid(page, s.uid), points));
    setTool('select');
    select(draft.targetUid);
  } else if (draft.kind === 'spikelet' && points.length >= 3) {
    if (polygonArea(points) < MIN_SPIKELET_AREA_PX) {
      toast(t('draw.tooSmall'), 'error');
      return;
    }
    let created = null;
    edit(page => {
      created = newManualSpikelet(page.spikelets, points);
      page.spikelets.push(created);
    });
    select(created.uid);
    setTool('awn');
  } else if (draft.kind === 'ruler' && points.length === 2) {
    state.rulerLine = points;
    setTool('select');
    openCalibration();
  } else {
    return;
  }
  renderDrawBar();
}

function renderDrawBar() {
  const draft = state.draft;
  $('#draw-bar').hidden = !draft || draft.kind === 'ruler';
  if (draft) $('#draw-text').textContent = t('draw.points', {n: draft.points.length});
  $('#hint').textContent = t(`hint.${state.tool}`);
}

// ---------------------------------------------------------------- viewer host

const viewer = createViewer($('#canvas'), {
  scene() {
    const page = current();
    return {
      page,
      image: page?.image ?? null,
      spikelets: page?.spikelets ?? [],
      selected: state.selected,
      primary: primary(),
      tool: state.tool,
      layers: settings.layers,
      threshold: state.threshold,
      draft: state.draft && state.draft.kind !== 'ruler' ? state.draft : null,
      ruler: state.draft?.kind === 'ruler' ? state.draft.points : state.rulerLine,
      showCandidatesOfSelected: true,
      hoverUid: state.rowHover,
      candidateCursor: s => (s.uid === state.primaryUid ? state.candidateCursor.get(s.uid) : undefined),
      statusOf: s => statusOf(s, page),
      labelOf: s => `${s.name} · ${fmt(lengthOf(s, page))}`
    };
  },
  editPoints: (s, kind) => edits.editPoints(s, kind),
  select: (u, options) => select(u, options),
  selectMany(uids) {
    for (const u of uids) state.selected.add(u);
    state.primaryUid = uids.at(-1) ?? state.primaryUid;
    renderPanels();
  },
  beginVertexDrag(s, kind) {
    const page = current();
    s.dragBefore = snapshot(page);
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
  focus: s => {
    select(s.uid);
    focusSelection();
  },
  onCursor(p) {
    $('#cursor').textContent = p ? `${Math.round(p[0])}, ${Math.round(p[1])} px` : '';
  },
  onHover(uid) {
    for (const tr of $$('#rows tr[data-hover]')) delete tr.dataset.hover;
    const s = spikeletByUid(current(), uid);
    if (s) $(`#rows tr[data-uid="${CSS.escape(uid)}"]`)?.setAttribute('data-hover', '');
    $('#hover-info').textContent = s ? `${t('col.id')} ${s.name} · ${fmt(lengthOf(s))} mm · ${t(`status.${statusOf(s)}`)}` : '';
  },
  onView(v) {
    $('#zoom-level').textContent = `${Math.round(v.scale * 100)}%`;
  }
}, {minimap: $('#minimap')});

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
  } catch {
    state.service = {state: 'offline', info: null};
  }
  renderService();
  renderStage();
  renderBatch();
}

function renderService() {
  const el = $('#service-status');
  const s = state.service.state;
  el.dataset.state = s;
  const key = {ready: 'ready', idle: 'idle', busy: 'busy', loading: 'loading', offline: 'offline', 'edit-only': 'editOnly', error: 'error'}[s];
  $('#service-label').textContent = key ? t(`service.${key}`) : '';
  el.title = state.service.info?.model?.weights ?? '';
  $('#service-retry').hidden = s !== 'offline' && s !== 'error';
  $('#samples-open').hidden = s === 'offline';
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

async function measure(page, {askReplace = true} = {}) {
  if (!serviceUsable()) return false;
  if (askReplace && settings.confirmReplace && hasReview(page) && !(await ask(t('ask.replace', {name: page.name})))) return false;
  const controller = new AbortController();
  page.job = {state: 'queued', stage: 'queued', progress: 0, started: Date.now(), controller};
  renderAll();
  try {
    const job = await api().measure(page.blob, {
      name: page.name,
      periods: cal.servicePeriods(page.calibration),
      signal: controller.signal,
      onProgress(j) {
        Object.assign(page.job, {state: j.state, stage: j.stage, progress: j.progress ?? 0});
        renderJob();
        renderImageList();
        renderBatch();
      }
    });
    const result = job.result;
    if (result.width && (result.width !== page.width || result.height !== page.height)) {
      throw new Error(`service decoded ${result.width}×${result.height}, browser ${page.width}×${page.height}`);
    }
    edit(p => {
      p.spikelets = spikeletsFromResult(result);
      p.run = {...runInfo(result), periods: {x: result.x_period_px, y: result.y_period_px}, qc: result.calibration ?? null};
      if (!p.calibration || p.calibration.method === 'grid') p.calibration = calibrationFromResult(result);
      p.measuredAt = new Date().toISOString();
    }, page);
    page.job = {state: 'done', progress: 1};
    if (page.id === state.currentId) {
      state.selected.clear();
      state.primaryUid = null;
    }
    toast(t('measure.done', {name: page.name, n: page.spikelets.length}), 'info', page.id === state.currentId ? undoAction() : null);
    return true;
  } catch (error) {
    if (controller.signal.aborted) {
      page.job = null;
      toast(t('job.cancelled', {name: page.name}));
      return false;
    }
    page.job = {state: 'error', error: error.message};
    toast(t('error.measure', {name: page.name, error: error.message}), 'error');
    return false;
  } finally {
    renderAll();
    checkService();
  }
}

async function runBatch(pages) {
  if (state.batch) return;
  const todo = pages ?? state.pages.filter(p => !p.run && p.job?.state !== 'running');
  if (!todo.length) {
    toast(t('batch.none'));
    return;
  }
  if (!serviceUsable()) return;
  state.batch = {total: todo.length, done: 0, stop: false, started: Date.now(), current: null};
  renderBatch();
  for (const page of todo) {
    if (state.batch.stop) break;
    if (!state.pages.includes(page)) continue;
    state.batch.current = page;
    await measure(page, {askReplace: false});
    state.batch.done++;
    renderBatch();
  }
  const {done, total} = state.batch;
  state.batch = null;
  renderBatch();
  if (total > 1) toast(t('batch.finished', {done, total}));
}

function renderBatch() {
  const b = state.batch;
  const usable = serviceUsable(false);
  $('#measure-pending').hidden = Boolean(b);
  $('#measure-pending').disabled = !usable;
  $('#measure-pending').title = usable ? '' : t('error.service');
  $('#batch-stop').hidden = !b;
  $('#batch-stop').disabled = Boolean(b?.stop);
  $('#batch-progress').hidden = !b;
  if (!b) return;
  const partial = b.current?.job?.progress ?? 0;
  const fraction = (b.done + Math.min(1, partial)) / b.total;
  $('#batch-bar').style.width = `${Math.round(fraction * 100)}%`;
  const elapsed = (Date.now() - b.started) / 1000;
  const eta = b.done > 0 ? (elapsed / b.done) * (b.total - b.done) : null;
  $('#batch-text').textContent = t('batch.progress', {done: b.done, total: b.total}) +
    (eta !== null ? ' · ' + t('batch.eta', {time: formatDuration(eta)}) : '') +
    (b.stop ? ' · ' + t('batch.stopping') : '');
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

// ---------------------------------------------------------------- calibration dialog

function openCalibration() {
  const page = current();
  if (!page) return;
  const c = page.calibration;
  $('#cal-current').textContent = c ? t('cal.current', {value: cal.describe(c), method: t(`method.${c.method}`)}) : t('cal.none');
  $('#cal-grid-result').textContent = c?.method === 'grid'
    ? t('cal.gridResult', {x: c.periodsPx[0].toFixed(2), y: c.periodsPx[1].toFixed(2)}) + (c.adequate ? '' : ' · ' + t('cal.gridWarn', {reasons: c.qcReasons.join(', ')}))
    : '';
  const line = state.rulerLine ?? (c?.method === 'two_point' ? c.points : null);
  $('#cal-pixels').textContent = line ? t('cal.pixels', {px: distance(line[0], line[1]).toFixed(1)}) : '';
  if (c?.method === 'two_point' && !state.rulerLine) $('#cal-mm').value = c.knownMm;
  $('#cal-ratio').value = c ? cal.meanMmPerPx(c).toPrecision(6) : '';
  $('#cal-grid').disabled = !serviceUsable(false);
  $('#cal-error').textContent = '';
  if (!$('#calibration-dialog').open) $('#calibration-dialog').showModal();
  if (state.rulerLine) $('#cal-mm').focus();
}

function applyCalibration(calibration) {
  const page = current();
  const propagate = $('#cal-propagate').checked;
  edit(p => { p.calibration = calibration; }, page);
  let others = 0;
  if (propagate) {
    for (const p of state.pages) {
      if (p === page || p.calibration || p.width !== page.width || p.height !== page.height) continue;
      edit(q => { q.calibration = structuredClone(calibration); }, p);
      others++;
    }
  }
  state.rulerLine = null;
  $('#calibration-dialog').close();
  toast(others ? t('cal.appliedMore', {n: others}) : t('cal.applied'));
}

// ---------------------------------------------------------------- project and export

async function saveProject() {
  await autosave.flush();
  const pages = [];
  for (const page of state.pages) pages.push(serializePage(record(page), await blobToDataUrl(page.blob)));
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  download(`awnstudio-project-${stamp}.json`, JSON.stringify(buildProject(pages)), 'application/json');
  toast(t('project.saved'));
}

async function openProject(file) {
  let data;
  try {
    data = parseProject(JSON.parse(await file.text()));
  } catch (error) {
    toast(t('project.invalid', {error: error.message}), 'error');
    return;
  }
  if (state.pages.length && !(await ask(t('ask.openProject', {n: state.pages.length})))) return;
  await clearWorkspace(false);
  for (const row of data.pages) {
    const page = await makeRuntimePage({...row, blob: await dataUrlToBlob(row.image)});
    state.pages.push(page);
    changed(page, {ui: false});
  }
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
  const pending = pages.reduce((n, p) => n + p.spikelets.filter(s => statusOf(s, p) !== STATUS.confirmed).length, 0);
  const uncalibrated = pages.filter(p => !cal.isValid(p.calibration)).length;
  $('#export-summary').textContent = pages.length
    ? t('export.summary', {pages: pages.length, spikelets: pages.reduce((n, p) => n + p.spikelets.length, 0), pending}) +
      (uncalibrated ? ' ' + t('export.uncalibrated', {n: uncalibrated}) : '')
    : t('export.nothing');
  $('#export-current').disabled = !current()?.spikelets.length;
  $('#export-all').disabled = $('#export-detailed').disabled = !pages.length;
  $('#export-dialog').showModal();
}

function markExported(pages) {
  const now = new Date().toISOString();
  for (const page of pages) {
    page.exportedAt = now;
    changed(page, {ui: false});
  }
  renderAll();
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
  }
}

// ---------------------------------------------------------------- rendering

function renderAll() {
  renderImageList();
  renderStage();
  renderPanels();
  renderSteps();
  renderBatch();
  viewer.render();
}

function renderPanels() {
  renderResults();
  renderDetail();
  renderInspect();
  $('#undo').disabled = !current() || !historyOf(current()).canUndo;
  $('#redo').disabled = !current() || !historyOf(current()).canRedo;
  $('#delete-selection').disabled = $('#focus').disabled = !state.selected.size;
}

function renderImageList() {
  const list = $('#image-list');
  $('#image-count').textContent = state.pages.length;
  list.replaceChildren(...state.pages.map(page => {
    const li = document.createElement('li');
    li.dataset.id = page.id;
    li.setAttribute('aria-current', String(page.id === state.currentId));
    const check = Object.assign(document.createElement('input'), {type: 'checkbox', checked: state.checkedPages.has(page.id)});
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
    sub.append(document.createTextNode(n ? t('images.confirmed', {done, n}) : page.run ? t('images.measured', {n}) : t('images.notMeasured')));
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
  $('#delete-images').disabled = !state.checkedPages.size;
  $('#select-all-images').checked = state.pages.length > 0 && state.checkedPages.size === state.pages.length;
}

function renderStage() {
  const page = current();
  $('#empty').hidden = Boolean(page);
  $('#toolbar').hidden = $('#layers').hidden = !page;
  $('#page-name').textContent = page?.name ?? '—';
  $('#page-meta').textContent = page ? `${page.width} × ${page.height} px` : '';
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
  $('#measure-run').disabled = !page || busy || !usable;
  $('#measure-run').title = usable ? '' : t('error.service');
  $('#measure-run').textContent = page?.run ? t('action.remeasure') : t('action.measure');
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
  $('#job-text').textContent = t(`job.stage.${job.stage ?? 'queued'}`, {pct: Math.round((job.progress ?? 0) * 100)});
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

function renderResults() {
  const page = current();
  const all = page?.spikelets ?? [];
  const statuses = all.map(s => statusOf(s, page));
  const lengths = all.map(s => lengthOf(s, page)).filter(v => v !== null);
  const stats = summarize(lengths);
  const confirmed = statuses.filter(s => s === STATUS.confirmed).length;
  $('#stats').hidden = !all.length;
  $('#summary').replaceChildren(...[
    [all.length, 'summary.spikelets'],
    [stats.n, 'summary.measured'],
    [stats.sd === null ? fmt(stats.mean) : `${fmt(stats.mean, 1)} ± ${fmt(stats.sd, 1)}`, 'summary.mean'],
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
    b.append(Object.assign(document.createElement('small'), {textContent: statuses.filter(test).length}));
  }
  const rows = visibleSpikelets(page);
  $('#rows').replaceChildren(...rows.map(s => {
    const tr = document.createElement('tr');
    tr.dataset.uid = s.uid;
    tr.setAttribute('aria-selected', String(state.selected.has(s.uid)));
    const status = statusOf(s, page);
    const badge = Object.assign(document.createElement('span'), {className: 'badge', textContent: t(`status.${status}`)});
    badge.dataset.status = status;
    const score = representative(s)?.score;
    const cells = [[s.name, ''], [fmt(lengthOf(s, page)), 'num'], [fmt(score, 2), 'num score']]
      .map(([text, className]) => Object.assign(document.createElement('td'), {textContent: text, className}));
    const statusCell = document.createElement('td');
    statusCell.append(badge);
    tr.append(...cells, statusCell);
    return tr;
  }));
  $('#no-rows').hidden = rows.length > 0 || !all.length;
  for (const b of $$('.sort')) {
    if (b.dataset.sort === state.sort.key) b.dataset.dir = state.sort.dir;
    else delete b.dataset.dir;
  }
  $('#confirm-visible').disabled = !rows.some(s => canConfirm(s) && statusOf(s, page) !== STATUS.confirmed);
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
  const confirmed = statuses.filter(s => s === STATUS.confirmed).length;
  bar.title = t('summary.confirmedOf', {done: confirmed, n: statuses.length});
}

function renderHistogram(lengths) {
  const svg = $('#histogram');
  const bins = histogram(lengths);
  const max = Math.max(1, ...bins.map(b => b.count));
  const W = 300, H = 70, gap = 2;
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
  $('#detail-length').textContent = fmt(lengthOf(s, page));
  const badge = $('#detail-status');
  badge.dataset.status = status;
  badge.textContent = multi ? t('detail.multi', {n: state.selected.size}) : t(`status.${status}`);
  $('#detail-origin').textContent = t(s.origin === 'manual' ? 'origin.manual' : s.modified ? 'origin.edited' : 'origin.auto');
  $('#detail-reasons').replaceChildren(...reviewReasons(s, reviewOptions(page)).map(r => Object.assign(document.createElement('li'), {textContent: t(`reason.${r}`)})));
  const confirmed = s.confirmed;
  $('#detail-confirm').textContent = confirmed && !multi ? t('detail.unconfirm') : t('detail.confirm');
  $('#detail-confirm').disabled = !canConfirm(s);
  $('#detail-reset').disabled = s.origin !== 'auto' || (!s.modified && !s.confirmed);
  const n = s.candidates.length;
  $('#candidate-nav').hidden = n < 2 && !(n === 1 && s.rep !== 0);
  const k = state.candidateCursor.get(s.uid) ?? s.rep ?? 0;
  $('#cand-pos').textContent = t('detail.candidate', {k: k + 1, n});
  $('#cand-use').disabled = k === s.rep;
}

function renderInspect() {
  const page = current();
  const s = primary();
  $('#inspect-empty').hidden = Boolean(s);
  $('#inspect').hidden = !s;
  if (!s) return;
  const rep = representative(s);
  $('#inspect-title').textContent = `${t('col.id')} ${s.name}`;
  const facts = [
    ['inspect.uid', s.uid],
    ['inspect.status', t(`status.${statusOf(s, page)}`)],
    ['inspect.origin', t(s.origin === 'manual' ? 'origin.manual' : s.modified ? 'origin.edited' : 'origin.auto')],
    ['inspect.spikeletConfidence', fmt(s.confidence, 3)],
    ['inspect.score', fmt(rep?.score, 3)],
    ['inspect.pRoot', fmt(rep?.meta?.p_root, 3)],
    ['inspect.traceProb', fmt(rep?.meta?.trace_prob, 3)],
    ['inspect.hops', rep?.meta?.hops ?? '—'],
    ['inspect.gaps', rep?.meta?.gaps ?? '—'],
    ['inspect.serviceLength', fmt(rep?.serviceMm, 3)],
    ['inspect.currentLength', fmt(lengthOf(s, page), 3)],
    ['inspect.points', s.line.length]
  ];
  fillFacts($('#inspect-facts'), facts);
  const cursor = state.candidateCursor.get(s.uid) ?? s.rep;
  $('#inspect-candidates').replaceChildren(...s.candidates.map((c, k) => {
    const tr = document.createElement('tr');
    tr.setAttribute('aria-current', String(k === s.rep));
    tr.setAttribute('aria-selected', String(k === cursor));
    tr.append(...[k + 1, fmt(cal.lengthMm(c.path, page.calibration)), fmt(c.score, 3), c.meta?.hops ?? '—', c.meta?.gaps ?? '—']
      .map((v, i) => Object.assign(document.createElement('td'), {textContent: v, className: i ? 'num' : ''})));
    tr.addEventListener('click', () => {
      state.candidateCursor.set(s.uid, k);
      renderPanels();
      viewer.render();
    });
    return tr;
  }));
  const run = page.run;
  const qc = run?.qc;
  fillFacts($('#inspect-run'), [
    ['inspect.method', run?.method ?? '—'],
    ['inspect.model', run?.model ?? '—'],
    ['inspect.elapsed', run?.elapsedS ? `${run.elapsedS.toFixed(1)} s` : '—'],
    ['inspect.measuredAt', page.measuredAt ? new Date(page.measuredAt).toLocaleString() : '—'],
    ['inspect.periods', run?.periods ? `${run.periods.x.toFixed(2)} × ${run.periods.y.toFixed(2)}` : '—'],
    ['inspect.qc', !qc ? '—' : qc.adequate ? t('inspect.qcOk') : (qc.qc_reasons ?? []).join(', ') || t('inspect.none')]
  ]);
}

function openHelp() {
  const list = $('#shortcut-list');
  list.replaceChildren(...SHORTCUTS.map(({keys, label}) => {
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

function fillFacts(dl, facts) {
  dl.replaceChildren(...facts.flatMap(([key, value]) => [
    Object.assign(document.createElement('dt'), {textContent: t(key)}),
    Object.assign(document.createElement('dd'), {textContent: String(value)})
  ]));
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

// ---------------------------------------------------------------- event wiring

function wire() {
  $('#import-open').onclick = $('#empty-import').onclick = () => {
    $('#import-autocal').checked = settings.autoCalibrate;
    $('#import-dialog').showModal();
  };
  $('#import-autocal').onchange = e => { settings.autoCalibrate = e.target.checked; persistSettings(); };
  $('#choose-files').onclick = () => $('#file-input').click();
  $('#choose-folder').onclick = () => $('#folder-input').click();
  for (const id of ['#file-input', '#folder-input']) {
    $(id).onchange = e => { importFiles(e.target.files); e.target.value = ''; };
  }
  for (const zone of [$('#dropzone'), $('#canvas-wrap')]) {
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('dragover');
      importFiles(e.dataTransfer.files);
    });
  }

  $('#select-all-images').onchange = e => {
    state.checkedPages = new Set(e.target.checked ? state.pages.map(p => p.id) : []);
    renderImageList();
  };
  $('#delete-images').onclick = () => deletePages([...state.checkedPages]);
  $('#measure-pending').onclick = () => runBatch();
  $('#batch-stop').onclick = () => {
    if (state.batch) state.batch.stop = true;
    renderBatch();
  };
  $('#samples-open').onclick = $('#empty-sample').onclick = openSamples;
  $('#help-open').onclick = openHelp;
  $('#job-cancel').onclick = () => {
    const job = current()?.job;
    job?.controller?.abort();
    renderJob();
  };
  $('#zoom-in').onclick = () => viewer.zoomBy(1.25);
  $('#zoom-out').onclick = () => viewer.zoomBy(0.8);
  $('#zoom-level').onclick = () => viewer.fit({animate: true});
  const stepActions = {
    import: () => $('#import-open').click(),
    calibrate: () => { state.rulerLine = null; openCalibration(); },
    measure: () => current() && measure(current()),
    review: () => {
      state.filter = 'pending';
      $('[data-tab="results"]').click();
      renderResults();
      const first = visibleSpikelets()[0];
      if (first) {
        select(first.uid);
        focusSelection(true);
      }
    },
    export: openExport
  };
  for (const li of $$('#steps li')) li.querySelector('button').onclick = () => stepActions[li.dataset.step]();
  for (const b of $$('.sort')) {
    b.onclick = () => {
      const key = b.dataset.sort;
      state.sort = {key, dir: state.sort.key === key && state.sort.dir === 'asc' ? 'desc' : 'asc'};
      renderResults();
    };
  }
  $('#rows').addEventListener('pointerover', e => {
    const uid = e.target.closest('tr[data-uid]')?.dataset.uid ?? null;
    if (uid === state.rowHover) return;
    state.rowHover = uid;
    viewer.render();
  });
  $('#rows').addEventListener('pointerleave', () => {
    state.rowHover = null;
    viewer.render();
  });
  $('#export-stats').onclick = () => {
    download('awnstudio_summary.csv', summaryCsv(state.pages, {threshold: state.threshold}), 'text/csv');
  };
  $('#service-retry').onclick = checkService;

  $('#measure-run').onclick = () => current() && measure(current());
  $('#calibrate-open').onclick = () => { state.rulerLine = null; openCalibration(); };
  $('#cal-grid').onclick = async () => {
    const button = $('#cal-grid');
    button.disabled = true;
    button.textContent = t('cal.detecting');
    try {
      const result = await api().calibrate(current().blob);
      applyCalibration(cal.fromGrid(result));
    } catch (error) {
      $('#cal-error').textContent = t('error.calibrate', {error: error.message});
    } finally {
      button.disabled = false;
      button.textContent = t('cal.detect');
    }
  };
  $('#cal-draw').onclick = () => {
    $('#calibration-dialog').close();
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
    if (state.tool !== 'ruler') state.rulerLine = null;
    viewer.render();
  });

  for (const b of $$('[data-tool]')) b.onclick = () => setTool(b.dataset.tool);
  $('#undo').onclick = undo;
  $('#redo').onclick = redo;
  $('#fit').onclick = () => viewer.fit();
  $('#focus').onclick = () => focusSelection();
  $('#delete-selection').onclick = deleteSelected;
  $('#draw-finish').onclick = finishDraft;
  $('#draw-cancel').onclick = () => setTool('select');

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

  for (const tab of $$('[data-tab]')) {
    tab.onclick = () => {
      state.tab = tab.dataset.tab;
      for (const other of $$('[data-tab]')) other.setAttribute('aria-selected', String(other === tab));
      for (const body of $$('[data-body]')) body.hidden = body.dataset.body !== state.tab;
    };
  }
  for (const b of $$('[data-filter]')) b.onclick = () => { state.filter = b.dataset.filter; renderResults(); };
  $('#search').oninput = e => { state.search = e.target.value; renderResults(); };
  $('#rows').onclick = e => {
    const tr = e.target.closest('tr[data-uid]');
    if (!tr) return;
    select(tr.dataset.uid, {additive: e.ctrlKey || e.metaKey, reveal: false});
    focusSelection(true);
  };
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
  const moveCandidate = delta => {
    const s = primary();
    if (!s?.candidates.length) return;
    const n = s.candidates.length;
    const k = state.candidateCursor.get(s.uid) ?? s.rep ?? 0;
    state.candidateCursor.set(s.uid, (k + delta + n) % n);
    renderPanels();
    viewer.render();
  };
  $('#cand-prev').onclick = () => moveCandidate(-1);
  $('#cand-next').onclick = () => moveCandidate(1);
  const useCandidate = () => {
    const s = primary();
    if (!s) return;
    const k = state.candidateCursor.get(s.uid) ?? s.rep;
    if (k === null || k === undefined) return;
    edit(page => edits.useCandidate(spikeletByUid(page, s.uid), k));
  };
  $('#cand-use').onclick = useCandidate;

  $('#open-project').onclick = () => $('#project-input').click();
  $('#project-input').onchange = e => {
    if (e.target.files[0]) openProject(e.target.files[0]);
    e.target.value = '';
  };
  $('#save-project').onclick = saveProject;
  $('#export-open').onclick = openExport;
  $('#export-current').onclick = () => {
    const page = current();
    download(csvName(page), simpleCsv(page), 'text/csv');
    markExported([page]);
  };
  $('#export-all').onclick = () => {
    const pages = exportablePages(state.pages);
    const used = new Set();
    download('awn_lengths.zip', new Blob([zip(pages.map(p => ({name: csvName(p, used), content: simpleCsv(p)})))], {type: 'application/zip'}));
    markExported(pages);
  };
  $('#export-detailed').onclick = () => {
    download('awnstudio_detailed.csv', detailedCsv(state.pages, {threshold: state.threshold}), 'text/csv');
    markExported(exportablePages(state.pages));
  };

  const form = $('#settings-form');
  $('#settings-open').onclick = () => {
    for (const el of form.elements) {
      if (!el.name || !(el.name in settings)) continue;
      if (el.type === 'checkbox') el.checked = settings[el.name];
      else el.value = settings[el.name];
    }
    $('#settings-dialog').showModal();
  };
  form.onchange = e => {
    const el = e.target;
    if (!el.name) return;
    settings[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    if (el.name === 'threshold' && settings.threshold >= 0 && settings.threshold <= 1) {
      state.threshold = settings.threshold;
      $('#threshold').value = state.threshold;
      $('#threshold-value').textContent = state.threshold.toFixed(2);
    }
    persistSettings();
    if (el.name === 'language') applyLanguage();
    if (el.name === 'theme') applyTheme();
    if (el.name === 'serviceBase') checkService();
    renderAll();
  };
  $('#clear-workspace').onclick = async () => {
    $('#settings-dialog').close();
    await clearWorkspace(true);
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  for (const handle of $$('[data-resize]')) {
    handle.addEventListener('pointerdown', down => {
      const key = handle.dataset.resize;
      const start = settings.layout[key];
      handle.setPointerCapture(down.pointerId);
      const move = e => {
        const delta = e.clientX - down.clientX;
        settings.layout[key] = Math.min(560, Math.max(180, start + (key === 'sidebar' ? delta : -delta)));
        applyLayout();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', () => {
        handle.removeEventListener('pointermove', move);
        persistSettings();
        viewer.render();
      }, {once: true});
    });
  }

  window.addEventListener('keydown', onKey);
  window.addEventListener('pagehide', () => { autosave.flush(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autosave.flush();
  });
}

function onKey(e) {
  const target = e.target;
  if (target.closest?.('input, select, textarea, dialog[open]')) return;
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
  const actions = {
    v: () => setTool('select'),
    n: () => setTool('spikelet'),
    a: () => setTool('awn'),
    r: () => setTool('ruler'),
    f: () => focusSelection(),
    0: () => viewer.fit(),
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
    escape: () => (state.draft && state.tool !== 'select' ? setTool('select') : select(null)),
    enter: () => (state.draft ? finishDraft() : $('#detail-confirm').click()),
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
restore();

// Exposed for debugging in the browser console only.
window.awnstudio = {state, settings, current, viewer};

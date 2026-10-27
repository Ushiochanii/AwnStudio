// Canvas viewer: pan / zoom, the four display layers, the live detection scan,
// the completion reveal, the inspection overlay, hit testing and pointer
// editing, plus an overview minimap.
//
// The viewer never mutates data itself. It reads a scene from `host.scene()`
// and reports intents (select, hover, move a vertex, finish a drawing) back to
// the host.

import {bounds, distance, nearestOnPath, nearestVertex, pathLength, pointInPolygon, polygonArea} from './geometry.mjs';
import {EVIDENCE_COLORS, evidenceOpacity, growthColor} from './layers.mjs';

const HANDLE_PX = 8;
const DRAG_PX = 3;
const MIN_SCALE = 0.02;
const MAX_SCALE = 40;
const DRAFT_MARGIN_PX = 24; // clicks further outside the page than this are ignored
const LABEL_ID_ONLY_SCALE = 0.16; // below this zoom labels show the ID only
const ANIMATION_MS = 180;
const GOLD = '#e0a21b';
const GOLD_LIGHT = '#ffd34d';
const CANDIDATE_BLUE = '#3462b0';

// Greedy label placement: keep a label only if it does not overlap one already
// placed. Items earlier in the list win. Exported for tests.
export function placeLabels(items, gap = 2) {
  const placed = [];
  return items.filter(item => {
    const r = item.rect;
    const clash = placed.some(p => r.x < p.x + p.w + gap && p.x < r.x + r.w + gap && r.y < p.y + p.h + gap && p.y < r.y + r.h + gap);
    if (!clash) placed.push(r);
    return !clash;
  });
}

// The first `fraction` of a polyline by length (for the trace reveal).
export function pathPrefix(points, fraction) {
  if (fraction >= 1 || points.length < 2) return points;
  if (fraction <= 0) return points.slice(0, 1);
  const target = pathLength(points) * fraction;
  const out = [points[0]];
  let used = 0;
  for (let i = 1; i < points.length; i++) {
    const d = distance(points[i - 1], points[i]);
    if (used + d >= target) {
      const t = d ? (target - used) / d : 0;
      out.push([points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t]);
      return out;
    }
    used += d;
    out.push(points[i]);
  }
  return out;
}

export function createViewer(canvas, host, {minimap = null} = {}) {
  const ctx = canvas.getContext('2d');
  const view = {scale: 1, tx: 0, ty: 0};
  let frame = 0;
  let animation = 0;
  let gesture = null; // {kind: 'pan' | 'vertex' | 'box' | 'click', ...}
  let cursor = null; // image coordinates
  let hoverUid = null;
  let spaceDown = false;
  let fitted = null; // page id the view was last fitted to
  let palette = {};
  let overview = {pageId: null, image: null, bitmap: null};
  const wrap = canvas.parentElement;

  const size = () => ({w: canvas.clientWidth, h: canvas.clientHeight});
  const toImage = (sx, sy) => [(sx - view.tx) / view.scale, (sy - view.ty) / view.scale];
  const toScreen = ([x, y]) => [x * view.scale + view.tx, y * view.scale + view.ty];
  const eventPoint = event => {
    const rect = canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };

  function readPalette() {
    const style = getComputedStyle(document.documentElement);
    const get = name => style.getPropertyValue(name).trim();
    palette = {
      sheet: get('--sheet'), paper: get('--paper'), focus: get('--cyan'), accent: get('--ink'),
      status: Object.fromEntries(['automatic', 'needs_review', 'modified', 'confirmed', 'missing'].map(s => [s, get(`--st-${s}`) || '#888']))
    };
  }

  function requestRender() {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); });
  }

  function setView(scale, tx, ty) {
    view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    view.tx = tx;
    view.ty = ty;
    host.onView?.({...view});
    requestRender();
  }

  // Ease from the current view to a target view.
  function animateTo(scale, tx, ty) {
    cancelAnimationFrame(animation);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return setView(scale, tx, ty);
    const from = {...view};
    const start = performance.now();
    const ease = t => 1 - (1 - t) ** 3;
    const stepFrame = now => {
      const t = Math.min(1, (now - start) / ANIMATION_MS);
      const k = ease(t);
      const s = from.scale * (scale / from.scale) ** k; // geometric, so zooming feels even
      setView(s, from.tx + (tx - from.tx) * k, from.ty + (ty - from.ty) * k);
      if (t < 1) animation = requestAnimationFrame(stepFrame);
    };
    animation = requestAnimationFrame(stepFrame);
  }

  function fitBox(box, padding = 0.04, {animate = false} = {}) {
    const {w, h} = size();
    if (!w || !h) return;
    const bw = Math.max(1, box.x1 - box.x0), bh = Math.max(1, box.y1 - box.y0);
    const scale = Math.min(MAX_SCALE, Math.min(w / bw, h / bh) * (1 - 2 * padding));
    const tx = w / 2 - ((box.x0 + box.x1) / 2) * scale, ty = h / 2 - ((box.y0 + box.y1) / 2) * scale;
    animate ? animateTo(scale, tx, ty) : setView(scale, tx, ty);
  }

  function fit(options) {
    const page = host.scene().page;
    if (page) fitBox({x0: 0, y0: 0, x1: page.width, y1: page.height}, 0.02, options);
  }

  function zoomAt(factor, sx, sy) {
    cancelAnimationFrame(animation);
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    const [ix, iy] = toImage(sx, sy);
    setView(scale, sx - ix * scale, sy - iy * scale);
  }

  // Drawing ---------------------------------------------------------------

  function tracePath(points, closed = false) {
    ctx.beginPath();
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (closed) ctx.closePath();
  }

  function traceRings(rings) {
    ctx.beginPath();
    for (const ring of rings) {
      ring.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    }
  }

  function strokeLine(points, color, widthPx, px, {halo = true, dash = null} = {}) {
    if (points.length < 2) return;
    tracePath(points);
    ctx.lineCap = ctx.lineJoin = 'round';
    if (dash) ctx.setLineDash(dash.map(d => d * px));
    if (halo) {
      ctx.strokeStyle = 'rgba(0,0,0,0.42)';
      ctx.lineWidth = (widthPx + 2.2) * px;
      ctx.stroke();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = widthPx * px;
    ctx.stroke();
    if (dash) ctx.setLineDash([]);
  }

  function render() {
    readPalette();
    const dpr = window.devicePixelRatio || 1;
    const {w, h} = size();
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scene = host.scene();
    const {page, image, layers} = scene;
    if (!page) {
      renderMinimap(scene);
      host.onRendered?.();
      return;
    }
    if (fitted !== page.id) {
      fitted = page.id;
      fit();
    }
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.tx, dpr * view.ty);
    const px = 1 / view.scale; // one screen pixel in image units

    // Paper and photo. A soft shadow lifts the sheet off the grid backdrop.
    ctx.save();
    ctx.shadowColor = 'rgba(20,30,35,0.18)';
    ctx.shadowBlur = 18 * px * view.scale;
    ctx.fillStyle = palette.sheet;
    ctx.fillRect(0, 0, page.width, page.height);
    ctx.restore();
    const showPhoto = scene.sourcePreview || (layers.photo && !scene.photoHidden);
    if (showPhoto && image) {
      ctx.imageSmoothingEnabled = view.scale < 2;
      ctx.drawImage(image, 0, 0, page.width, page.height);
    }
    if (scene.sourcePreview) {
      renderMinimap(scene);
      host.onRendered?.();
      return;
    }
    if (layers.dim && !scene.live) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillRect(0, 0, page.width, page.height);
    }

    if (scene.live) drawLive(scene, image, px);
    else if (scene.displayLayer === 'evidence') drawEvidence(scene.evidence, px);
    else if (scene.displayLayer === 'growth') drawGrowth(scene, px);
    else if (scene.displayLayer === 'candidates') drawCandidates(scene, px);
    else drawEdits(scene, px, dpr);

    if (scene.inspect) drawInspection(scene.inspect, px);

    const ruler = scene.ruler;
    if (ruler?.length) drawMeasureLine(ruler, palette.focus, px);
    if (scene.draft) drawDraft(scene.draft, px);
    if (gesture?.kind === 'box' && gesture.moved) {
      const [x0, y0] = gesture.start, [x1, y1] = gesture.current;
      ctx.fillStyle = palette.focus + '1a';
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.setLineDash([5 * px, 4 * px]);
      ctx.strokeStyle = palette.focus;
      ctx.lineWidth = px;
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.setLineDash([]);
    }
    renderMinimap(scene);
    host.onRendered?.();
  }

  // Layer: detection evidence -------------------------------------------

  function drawEvidence(items, px, {alpha = 1} = {}) {
    if (!items) return;
    for (const item of items) {
      const spikelet = item.kind === 'spikelet';
      const color = spikelet ? EVIDENCE_COLORS.spikelet : EVIDENCE_COLORS.awn;
      const fillOpacity = (spikelet ? 0.28 : evidenceOpacity(item.confidence)) * alpha;
      traceRings(item.rings);
      ctx.globalAlpha = fillOpacity;
      ctx.fillStyle = color;
      ctx.fill('evenodd');
      ctx.globalAlpha = (spikelet ? 0.72 : Math.min(0.55, evidenceOpacity(item.confidence) + 0.1)) * alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = (spikelet ? 0.8 : 0.6) * px;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // Live scan while the model runs: processed tiles show their evidence, the
  // rest of the page waits under a veil, and the tile in progress is outlined.
  function drawLive(scene, image, px) {
    const {live, page} = scene;
    const tiles = live.tileRects ?? [];
    const done = Math.min(live.tiles?.done ?? 0, tiles.length);
    if (live.stage === 'detect' || !done) {
      ctx.fillStyle = 'rgba(246,247,244,0.62)';
      ctx.fillRect(0, 0, page.width, page.height);
      if (image) {
        for (let i = 0; i < done; i++) {
          const [x0, y0, x1, y1] = tiles[i];
          ctx.drawImage(image, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
        }
      }
    }
    drawEvidence(live.evidence, px);
    if (live.stage === 'detect' && done < tiles.length) {
      const [x0, y0, x1, y1] = tiles[done];
      ctx.save();
      ctx.strokeStyle = palette.focus;
      ctx.lineWidth = 2 * px;
      ctx.shadowColor = palette.focus;
      ctx.shadowBlur = 12;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.restore();
      // Scan line sweeping down the tile in progress.
      const phase = (performance.now() % 900) / 900;
      const y = y0 + (y1 - y0) * phase;
      const gradient = ctx.createLinearGradient(0, y - 40, 0, y);
      gradient.addColorStop(0, 'rgba(31,127,166,0)');
      gradient.addColorStop(1, 'rgba(31,127,166,0.35)');
      ctx.fillStyle = gradient;
      ctx.fillRect(x0, y - 40, x1 - x0, 40);
      requestRender();
    }
  }

  // Layer: growth ---------------------------------------------------------

  function spikeletBackdrop(scene, px) {
    if (scene.spikeletContext && scene.evidence?.length) {
      drawEvidence(scene.evidence.filter(i => i.kind === 'spikelet'), px, {alpha: 0.55});
      return;
    }
    for (const s of scene.spikelets) {
      tracePath(s.polygon, true);
      ctx.fillStyle = 'rgba(47,138,106,0.16)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(47,138,106,0.55)';
      ctx.lineWidth = 0.9 * px;
      ctx.stroke();
    }
  }

  function drawGrowth(scene, px) {
    spikeletBackdrop(scene, px);
    const limit = scene.reveal?.stage === 'growth' ? scene.reveal.hop : Infinity;
    for (const s of scene.spikelets) {
      const selected = scene.selected.has(s.uid);
      for (const c of s.candidates) {
        const hops = c.growth?.hops;
        if (!hops?.length) continue;
        // Later hops underneath, the seed on top.
        for (let i = Math.min(hops.length - 1, limit); i >= 0; i--) {
          strokeLine(hops[i].path, growthColor(i), (selected ? 3.6 : i === 0 ? 3 : 2.4), px, {dash: hops[i].gap ? [5, 4] : null});
        }
      }
    }
  }

  // Layer: candidates -----------------------------------------------------

  function drawCandidates(scene, px) {
    spikeletBackdrop(scene, px);
    for (const s of scene.spikelets) {
      const selected = scene.selected.has(s.uid);
      const cursorIndex = selected ? scene.candidateCursor?.(s) : undefined;
      s.candidates.forEach((c, k) => {
        if (k === s.rep) return;
        if (c.score !== null && c.score < scene.threshold && k !== cursorIndex) return;
        const focused = k === cursorIndex;
        strokeLine(c.path, focused ? palette.focus : CANDIDATE_BLUE, focused ? 4 : 2.2, px, {dash: c.alternative ? [6, 4] : null});
      });
      const rep = s.rep === null ? null : s.candidates[s.rep];
      if (rep) strokeLine(rep.path, GOLD, selected ? 4.2 : 3, px);
    }
  }

  // Layer: editable result ------------------------------------------------

  function drawEdits(scene, px, dpr) {
    const {layers} = scene;
    const color = status => palette.status[status] ?? '#888';
    const selected = scene.selected;
    const hover = scene.hoverUid ?? hoverUid;
    const reveal = scene.reveal?.stage === 'trace' ? scene.reveal.t : 1;
    for (const s of scene.spikelets) {
      const status = scene.statusOf(s);
      const isSelected = selected.has(s.uid);
      const isHover = s.uid === hover;
      if (layers.outlines || isSelected || isHover) {
        tracePath(s.polygon, true);
        if (isSelected || isHover) {
          ctx.fillStyle = color(status) + (isSelected ? '33' : '1f');
          ctx.fill();
        }
        ctx.strokeStyle = color(status);
        ctx.globalAlpha = isSelected || isHover ? 1 : 0.75;
        ctx.lineWidth = (isSelected ? 2 : isHover ? 1.8 : 1.2) * px;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (isSelected && scene.showCandidatesOfSelected) {
        const cursorIndex = scene.candidateCursor?.(s);
        s.candidates.forEach((c, k) => {
          if (k === s.rep) return;
          if (c.score !== null && c.score < scene.threshold && k !== cursorIndex) return;
          strokeLine(c.path, k === cursorIndex ? palette.focus : '#5b6b8c', k === cursorIndex ? 2.2 : 1.5, px, {halo: false, dash: [4, 3]});
        });
      }
      if ((layers.paths || isSelected) && s.line.length >= 2) {
        const line = reveal < 1 ? pathPrefix(s.line, easeOut(reveal)) : s.line;
        strokeLine(line, isSelected ? GOLD_LIGHT : GOLD, isSelected || isHover ? 2.6 : 1.9, px);
        ctx.beginPath();
        ctx.arc(s.line[0][0], s.line[0][1], 3 * px, 0, Math.PI * 2);
        ctx.fillStyle = color(status);
        ctx.fill();
        if (reveal < 1 && line.length) {
          const tip = line.at(-1);
          ctx.beginPath();
          ctx.arc(tip[0], tip[1], 4 * px, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
        }
      }
    }

    const primary = scene.primary;
    if (primary && scene.tool === 'select' && scene.editable) {
      drawHandles(host.editPoints(primary, 'polygon'), color(scene.statusOf(primary)), px, 3, scene.selectedNodes, primary.uid, 'polygon');
      if (primary.line.length >= 2) drawHandles(host.editPoints(primary, 'line'), GOLD_LIGHT, px, 3.5, scene.selectedNodes, primary.uid, 'line');
    }
    if (layers.labels && reveal > 0.85) drawLabels(scene, dpr, hover, reveal);
  }

  const easeOut = t => 1 - (1 - t) ** 3;

  // Inspection overlay: seed -> hops -> final path, up to the current step.
  function drawInspection(inspect, px) {
    if (inspect.pool) for (const path of inspect.pool) strokeLine(path, '#89938d', 1.3, px, {halo: false, dash: [4, 3]});
    inspect.steps.forEach((step, i) => {
      if (step.kind === 'final') strokeLine(step.path, GOLD, 5, px);
      else strokeLine(step.path, growthColor(step.kind === 'seed' ? 0 : step.hop), i === inspect.steps.length - 1 ? 4.4 : 3.4, px, {dash: step.gap ? [5, 4] : null});
    });
  }

  function drawHandles(points, stroke, px, radius, selectedNodes = null, uid = null, kind = null) {
    ctx.lineWidth = 1.2 * px;
    points.forEach(([x, y], index) => {
      const chosen = selectedNodes?.some(n => n.uid === uid && n.kind === kind && n.index === index);
      ctx.beginPath();
      ctx.arc(x, y, (chosen ? radius + 1 : radius) * px, 0, Math.PI * 2);
      ctx.fillStyle = chosen ? GOLD : '#fff';
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.stroke();
    });
  }

  function drawMeasureLine(points, stroke, px) {
    const all = cursor && points.length === 1 ? [...points, cursor] : points;
    tracePath(all);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2 * px;
    ctx.stroke();
    drawHandles(points, stroke, px, 4);
    if (all.length === 2) {
      const [a, b] = all;
      ctx.save();
      ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
      const [sx, sy] = toScreen([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      const text = `${distance(a, b).toFixed(1)} px`;
      ctx.font = '600 12px ui-monospace, "Cascadia Mono", Consolas, monospace';
      const tw = ctx.measureText(text).width + 10;
      ctx.fillStyle = stroke;
      ctx.beginPath();
      ctx.roundRect(sx - tw / 2, sy - 24, tw, 18, 4);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, sx - tw / 2 + 5, sy - 15);
      ctx.restore();
    }
  }

  function drawDraft(draft, px) {
    const pts = cursor ? [...draft.points, cursor] : draft.points;
    if (pts.length) {
      tracePath(pts, draft.kind === 'spikelet' && pts.length > 2);
      ctx.strokeStyle = draft.kind === 'spikelet' ? palette.focus : GOLD_LIGHT;
      ctx.lineWidth = 2 * px;
      ctx.setLineDash([6 * px, 4 * px]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    drawHandles(draft.points, palette.focus, px, 3.5);
  }

  function drawLabels(scene, dpr, hover, reveal) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '600 11px ui-monospace, "Cascadia Mono", Consolas, monospace';
    ctx.textBaseline = 'middle';
    const {w, h} = size();
    const idOnly = view.scale < LABEL_ID_ONLY_SCALE;
    const items = [];
    const alpha = Math.min(1, (reveal - 0.85) / 0.15);
    for (const s of scene.spikelets) {
      const b = bounds(s.polygon);
      const [sx, sy] = toScreen([(b.x0 + b.x1) / 2, b.y1]);
      if (sx < -40 || sy < -20 || sx > w + 40 || sy > h + 20) continue;
      const important = scene.selected.has(s.uid) || s.uid === hover;
      const text = idOnly && !important ? s.name : scene.labelOf(s);
      const tw = ctx.measureText(text).width + 10;
      items.push({s, text, important, rect: {x: sx - tw / 2, y: sy + 3, w: tw, h: 17}});
    }
    items.sort((a, b) => Number(b.important) - Number(a.important));
    ctx.globalAlpha = alpha;
    for (const {s, text, important, rect} of placeLabels(items)) {
      ctx.fillStyle = important ? '#111a1f' : 'rgba(17,26,31,0.76)';
      ctx.beginPath();
      ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 4);
      ctx.fill();
      ctx.fillStyle = palette.status[scene.statusOf(s)] ?? '#fff';
      ctx.fillRect(rect.x, rect.y + 3, 2, rect.h - 6);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, rect.x + 5, rect.y + 9);
    }
    ctx.globalAlpha = 1;
  }

  // Minimap ---------------------------------------------------------------

  function minimapGeometry(page) {
    const mw = minimap.clientWidth || minimap.width, mh = minimap.clientHeight || minimap.height;
    const k = Math.min(mw / page.width, mh / page.height);
    return {k, ox: (mw - page.width * k) / 2, oy: (mh - page.height * k) / 2, mw, mh};
  }

  function renderMinimap(scene) {
    if (!minimap) return;
    const page = scene.page;
    if (!page) {
      minimap.hidden = true;
      return;
    }
    const {w, h} = size();
    const [x0, y0] = toImage(0, 0), [x1, y1] = toImage(w, h);
    // The overview only helps when part of the page is out of view.
    minimap.hidden = x0 <= 0 && y0 <= 0 && x1 >= page.width && y1 >= page.height;
    if (minimap.hidden) return;
    const dpr = window.devicePixelRatio || 1;
    const {k, ox, oy, mw, mh} = minimapGeometry(page);
    if (minimap.width !== Math.round(mw * dpr)) {
      minimap.width = Math.round(mw * dpr);
      minimap.height = Math.round(mh * dpr);
    }
    const m = minimap.getContext('2d');
    m.setTransform(dpr, 0, 0, dpr, 0, 0);
    m.clearRect(0, 0, mw, mh);
    if (scene.image && (overview.pageId !== page.id || overview.image !== scene.image)) {
      const off = document.createElement('canvas');
      off.width = Math.max(1, Math.round(page.width * k * dpr));
      off.height = Math.max(1, Math.round(page.height * k * dpr));
      off.getContext('2d').drawImage(scene.image, 0, 0, off.width, off.height);
      overview = {pageId: page.id, image: scene.image, bitmap: off};
    }
    if (overview.bitmap && overview.pageId === page.id) m.drawImage(overview.bitmap, ox, oy, page.width * k, page.height * k);
    else {
      m.fillStyle = palette.sheet;
      m.fillRect(ox, oy, page.width * k, page.height * k);
    }
    for (const s of scene.spikelets) {
      const b = bounds(s.polygon);
      m.fillStyle = palette.status[scene.statusOf(s)] ?? '#888';
      m.globalAlpha = scene.selected.has(s.uid) ? 1 : 0.7;
      m.fillRect(ox + b.x0 * k, oy + b.y0 * k, Math.max(2, (b.x1 - b.x0) * k), Math.max(2, (b.y1 - b.y0) * k));
    }
    m.globalAlpha = 1;
    m.strokeStyle = palette.focus;
    m.lineWidth = 1.5;
    m.fillStyle = palette.focus + '22';
    const rx = ox + Math.max(0, x0) * k, ry = oy + Math.max(0, y0) * k;
    const rw = (Math.min(page.width, x1) - Math.max(0, x0)) * k, rh = (Math.min(page.height, y1) - Math.max(0, y0)) * k;
    if (rw > 0 && rh > 0) {
      m.fillRect(rx, ry, rw, rh);
      m.strokeRect(rx, ry, rw, rh);
    }
  }

  function centerOnMinimap(event) {
    const page = host.scene().page;
    if (!page) return;
    const rect = minimap.getBoundingClientRect();
    const {k, ox, oy} = minimapGeometry(page);
    const ix = (event.clientX - rect.left - ox) / k, iy = (event.clientY - rect.top - oy) / k;
    const {w, h} = size();
    cancelAnimationFrame(animation);
    setView(view.scale, w / 2 - ix * view.scale, h / 2 - iy * view.scale);
  }

  if (minimap) {
    minimap.addEventListener('pointerdown', event => {
      minimap.setPointerCapture(event.pointerId);
      centerOnMinimap(event);
      const move = e => centerOnMinimap(e);
      minimap.addEventListener('pointermove', move);
      minimap.addEventListener('pointerup', () => minimap.removeEventListener('pointermove', move), {once: true});
    });
    minimap.addEventListener('wheel', event => {
      event.preventDefault();
      const {w, h} = size();
      zoomAt(Math.exp(-event.deltaY * 0.0015), w / 2, h / 2);
    }, {passive: false});
  }

  // Hit testing -----------------------------------------------------------

  // A candidate path under the pointer in the growth / candidates layers.
  function hitCandidate(p) {
    const scene = host.scene();
    if (!['growth', 'candidates'].includes(scene.displayLayer)) return null;
    const tol = HANDLE_PX / view.scale;
    let best = null;
    for (const s of scene.spikelets) {
      s.candidates.forEach((c, k) => {
        const paths = scene.displayLayer === 'growth' ? (c.growth?.hops ?? []).map(h => h.path) : [c.path];
        for (const path of paths) {
          if (path.length < 2) continue;
          const d = nearestOnPath(path, p).distance;
          if (d < tol && (!best || d < best.d)) best = {s, k, d};
        }
      });
    }
    return best;
  }

  function hitSpikelet(p) {
    const {spikelets} = host.scene();
    const tol = HANDLE_PX / view.scale;
    let best = null;
    for (const s of spikelets) {
      if (s.line.length >= 2) {
        const d = nearestOnPath(s.line, p).distance;
        if (d < tol && (!best || best.line === false || d < best.d)) best = {s, d, line: true};
      }
      if ((!best || !best.line) && pointInPolygon(p, s.polygon)) {
        const area = polygonArea(s.polygon);
        if (!best || area < best.area) best = {s, area, line: false};
      }
    }
    return best?.s ?? null;
  }

  function hitHandle(p) {
    const scene = host.scene();
    const s = scene.primary;
    if (!s || scene.tool !== 'select' || !scene.editable) return null;
    const tol = HANDLE_PX / view.scale;
    for (const kind of ['line', 'polygon']) {
      const points = host.editPoints(s, kind);
      if (!points.length) continue;
      const v = nearestVertex(points, p);
      if (v.distance < tol) return {s, kind, index: v.index};
    }
    return null;
  }

  function hitEdge(p) {
    const scene = host.scene();
    const s = scene.primary;
    if (!s || !scene.editable) return null;
    const tol = HANDLE_PX / view.scale;
    for (const kind of ['line', 'polygon']) {
      const points = host.editPoints(s, kind);
      if (points.length < 2) continue;
      const near = nearestOnPath(points, p, kind === 'polygon');
      if (near.distance < tol) return {s, kind, index: near.index + 1, point: near.point};
    }
    return null;
  }

  function setHover(uid) {
    if (uid === hoverUid) return;
    hoverUid = uid;
    if (uid) wrap.dataset.hover = '';
    else delete wrap.dataset.hover;
    host.onHover?.(uid);
    requestRender();
  }

  // Vertices of every spikelet inside a box (for the box tool).
  function verticesInBox(box) {
    const inside = ([x, y]) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
    const nodes = [];
    for (const s of host.scene().spikelets) {
      for (const kind of ['polygon', 'line']) {
        host.editPoints(s, kind).forEach((q, index) => { if (inside(q)) nodes.push({uid: s.uid, kind, index}); });
      }
    }
    return nodes;
  }

  // Pointer handling ------------------------------------------------------

  canvas.addEventListener('pointerdown', event => {
    const scene = host.scene();
    if (!scene.page || scene.sourcePreview) return;
    cancelAnimationFrame(animation);
    wrap.focus({preventScroll: true});
    const screen = eventPoint(event);
    const p = toImage(...screen);
    const tool = scene.tool;
    canvas.setPointerCapture(event.pointerId);
    if (event.button === 1 || spaceDown) {
      gesture = {kind: 'pan', origin: screen, view: {...view}, moved: true};
      wrap.dataset.panning = '';
      return;
    }
    if (event.button !== 0) return;
    if (tool === 'box') {
      gesture = {kind: 'box', vertices: true, start: p, current: p, origin: screen, moved: false};
      return;
    }
    if (tool === 'select') {
      const handle = hitHandle(p);
      if (handle) {
        gesture = {kind: 'vertex', s: handle.s, handleKind: handle.kind, index: handle.index, origin: screen, point: p, moved: false};
        return;
      }
      if (event.shiftKey) {
        gesture = {kind: 'box', start: p, current: p, origin: screen, moved: false};
        return;
      }
    }
    gesture = {kind: 'click', origin: screen, view: {...view}, point: p, moved: false, additive: event.ctrlKey || event.metaKey};
  });

  canvas.addEventListener('pointermove', event => {
    const screen = eventPoint(event);
    cursor = toImage(...screen);
    host.onCursor?.(cursor);
    if (!gesture) {
      const scene = host.scene();
      if (scene.page && scene.tool === 'select' && !scene.sourcePreview) {
        setHover(hitCandidate(cursor)?.s.uid ?? hitSpikelet(cursor)?.uid ?? null);
        if (hitHandle(cursor)) wrap.dataset.handle = '';
        else delete wrap.dataset.handle;
      } else if (hoverUid) setHover(null);
      if (scene.draft || scene.ruler?.length === 1) requestRender();
      return;
    }
    const moved = distance(screen, gesture.origin) > DRAG_PX;
    if (moved && !gesture.moved) {
      gesture.moved = true;
      if (gesture.kind === 'vertex') host.beginVertexDrag(gesture.s, gesture.handleKind, gesture.index);
      if (gesture.kind === 'click') {
        gesture.kind = 'pan';
        wrap.dataset.panning = '';
      }
    }
    if (!gesture.moved) return;
    if (gesture.kind === 'pan') {
      setView(view.scale, gesture.view.tx + screen[0] - gesture.origin[0], gesture.view.ty + screen[1] - gesture.origin[1]);
    } else if (gesture.kind === 'vertex') {
      host.moveVertex(gesture.s, gesture.handleKind, gesture.index, clampToPage(cursor));
      requestRender();
    } else if (gesture.kind === 'box') {
      gesture.current = cursor;
      requestRender();
    }
  });

  const finishGesture = event => {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    delete wrap.dataset.panning;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    const scene = host.scene();
    const tool = scene.tool;
    if (g.kind === 'vertex' && g.moved) host.endVertexDrag(g.s, g.handleKind);
    else if (g.kind === 'box' && g.moved) {
      const box = {
        x0: Math.min(g.start[0], g.current[0]), x1: Math.max(g.start[0], g.current[0]),
        y0: Math.min(g.start[1], g.current[1]), y1: Math.max(g.start[1], g.current[1])
      };
      if (g.vertices) host.selectNodes(verticesInBox(box));
      else {
        const inside = scene.spikelets.filter(s => {
          const b = bounds(s.polygon);
          const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
          return cx >= box.x0 && cx <= box.x1 && cy >= box.y0 && cy <= box.y1;
        });
        host.selectMany(inside.map(s => s.uid));
      }
    } else if (g.kind === 'click' || (g.kind === 'vertex' && !g.moved) || (g.kind === 'box' && !g.moved)) {
      const p = g.point ?? toImage(...g.origin);
      if (tool === 'select' || tool === 'box') {
        const candidate = hitCandidate(p);
        if (candidate) host.selectCandidate(candidate.s.uid, candidate.k);
        else {
          const s = hitSpikelet(p);
          host.select(s?.uid ?? null, {additive: g.additive || (g.kind === 'box' && !g.vertices)});
        }
      } else if (insidePage(p)) {
        host.addDraftPoint(clampToPage(p));
      }
    }
    requestRender();
  };
  canvas.addEventListener('pointerup', finishGesture);
  canvas.addEventListener('pointercancel', finishGesture);

  canvas.addEventListener('dblclick', event => {
    const p = toImage(...eventPoint(event));
    const tool = host.scene().tool;
    if (tool === 'select') {
      const edge = hitEdge(p);
      if (edge) host.insertVertex(edge.s, edge.kind, edge.index, clampToPage(edge.point));
      else {
        const s = hitSpikelet(p);
        if (s) host.focus?.(s);
      }
    } else if (tool !== 'box') {
      host.finishDraft();
    }
  });

  canvas.addEventListener('contextmenu', event => {
    event.preventDefault();
    const p = toImage(...eventPoint(event));
    if (host.scene().tool === 'select') {
      const handle = hitHandle(p);
      if (handle) host.removeVertex(handle.s, handle.kind, handle.index);
    } else {
      host.undoDraftPoint();
    }
  });

  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const [sx, sy] = eventPoint(event);
    if (event.ctrlKey || !event.shiftKey) zoomAt(Math.exp(-event.deltaY * (event.deltaMode ? 0.05 : 0.0015)), sx, sy);
    else setView(view.scale, view.tx - event.deltaY, view.ty);
  }, {passive: false});

  canvas.addEventListener('pointerleave', () => {
    cursor = null;
    host.onCursor?.(null);
    setHover(null);
    delete wrap.dataset.handle;
    requestRender();
  });

  window.addEventListener('keydown', event => {
    if (event.code === 'Space' && !event.repeat && document.activeElement === wrap) {
      spaceDown = true;
      event.preventDefault();
    }
  });
  window.addEventListener('keyup', event => {
    if (event.code === 'Space') spaceDown = false;
  });
  new ResizeObserver(requestRender).observe(canvas);

  function insidePage([x, y]) {
    const page = host.scene().page;
    const m = DRAFT_MARGIN_PX / view.scale;
    return x >= -m && y >= -m && x <= page.width + m && y <= page.height + m;
  }

  function clampToPage([x, y]) {
    const page = host.scene().page;
    return [Math.min(page.width, Math.max(0, x)), Math.min(page.height, Math.max(0, y))];
  }

  return {
    render: requestRender,
    fit,
    fitBox,
    zoomBy: factor => {
      const {w, h} = size();
      zoomAt(factor, w / 2, h / 2);
    },
    resetFit: () => { fitted = null; requestRender(); },
    project: point => toScreen(point),
    get view() { return {...view}; },
    get hoverUid() { return hoverUid; }
  };
}

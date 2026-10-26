// Canvas viewer: pan / zoom, layered drawing, hit testing, pointer editing and
// an overview minimap.
//
// The viewer never mutates data itself. It reads a scene from `host.scene()`
// and reports intents (select, hover, move a vertex, finish a drawing) back to
// the host.

import {bounds, distance, nearestOnPath, nearestVertex, pointInPolygon, polygonArea} from './geometry.mjs';

const HANDLE_PX = 8;
const DRAG_PX = 3;
const MIN_SCALE = 0.02;
const MAX_SCALE = 40;
const DRAFT_MARGIN_PX = 24; // clicks further outside the page than this are ignored
const LABEL_ID_ONLY_SCALE = 0.16; // below this zoom labels show the ID only
const ANIMATION_MS = 180;

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
      surface: get('--surface'), focus: get('--focus'), accent: get('--accent'),
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
    const from = {...view};
    const start = performance.now();
    const ease = t => 1 - (1 - t) ** 3;
    const stepFrame = now => {
      const t = Math.min(1, (now - start) / ANIMATION_MS);
      const k = ease(t);
      // Interpolate the scale geometrically so zooming feels even.
      const s = from.scale * (scale / from.scale) ** k;
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
      return;
    }
    if (fitted !== page.id) {
      fitted = page.id;
      fit();
    }
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.tx, dpr * view.ty);
    const px = 1 / view.scale; // one screen pixel in image units

    ctx.fillStyle = palette.surface;
    ctx.fillRect(0, 0, page.width, page.height);
    if (layers.photo && image) {
      ctx.imageSmoothingEnabled = view.scale < 2;
      ctx.drawImage(image, 0, 0, page.width, page.height);
    }
    if (layers.dim) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillRect(0, 0, page.width, page.height);
    }

    const color = status => palette.status[status] ?? '#888';
    const selected = scene.selected;
    const hover = scene.hoverUid ?? hoverUid;
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
      if (layers.candidates || (isSelected && scene.showCandidatesOfSelected)) {
        s.candidates.forEach((c, k) => {
          if (k === s.rep) return;
          if (c.score !== null && c.score < scene.threshold) return;
          tracePath(c.path);
          ctx.setLineDash([4 * px, 3 * px]);
          ctx.strokeStyle = k === scene.candidateCursor?.(s) ? palette.focus : '#5b6b8c';
          ctx.lineWidth = (k === scene.candidateCursor?.(s) ? 2.2 : 1.5) * px;
          ctx.stroke();
          ctx.setLineDash([]);
        });
      }
      if ((layers.paths || isSelected) && s.line.length >= 2) {
        tracePath(s.line);
        ctx.lineCap = ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.lineWidth = (isSelected || isHover ? 5 : 3.5) * px;
        ctx.stroke();
        ctx.strokeStyle = isSelected ? '#ffd23f' : '#f2b705';
        ctx.lineWidth = (isSelected || isHover ? 2.5 : 1.8) * px;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(s.line[0][0], s.line[0][1], 3 * px, 0, Math.PI * 2);
        ctx.fillStyle = color(status);
        ctx.fill();
      }
    }

    const primary = scene.primary;
    if (primary && scene.tool === 'select') {
      drawHandles(host.editPoints(primary, 'polygon'), color(scene.statusOf(primary)), px, 3);
      if (primary.line.length >= 2) drawHandles(host.editPoints(primary, 'line'), '#ffd23f', px, 3.5);
    }

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

    if (layers.labels) drawLabels(scene, dpr, hover);
    renderMinimap(scene);
  }

  function drawHandles(points, stroke, px, radius) {
    ctx.lineWidth = 1.2 * px;
    for (const [x, y] of points) {
      ctx.beginPath();
      ctx.arc(x, y, radius * px, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  }

  function drawMeasureLine(points, stroke, px) {
    const all = cursor && points.length === 1 ? [...points, cursor] : points;
    tracePath(all);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2 * px;
    ctx.stroke();
    drawHandles(points, stroke, px, 4);
    if (all.length === 2) {
      // Live pixel distance next to the ruler.
      const [a, b] = all;
      ctx.save();
      ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
      const [sx, sy] = toScreen([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      const text = `${distance(a, b).toFixed(1)} px`;
      ctx.font = '600 12px system-ui, sans-serif';
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
      ctx.strokeStyle = draft.kind === 'spikelet' ? palette.accent : '#ffd23f';
      ctx.lineWidth = 2 * px;
      ctx.setLineDash([6 * px, 4 * px]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    drawHandles(draft.points, palette.accent, px, 3.5);
  }

  function drawLabels(scene, dpr, hover) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const {w, h} = size();
    const idOnly = view.scale < LABEL_ID_ONLY_SCALE;
    const items = [];
    for (const s of scene.spikelets) {
      const b = bounds(s.polygon);
      const [sx, sy] = toScreen([(b.x0 + b.x1) / 2, b.y1]);
      if (sx < -40 || sy < -20 || sx > w + 40 || sy > h + 20) continue;
      const important = scene.selected.has(s.uid) || s.uid === hover;
      const text = idOnly && !important ? s.name : scene.labelOf(s);
      const tw = ctx.measureText(text).width + 8;
      items.push({s, text, important, rect: {x: sx - tw / 2, y: sy + 2, w: tw, h: 16}});
    }
    items.sort((a, b) => Number(b.important) - Number(a.important));
    for (const {s, text, important, rect} of placeLabels(items)) {
      ctx.fillStyle = important ? '#111' : 'rgba(20,20,20,0.72)';
      ctx.beginPath();
      ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 4);
      ctx.fill();
      if (important) {
        ctx.strokeStyle = palette.status[scene.statusOf(s)] ?? '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      ctx.fillText(text, rect.x + 4, rect.y + 8);
    }
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
    minimap.hidden = !page;
    if (!page) return;
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
      overview = {pageId: page.id, image: scene.image, bitmap: null};
      const off = document.createElement('canvas');
      off.width = Math.max(1, Math.round(page.width * k * dpr));
      off.height = Math.max(1, Math.round(page.height * k * dpr));
      off.getContext('2d').drawImage(scene.image, 0, 0, off.width, off.height);
      overview.bitmap = off;
    }
    if (overview.bitmap && overview.pageId === page.id) m.drawImage(overview.bitmap, ox, oy, page.width * k, page.height * k);
    else {
      m.fillStyle = palette.surface;
      m.fillRect(ox, oy, page.width * k, page.height * k);
    }
    for (const s of scene.spikelets) {
      const b = bounds(s.polygon);
      m.fillStyle = palette.status[scene.statusOf(s)] ?? '#888';
      m.globalAlpha = scene.selected.has(s.uid) ? 1 : 0.7;
      m.fillRect(ox + b.x0 * k, oy + b.y0 * k, Math.max(2, (b.x1 - b.x0) * k), Math.max(2, (b.y1 - b.y0) * k));
    }
    m.globalAlpha = 1;
    const {w, h} = size();
    const [x0, y0] = toImage(0, 0), [x1, y1] = toImage(w, h);
    // The overview only helps when part of the page is out of view.
    minimap.hidden = x0 <= 0 && y0 <= 0 && x1 >= page.width && y1 >= page.height;
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
    if (!s || scene.tool !== 'select') return null;
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
    if (!s) return null;
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

  // Pointer handling ------------------------------------------------------

  canvas.addEventListener('pointerdown', event => {
    if (!host.scene().page) return;
    cancelAnimationFrame(animation);
    wrap.focus({preventScroll: true});
    const screen = eventPoint(event);
    const p = toImage(...screen);
    const tool = host.scene().tool;
    canvas.setPointerCapture(event.pointerId);
    if (event.button === 1 || spaceDown) {
      gesture = {kind: 'pan', origin: screen, view: {...view}, moved: true};
      wrap.dataset.panning = '';
      return;
    }
    if (event.button !== 0) return;
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
      if (scene.page && scene.tool === 'select') {
        setHover(hitSpikelet(cursor)?.uid ?? null);
        if (hitHandle(cursor)) wrap.dataset.handle = '';
        else delete wrap.dataset.handle;
      } else if (hoverUid) setHover(null);
      if (scene.draft || scene.ruler?.length === 1) requestRender();
      return;
    }
    const moved = distance(screen, gesture.origin) > DRAG_PX;
    if (moved && !gesture.moved) {
      gesture.moved = true;
      if (gesture.kind === 'vertex') host.beginVertexDrag(gesture.s, gesture.handleKind);
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
    const tool = host.scene().tool;
    if (g.kind === 'vertex' && g.moved) host.endVertexDrag(g.s, g.handleKind);
    else if (g.kind === 'box' && g.moved) {
      const x0 = Math.min(g.start[0], g.current[0]), x1 = Math.max(g.start[0], g.current[0]);
      const y0 = Math.min(g.start[1], g.current[1]), y1 = Math.max(g.start[1], g.current[1]);
      const inside = host.scene().spikelets.filter(s => {
        const b = bounds(s.polygon);
        const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
        return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
      });
      host.selectMany(inside.map(s => s.uid));
    } else if (g.kind === 'click' || (g.kind === 'vertex' && !g.moved) || (g.kind === 'box' && !g.moved)) {
      const p = g.point ?? toImage(...g.origin);
      if (tool === 'select') {
        const s = hitSpikelet(p);
        host.select(s?.uid ?? null, {additive: g.additive || g.kind === 'box'});
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
    } else {
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
    get view() { return {...view}; },
    get hoverUid() { return hoverUid; }
  };
}

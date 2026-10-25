// Canvas viewer: pan / zoom, layered drawing, hit testing and pointer editing.
//
// The viewer never mutates data itself. It reads a scene from `host.scene()`
// and reports intents (select, move a vertex, finish a drawing) back to the host.

import {bounds, distance, nearestOnPath, nearestVertex, pointInPolygon, polygonArea} from './geometry.mjs';

const HANDLE_PX = 8;
const DRAG_PX = 3;
const MIN_SCALE = 0.02;
const MAX_SCALE = 40;

export function createViewer(canvas, host) {
  const ctx = canvas.getContext('2d');
  const view = {scale: 1, tx: 0, ty: 0};
  let frame = 0;
  let gesture = null; // {kind: 'pan' | 'vertex' | 'box' | 'click', ...}
  let cursor = null; // image coordinates
  let spaceDown = false;
  let fitted = null; // page id the view was last fitted to

  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const size = () => ({w: canvas.clientWidth, h: canvas.clientHeight});
  const toImage = (sx, sy) => [(sx - view.tx) / view.scale, (sy - view.ty) / view.scale];
  const toScreen = ([x, y]) => [x * view.scale + view.tx, y * view.scale + view.ty];
  const eventPoint = event => {
    const rect = canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };

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

  function fitBox(box, padding = 0.04) {
    const {w, h} = size();
    if (!w || !h) return;
    const bw = Math.max(1, box.x1 - box.x0), bh = Math.max(1, box.y1 - box.y0);
    const scale = Math.min(w / bw, h / bh) * (1 - 2 * padding);
    setView(scale, w / 2 - ((box.x0 + box.x1) / 2) * scale, h / 2 - ((box.y0 + box.y1) / 2) * scale);
  }

  function fit() {
    const page = host.scene().page;
    if (page) fitBox({x0: 0, y0: 0, x1: page.width, y1: page.height}, 0.02);
  }

  function zoomAt(factor, sx, sy) {
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
    if (!page) return;
    if (fitted !== page.id) {
      fitted = page.id;
      fit();
    }
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.tx, dpr * view.ty);
    const px = 1 / view.scale; // one screen pixel in image units

    ctx.fillStyle = css('--surface');
    ctx.fillRect(0, 0, page.width, page.height);
    if (layers.photo && image) {
      ctx.imageSmoothingEnabled = view.scale < 2;
      ctx.drawImage(image, 0, 0, page.width, page.height);
    }
    if (layers.dim) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillRect(0, 0, page.width, page.height);
    }

    const color = status => css(`--st-${status}`) || '#888';
    const selected = scene.selected;
    for (const s of scene.spikelets) {
      const status = scene.statusOf(s);
      const isSelected = selected.has(s.uid);
      if (layers.outlines || isSelected) {
        tracePath(s.polygon, true);
        if (isSelected) {
          ctx.fillStyle = color(status) + '33';
          ctx.fill();
        }
        ctx.strokeStyle = color(status);
        ctx.globalAlpha = isSelected ? 1 : 0.75;
        ctx.lineWidth = (isSelected ? 2 : 1.2) * px;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (layers.candidates || (isSelected && scene.showCandidatesOfSelected)) {
        s.candidates.forEach((c, k) => {
          if (k === s.rep) return;
          if (c.score !== null && c.score < scene.threshold) return;
          tracePath(c.path);
          ctx.setLineDash([4 * px, 3 * px]);
          ctx.strokeStyle = k === scene.candidateCursor?.(s) ? css('--focus') : '#5b6b8c';
          ctx.lineWidth = 1.5 * px;
          ctx.stroke();
          ctx.setLineDash([]);
        });
      }
      if ((layers.paths || isSelected) && s.line.length >= 2) {
        tracePath(s.line);
        ctx.lineCap = ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.lineWidth = (isSelected ? 5 : 3.5) * px;
        ctx.stroke();
        ctx.strokeStyle = isSelected ? '#ffd23f' : '#f2b705';
        ctx.lineWidth = (isSelected ? 2.5 : 1.8) * px;
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
    if (ruler?.length) drawMeasureLine(ruler, css('--focus'), px);
    if (scene.draft) drawDraft(scene.draft, px);
    if (gesture?.kind === 'box' && gesture.moved) {
      const [x0, y0] = gesture.start, [x1, y1] = gesture.current;
      ctx.setLineDash([5 * px, 4 * px]);
      ctx.strokeStyle = css('--focus');
      ctx.lineWidth = px;
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.setLineDash([]);
    }

    if (layers.labels) drawLabels(scene, dpr);
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
  }

  function drawDraft(draft, px) {
    const pts = cursor ? [...draft.points, cursor] : draft.points;
    if (pts.length) {
      tracePath(pts, draft.kind === 'spikelet' && pts.length > 2);
      ctx.strokeStyle = draft.kind === 'spikelet' ? css('--accent') : '#ffd23f';
      ctx.lineWidth = 2 * px;
      ctx.setLineDash([6 * px, 4 * px]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    drawHandles(draft.points, css('--accent'), px, 3.5);
  }

  function drawLabels(scene, dpr) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const {w, h} = size();
    for (const s of scene.spikelets) {
      const b = bounds(s.polygon);
      const [sx, sy] = toScreen([(b.x0 + b.x1) / 2, b.y1]);
      if (sx < -40 || sy < -20 || sx > w + 40 || sy > h + 20) continue;
      const text = scene.labelOf(s);
      const tw = ctx.measureText(text).width + 8;
      const y = sy + 10;
      ctx.fillStyle = scene.selected.has(s.uid) ? '#111' : 'rgba(20,20,20,0.72)';
      ctx.beginPath();
      ctx.roundRect(sx - tw / 2, y - 8, tw, 16, 4);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(text, sx - tw / 2 + 4, y);
    }
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

  // Pointer handling ------------------------------------------------------

  canvas.addEventListener('pointerdown', event => {
    if (!host.scene().page) return;
    canvas.parentElement.focus({preventScroll: true});
    const screen = eventPoint(event);
    const p = toImage(...screen);
    const tool = host.scene().tool;
    canvas.setPointerCapture(event.pointerId);
    if (event.button === 1 || spaceDown) {
      gesture = {kind: 'pan', origin: screen, view: {...view}, moved: false};
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
      if (host.scene().draft || host.scene().ruler?.length === 1) requestRender();
      return;
    }
    const moved = distance(screen, gesture.origin) > DRAG_PX;
    if (moved && !gesture.moved) {
      gesture.moved = true;
      if (gesture.kind === 'vertex') host.beginVertexDrag(gesture.s, gesture.handleKind);
      if (gesture.kind === 'click') {
        gesture.kind = 'pan';
        canvas.parentElement.dataset.panning = '';
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
    delete canvas.parentElement.dataset.panning;
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
      } else {
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
    requestRender();
  });

  window.addEventListener('keydown', event => {
    if (event.code === 'Space' && !event.repeat && document.activeElement === canvas.parentElement) {
      spaceDown = true;
      event.preventDefault();
    }
  });
  window.addEventListener('keyup', event => {
    if (event.code === 'Space') spaceDown = false;
  });
  new ResizeObserver(requestRender).observe(canvas);

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
    get view() { return {...view}; }
  };
}

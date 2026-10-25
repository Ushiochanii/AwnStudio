import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

import * as cal from '../js/calibration.mjs';
import * as edits from '../js/edits.mjs';
import {bounds, nearestOnPath, parseWktRings, pathLength, pointInPolygon, readingOrder, simplify} from '../js/geometry.mjs';
import {createHistory} from '../js/history.mjs';
import {calibrationFromResult, newManualSpikelet, spikeletsFromResult, validName} from '../js/result.mjs';
import {canConfirm, FILTERS, reviewReasons, reviewStatus, STATUS} from '../js/review.mjs';

const square = [[0, 0], [10, 0], [10, 10], [0, 10]];

function serviceResult() {
  return {
    page_id: 'P', method: 'pfg_assembly', x_period_px: 50, y_period_px: 40, meta: {},
    spikelets: [
      {
        id: 'S001', geometry_wkt: 'POLYGON ((100 100, 120 100, 120 140, 100 140, 100 100))', representative: 1,
        meta: {confidence: 0.9},
        awns: [
          {path_px: [[110, 100], [110, 80]], length_mm: 2.5, complete: true, score: 0.4, meta: {hops: 0, gaps: 0}},
          {path_px: [[110, 100], [110, 50], [111, 20]], length_mm: 10, complete: true, score: 0.9, meta: {hops: 1, gaps: 0}}
        ]
      },
      {
        id: 'S000', geometry_wkt: 'MULTIPOLYGON (((10 10, 12 10, 12 12, 10 10)), ((0 100, 30 100, 30 160, 0 160, 0 100), (5 105, 6 105, 6 106, 5 105)))',
        representative: null, meta: {confidence: 0.3}, awns: []
      }
    ]
  };
}

test('WKT parsing keeps exterior rings and drops the closing vertex and holes', () => {
  const rings = parseWktRings('MULTIPOLYGON (((0 0, 4 0, 4 4, 0 0)), ((10 10, 20 10, 20 20, 10 20, 10 10), (12 12, 13 12, 13 13, 12 12)))');
  assert.equal(rings.length, 2);
  assert.deepEqual(rings[1], [[10, 10], [20, 10], [20, 20], [10, 20]]);
  assert.deepEqual(parseWktRings('POINT (1 2)'), []);
});

test('geometry helpers', () => {
  assert.equal(pathLength([[0, 0], [3, 4], [3, 10]]), 11);
  assert.ok(pointInPolygon([5, 5], square));
  assert.ok(!pointInPolygon([15, 5], square));
  assert.deepEqual(bounds(square), {x0: 0, y0: 0, x1: 10, y1: 10});
  const near = nearestOnPath(square, [5, -2], true);
  assert.equal(near.index, 0);
  assert.equal(near.distance, 2);
  assert.deepEqual(simplify([[0, 0], [1, 0.4], [2, 0], [3, 5]], 1), [[0, 0], [2, 0], [3, 5]]);
});

test('reading order groups rows top to bottom, left to right', () => {
  const box = (x, y) => ({polygon: [[x, y], [x + 10, y], [x + 10, y + 40], [x, y + 40]], id: `${x},${y}`});
  const items = [box(200, 5), box(0, 0), box(100, 300), box(100, -3), box(0, 310)];
  assert.deepEqual(readingOrder(items).map(i => i.id), ['0,0', '100,-3', '200,5', '0,310', '100,300']);
});

test('lengths match the service: DP 1 px then anisotropic arc length', () => {
  const c = cal.fromGrid({x_period_px: 50, y_period_px: 40});
  assert.deepEqual(c.mmPerPx, [0.1, 0.125]);
  const path = [[0, 0], [0, 40], [0.4, 40.5], [30, 40]];
  // DP removes the 0.5 px wiggle: 40 px down (5 mm) then 30 px across (3 mm).
  assert.ok(Math.abs(cal.lengthMm(path, c) - 8) < 1e-9);
  assert.equal(cal.lengthMm([[0, 0]], c), null);
  assert.equal(cal.lengthMm(path, null), null);
});

test('two-point and ratio calibrations are isotropic and validated', () => {
  const c = cal.fromTwoPoints([[0, 0], [30, 40]], 10);
  assert.deepEqual(c.mmPerPx, [0.2, 0.2]);
  assert.equal(cal.describe(c), '0.20000 mm/px');
  assert.throws(() => cal.fromTwoPoints([[1, 1], [1, 1]], 10));
  assert.throws(() => cal.fromRatio(0));
  const periods = cal.servicePeriods(cal.fromRatio(0.1));
  assert.deepEqual(periods, {x_period_px: 50, y_period_px: 50});
});

test('service results become editable spikelets in reading order', () => {
  const records = spikeletsFromResult(serviceResult());
  assert.deepEqual(records.map(r => [r.uid, r.name]), [['S001', '2'], ['S000', '1']]);
  const [a, b] = records;
  assert.equal(a.rep, 1);
  assert.equal(a.autoRep, 1);
  assert.deepEqual(a.line, [[110, 100], [110, 50], [111, 20]]);
  assert.equal(b.polygon.length, 4, 'largest ring of the multipolygon');
  assert.deepEqual(b.line, []);
  const c = calibrationFromResult(serviceResult());
  assert.equal(c.method, 'grid');
  assert.deepEqual(c.periodsPx, [50, 40]);
});

test('review status and reasons', () => {
  const [a, b] = spikeletsFromResult(serviceResult());
  assert.equal(reviewStatus(a), STATUS.automatic);
  assert.deepEqual(reviewReasons(a, {threshold: 0.95}), ['low_score']);
  assert.equal(reviewStatus(a, {threshold: 0.95}), STATUS.needsReview);
  assert.equal(reviewStatus(b), STATUS.missing);
  assert.ok(reviewReasons(b).includes('weak_spikelet'));
  assert.ok(!canConfirm(b));
  a.confirmed = true;
  assert.equal(reviewStatus(a), STATUS.confirmed);
  assert.deepEqual(reviewReasons(a, {calibration: {adequate: false}}), ['calibration_qc']);
  assert.ok(FILTERS.needs_review(STATUS.missing));
  assert.ok(!FILTERS.pending(STATUS.confirmed));
});

test('editing marks a record edited, clears confirmation and can be restored', () => {
  const [a] = spikeletsFromResult(serviceResult());
  a.confirmed = true;
  edits.prepare(a, 'line');
  assert.ok(edits.moveVertex(a, 'line', a.line.length - 1, [111, 10]));
  assert.equal(a.modified, true);
  assert.equal(a.confirmed, false);
  assert.equal(reviewStatus(a), STATUS.modified);
  edits.insertVertex(a, 'polygon', 1, [110, 99]);
  assert.equal(a.polygon.length, 5);
  assert.ok(a.autoPolygon, 'automatic outline is kept for restore');
  assert.ok(edits.removeVertex(a, 'polygon', 1));
  assert.ok(edits.restoreAutomatic(a));
  assert.equal(a.modified, false);
  assert.deepEqual(a.line, a.candidates[1].path);
  assert.equal(a.polygon.length, 4);
});

test('a line cannot lose its last two vertices, a polygon its last three', () => {
  const s = newManualSpikelet([], square);
  edits.setLine(s, [[0, 0], [0, 0.2], [5, 5]]);
  assert.deepEqual(s.line, [[0, 0], [5, 5]], 'double-click duplicates are removed');
  assert.equal(edits.removeVertex(s, 'line', 0), false);
  assert.equal(edits.removeVertex(s, 'polygon', 0), true);
  assert.equal(edits.removeVertex(s, 'polygon', 0), false);
});

test('choosing another candidate is an edit unless it is the automatic one', () => {
  const [a] = spikeletsFromResult(serviceResult());
  edits.useCandidate(a, 0);
  assert.equal(a.modified, true);
  assert.deepEqual(a.line, [[110, 100], [110, 80]]);
  edits.useCandidate(a, 1);
  assert.equal(a.modified, false);
});

test('dense automatic geometry is reduced once for editing', () => {
  const dense = Array.from({length: 200}, (_, i) => [i, i % 2 ? 0.3 : 0]);
  const s = {line: dense, polygon: square, origin: 'auto'};
  const points = edits.editPoints(s, 'line');
  assert.equal(points.length, 2);
  assert.equal(edits.editPoints(s, 'line'), points, 'cached');
  edits.prepare(s, 'line');
  assert.equal(s.line.length, 2);
  assert.equal(edits.editPoints(s, 'line'), s.line);
  assert.ok(!('reducedCache' in edits.persistable(s)));
});

test('manual spikelets get the first free numeric ID; IDs must be unique', () => {
  const list = [{uid: 'a', name: '1'}, {uid: 'b', name: '3'}];
  const s = newManualSpikelet(list, square);
  assert.equal(s.name, '2');
  assert.equal(s.origin, 'manual');
  assert.ok(validName(' 7 ', list, 'a'));
  assert.ok(!validName('3', list, 'a'));
  assert.ok(validName('3', list, 'b'));
  assert.ok(!validName('  ', list, 'a'));
});

test('history undo / redo with a bounded past', () => {
  const h = createHistory({limit: 2});
  h.checkpoint(1);
  h.checkpoint(2);
  h.checkpoint(3);
  assert.deepEqual(h.sizes, {past: 2, future: 0});
  assert.equal(h.undo(4), 3);
  assert.equal(h.undo(3), 2);
  assert.equal(h.undo(2), null);
  assert.equal(h.redo(2), 3);
  h.checkpoint(9);
  assert.equal(h.canRedo, false);
});

test('a real cached service result parses when available', {skip: !process.env.AWNSTUDIO_SAMPLE}, () => {
  const data = JSON.parse(readFileSync(process.env.AWNSTUDIO_SAMPLE, 'utf8'));
  const records = spikeletsFromResult(data);
  const c = calibrationFromResult(data);
  assert.equal(records.length, data.spikelets.length);
  for (const r of records) for (const k of r.candidates) assert.ok(Math.abs(cal.lengthMm(k.path, c) - k.serviceMm) < 1e-6);
});

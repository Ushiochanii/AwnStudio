import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import test from 'node:test';

import {createApi} from '../js/api.mjs';
import * as cal from '../js/calibration.mjs';
import {crc32, csvName, detailedCsv, DETAILED_HEADER, exportablePages, simpleCsv, zip} from '../js/export.mjs';
import {keys, setLocale, t} from '../js/i18n.mjs';
import {buildProject, parseProject, SCHEMA, serializePage} from '../js/project.mjs';
import {spikeletsFromResult} from '../js/result.mjs';
import {DEFAULTS, loadSettings, normalizeSettings} from '../js/settings.mjs';
import {createAutosave} from '../js/store.mjs';

const WEB = new URL('../', import.meta.url);

function page(overrides = {}) {
  const spikelets = spikeletsFromResult({
    x_period_px: 50, y_period_px: 50,
    spikelets: [
      {id: 'S0', geometry_wkt: 'POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))', representative: 0, meta: {},
        awns: [{path_px: [[5, 0], [5, 100]], length_mm: 10, score: 0.9, meta: {}}]},
      {id: 'S1', geometry_wkt: 'POLYGON ((50 0, 60 0, 60 10, 50 10, 50 0))', representative: null, meta: {}, awns: []}
    ]
  });
  return {id: 'p1', name: 'IMG_1.JPG', width: 200, height: 200, calibration: cal.fromRatio(0.1), run: {method: 'pfg_assembly'}, spikelets, ...overrides};
}

test('simple CSV: BOM, header, blank missing lengths, formula-safe IDs', () => {
  const p = page();
  p.spikelets[1].name = '=SUM(A1)';
  const text = simpleCsv(p);
  assert.ok(text.startsWith('﻿"ID","Awn length (mm)"\r\n'));
  assert.ok(text.includes('"1","10.000"'));
  assert.ok(text.includes(`"'=SUM(A1)",""`));
});

test('detailed CSV keeps the automatic length after an edit', () => {
  const p = page();
  const s = p.spikelets[0];
  s.line = [[5, 0], [5, 50]];
  s.modified = true;
  s.rep = null;
  const lines = detailedCsv([p, {...page(), id: 'empty', spikelets: []}]).slice(1).split('\r\n');
  assert.equal(lines[0], DETAILED_HEADER.map(h => `"${h}"`).join(','));
  assert.equal(lines.length, 3, 'empty pages are not exported');
  assert.match(lines[1], /^"IMG_1.JPG","1","10.000","5.000","5.000","false","modified"/);
});

test('CSV names are unique and filesystem-safe', () => {
  const used = new Set();
  assert.equal(csvName({name: 'a/b.jpg'}, used), 'a_b.csv');
  assert.equal(csvName({name: 'a/b.png'}, used), 'a_b_2.csv');
  assert.equal(exportablePages([page(), {spikelets: []}]).length, 1);
});

test('zip writes stored entries with correct CRC and directory', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const bytes = zip([{name: 'a.csv', content: 'x'}, {name: '图.csv', content: 'yz'}]);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 2);
});

test('project round trip and validation', () => {
  const p = page();
  const project = buildProject([serializePage(p, 'data:image/jpeg;base64,AAAA')]);
  assert.equal(project.schema, SCHEMA);
  const parsed = parseProject(JSON.parse(JSON.stringify(project)));
  assert.equal(parsed.pages[0].spikelets.length, 2);
  const bad = structuredClone(project);
  bad.pages[0].spikelets[1].name = '1';
  assert.throws(() => parseProject(bad), /duplicate ID/);
  const outside = structuredClone(project);
  outside.pages[0].spikelets[0].line = [[0, 0], [500, 0]];
  assert.throws(() => parseProject(outside), /measurement path/);
  assert.throws(() => parseProject({schema: 'other'}), /Not an AwnStudio project/);
});

test('settings are normalized against defaults', () => {
  const s = normalizeSettings({language: 'xx', threshold: 3, layers: {photo: false, bogus: 1}, autoCalibrate: 'yes'});
  assert.equal(s.language, DEFAULTS.language);
  assert.equal(s.threshold, DEFAULTS.threshold);
  assert.equal(s.layers.photo, false);
  assert.ok(!('bogus' in s.layers));
  assert.equal(s.autoCalibrate, DEFAULTS.autoCalibrate);
  const storage = {getItem: () => '{broken'};
  assert.equal(loadSettings(storage, 'zh').language, 'zh');
  assert.equal(loadSettings({getItem: () => null}, 'zh').language, 'zh');
});

test('every locale key exists in English and every used key is translated', () => {
  const en = new Set(keys('en'));
  for (const locale of ['zh', 'ja']) for (const key of keys(locale)) assert.ok(en.has(key), `${locale}: ${key}`);
  const used = new Set();
  const html = readFileSync(new URL('index.html', WEB), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-title|-placeholder)?="([^"]+)"/g)) used.add(m[1]);
  for (const file of readdirSync(new URL('js/', WEB))) {
    const src = readFileSync(new URL(`js/${file}`, WEB), 'utf8');
    for (const m of src.matchAll(/\bt\('([a-zA-Z_.]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/label: '([a-zA-Z_.]+)'/g)) used.add(m[1]);
  }
  // Keys built from a prefix at run time.
  for (const status of ['automatic', 'needs_review', 'modified', 'confirmed', 'missing']) used.add(`status.${status}`);
  for (const reason of ['calibration_qc', 'weak_spikelet', 'low_score', 'gap_bridged', 'long_chain']) used.add(`reason.${reason}`);
  for (const stage of ['queued', 'loading', 'calibrate', 'detect', 'reconstruct']) used.add(`job.stage.${stage}`);
  for (const locale of ['zh', 'ja']) {
    const have = new Set(keys(locale));
    for (const key of used) {
      assert.ok(en.has(key), `missing English copy: ${key}`);
      assert.ok(have.has(key), `missing ${locale} copy: ${key}`);
    }
  }
  setLocale('zh');
  assert.equal(t('images.measured', {n: 3}), '3 个小穗');
  setLocale('ja');
  assert.equal(t('images.measured', {n: 3}), '小穂 3');
  assert.equal(t('no.such.key'), 'no.such.key');
  setLocale('en');
});

test('index.html references only existing modules and ids used by the app', () => {
  const html = readFileSync(new URL('index.html', WEB), 'utf8');
  const app = readFileSync(new URL('js/app.mjs', WEB), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  for (const m of app.matchAll(/\$\('#([\w-]+)'\)/g)) assert.ok(ids.has(m[1]), `#${m[1]} missing from index.html`);
  for (const m of html.matchAll(/(?:src|href)="((?:js|assets)\/[^"]+|styles\.css)"/g)) {
    assert.doesNotThrow(() => readFileSync(new URL(m[1], WEB)), m[1]);
  }
});

test('api client follows a job to completion', async () => {
  const calls = [];
  const states = [{state: 'queued'}, {state: 'running', stage: 'detect', progress: 0.5}, {state: 'done', result: {ok: 1}}];
  const fetchImpl = async (url, init) => {
    calls.push([init.method, url]);
    const body = url.includes('/api/jobs?') ? {id: 'j1'} : states.shift();
    return {ok: true, status: 200, text: async () => JSON.stringify(body)};
  };
  const api = createApi({base: 'http://h', fetchImpl, sleep: async () => {}});
  const seen = [];
  const job = await api.measure(new Blob(['x'], {type: 'image/jpeg'}), {
    name: 'a b.jpg', periods: {x_period_px: 50, y_period_px: 51}, onProgress: j => seen.push(j.state)
  });
  assert.deepEqual(job.result, {ok: 1});
  assert.deepEqual(seen, ['queued', 'running', 'done']);
  assert.deepEqual(calls[0], ['POST', 'http://h/api/jobs?name=a+b.jpg&x_period_px=50&y_period_px=51']);
});

test('api client surfaces service errors', async () => {
  const fetchImpl = async () => ({ok: false, status: 503, text: async () => '{"error":"no model"}'});
  await assert.rejects(createApi({fetchImpl}).health(), /no model/);
  const failing = async (url) => ({ok: true, status: 200, text: async () => JSON.stringify(url.includes('?') ? {id: 'j'} : {state: 'error', error: 'boom'})});
  await assert.rejects(createApi({fetchImpl: failing, sleep: async () => {}}).measure(new Blob(['x'])), /boom/);
});

test('autosave coalesces writes per page', async () => {
  const written = [];
  const autosave = createAutosave(async record => written.push(record), 5);
  autosave.schedule('a', () => 1);
  autosave.schedule('a', () => 2);
  autosave.schedule('b', () => 3);
  autosave.cancel('b');
  await autosave.flush();
  assert.deepEqual(written, [2]);
});

test('exported rows follow natural ID order', () => {
  const p = page();
  p.spikelets[0].name = '10';
  p.spikelets[1].name = '2';
  const ids = simpleCsv(p).split('\r\n').slice(1).map(line => line.split(',')[0]);
  assert.deepEqual(ids, ['"2"', '"10"']);
});

test('summary CSV has one row of statistics per measured image', async () => {
  const {summaryCsv, SUMMARY_HEADER} = await import('../js/export.mjs');
  const lines = summaryCsv([page()]).slice(1).split('\r\n');
  assert.equal(lines[0], SUMMARY_HEADER.map(h => `"${h}"`).join(','));
  assert.equal(lines[1], '"IMG_1.JPG","2","1","0","10.000","","10.000","10.000","10.000"');
});


test('the length protocol applies to untouched automatic paths only', async () => {
  const cal = await import('../js/calibration.mjs');
  const p = page({run: {method: 'pfg_assembly', protocol: {intercept: 1, slope: 0.5, n: 10}}});
  const [auto, missing] = p.spikelets;
  assert.equal(cal.spikeletLength(auto, p), 6);
  assert.equal(cal.spikeletLength(auto, p, {protocol: false}), 10);
  assert.equal(cal.spikeletLength(missing, p), null);
  assert.ok(simpleCsv(p).includes('"1","6.000"'));
  assert.ok(simpleCsv(p, {protocol: false}).includes('"1","10.000"'));
  auto.reduced = {line: true};
  assert.equal(cal.spikeletLength(auto, p), 10, 'an edited path is reported as measured');
});

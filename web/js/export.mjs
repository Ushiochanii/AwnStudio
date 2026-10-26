// CSV and ZIP export. Lengths always come from the page's current calibration.

import {lengthMm} from './calibration.mjs';
import {representative} from './result.mjs';
import {reviewReasons, reviewStatus} from './review.mjs';
import {summarize} from './stats.mjs';

// Cells that a spreadsheet would evaluate as a formula are prefixed with '.
const safe = value => {
  const text = String(value ?? '');
  return /^[\s]*[=+@-]/.test(text) ? "'" + text : text;
};
const quote = value => '"' + safe(value).replaceAll('"', '""') + '"';
const row = cells => cells.map(quote).join(',');
const mm = value => (value === null || value === undefined ? '' : value.toFixed(3));
const BOM = '﻿';

// Rows follow the spikelet IDs in natural order (2 before 10).
const collator = new Intl.Collator(undefined, {numeric: true});
export const ordered = page => [...page.spikelets].sort((a, b) => collator.compare(a.name, b.name));

export function simpleCsv(page) {
  const lines = [row(['ID', 'Awn length (mm)'])];
  for (const s of ordered(page)) lines.push(row([s.name, mm(lengthMm(s.line, page.calibration))]));
  return BOM + lines.join('\r\n');
}

export const DETAILED_HEADER = [
  'Image', 'ID', 'Automatic awn length (mm)', 'Final awn length (mm)', 'Review status', 'Review reasons',
  'Awn score', 'Candidates', 'Modified', 'Confirmed', 'Origin', 'Calibration', 'mm/px x', 'mm/px y', 'Method'
];

export function detailedRows(page, options = {}) {
  const calibration = page.calibration;
  return ordered(page).map(s => {
    const rep = representative(s);
    const auto = s.autoRep === null || s.autoRep === undefined ? null : s.candidates[s.autoRep];
    const context = {...options, calibration};
    return [
      page.name,
      s.name,
      mm(auto ? lengthMm(auto.path, calibration) : null),
      mm(lengthMm(s.line, calibration)),
      reviewStatus(s, context),
      reviewReasons(s, context).join('; '),
      rep?.score == null ? '' : rep.score.toFixed(4),
      s.candidates.length,
      s.modified ? 'true' : 'false',
      s.confirmed ? 'true' : 'false',
      s.origin,
      calibration?.method ?? '',
      calibration ? calibration.mmPerPx[0].toPrecision(6) : '',
      calibration ? calibration.mmPerPx[1].toPrecision(6) : '',
      page.run?.method ?? ''
    ];
  });
}

export function detailedCsv(pages, options) {
  const lines = [row(DETAILED_HEADER)];
  for (const page of exportablePages(pages)) for (const cells of detailedRows(page, options)) lines.push(row(cells));
  return BOM + lines.join('\r\n');
}

// Pages that hold measurement records; empty pages are not exported as fake files.
export const exportablePages = pages => pages.filter(p => p.spikelets.length > 0);

export function csvName(page, used = new Set()) {
  const base = page.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_') || 'image';
  let name = `${base}.csv`, n = 2;
  while (used.has(name)) name = `${base}_${n++}.csv`;
  used.add(name);
  return name;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Uncompressed ZIP with UTF-8 names; returns bytes.
export function zip(files) {
  const encoder = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = typeof file.content === 'string' ? encoder.encode(file.content) : file.content;
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const entry = new Uint8Array(46 + name.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    entry.set(name, 46);
    parts.push(local, data);
    central.push(entry);
    offset += local.length + data.length;
  }
  const size = central.reduce((s, e) => s + e.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + size + 22);
  let at = 0;
  for (const part of [...parts, ...central, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export const SUMMARY_HEADER = ['Image', 'Spikelets', 'Measured', 'Confirmed', 'Mean (mm)', 'SD (mm)', 'Median (mm)', 'Min (mm)', 'Max (mm)'];

// One row per image with descriptive statistics of the final awn lengths.
export function summaryCsv(pages, options = {}) {
  const lines = [row(SUMMARY_HEADER)];
  for (const page of exportablePages(pages)) {
    const stats = summarize(page.spikelets.map(s => lengthMm(s.line, page.calibration)).filter(v => v !== null));
    const confirmed = page.spikelets.filter(s => reviewStatus(s, {...options, calibration: page.calibration}) === 'confirmed').length;
    lines.push(row([page.name, page.spikelets.length, stats.n, confirmed, mm(stats.mean), mm(stats.sd), mm(stats.median), mm(stats.min), mm(stats.max)]));
  }
  return BOM + lines.join('\r\n');
}

// Project files: a self-contained JSON backup with embedded images.

import {isValid} from './calibration.mjs';

export const SCHEMA = 'awnstudio-project-v1';

const PAGE_FIELDS = ['id', 'name', 'width', 'height', 'calibration', 'run', 'spikelets', 'measuredAt'];

export function serializePage(page, image) {
  const out = {};
  for (const key of PAGE_FIELDS) out[key] = page[key] ?? null;
  out.spikelets = page.spikelets ?? [];
  out.image = image;
  return out;
}

export function buildProject(pages) {
  return {schema: SCHEMA, savedAt: new Date().toISOString(), pages};
}

const finitePoint = (p, w, h) =>
  Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && p[0] >= -1 && p[1] >= -1 && p[0] <= w + 1 && p[1] <= h + 1;

function checkPage(page, ids) {
  const fail = message => { throw new Error(`${page?.name ?? page?.id ?? 'page'}: ${message}`); };
  if (typeof page?.id !== 'string' || !page.id || ids.has(page.id)) fail('missing or duplicate id');
  ids.add(page.id);
  if (typeof page.name !== 'string') fail('missing name');
  if (!Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0) fail('invalid size');
  if (!/^data:image\/(png|jpeg|webp|bmp|tiff);base64,/.test(page.image ?? '')) fail('missing embedded image');
  if (page.calibration !== null && page.calibration !== undefined && !isValid(page.calibration)) fail('invalid calibration');
  if (!Array.isArray(page.spikelets)) fail('missing spikelets');
  const points = list => Array.isArray(list) && list.every(p => finitePoint(p, page.width, page.height));
  const names = new Set(), uids = new Set();
  for (const s of page.spikelets) {
    if (typeof s.uid !== 'string' || uids.has(s.uid)) fail('duplicate spikelet uid');
    if (typeof s.name !== 'string' || !s.name.trim() || names.has(s.name)) fail(`invalid or duplicate ID "${s.name}"`);
    if (!points(s.polygon) || s.polygon.length < 3) fail(`invalid outline for ${s.name}`);
    if (!points(s.line) || s.line.length === 1) fail(`invalid measurement path for ${s.name}`);
    if (!Array.isArray(s.candidates) || s.candidates.some(c => !points(c.path))) fail(`invalid candidates for ${s.name}`);
    if (s.rep !== null && !(Number.isInteger(s.rep) && s.candidates[s.rep])) fail(`invalid representative for ${s.name}`);
    uids.add(s.uid);
    names.add(s.name);
  }
}

export function parseProject(data) {
  if (data?.schema !== SCHEMA) throw new Error('Not an AwnStudio project file.');
  if (!Array.isArray(data.pages)) throw new Error('Project has no images.');
  const ids = new Set();
  for (const page of data.pages) checkPage(page, ids);
  return data;
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function dataUrlToBlob(url) {
  return (await fetch(url)).blob();
}

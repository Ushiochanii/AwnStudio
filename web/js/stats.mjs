// Descriptive statistics of awn lengths for the results panel.

export function summarize(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = v.length;
  if (!n) return {n: 0, mean: null, sd: null, median: null, min: null, max: null};
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : null;
  const mid = n >> 1;
  const median = n % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return {n, mean, sd, median, min: v[0], max: v[n - 1]};
}

// A "nice" bin width (1, 2 or 5 x 10^k) giving roughly `target` bins.
export function niceStep(span, target = 12) {
  if (!(span > 0)) return 1;
  const raw = span / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map(m => m * magnitude).find(step => step >= raw);
}

// Bins aligned to multiples of the step; returns [{x0, x1, count}].
export function histogram(values, target = 12) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return [];
  const min = Math.min(...v), max = Math.max(...v);
  const step = niceStep(max - min, target);
  const start = Math.floor(min / step) * step;
  const count = Math.max(1, Math.floor((max - start) / step) + 1);
  const bins = Array.from({length: count}, (_, i) => ({x0: start + i * step, x1: start + (i + 1) * step, count: 0}));
  for (const x of v) bins[Math.min(count - 1, Math.floor((x - start) / step))].count++;
  return bins;
}

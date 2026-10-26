// Client for the local AwnStudio service (service/server.py).

export function createApi({base = '', fetchImpl = (...args) => fetch(...args), pollMs = 500, sleep} = {}) {
  const wait = sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const url = (path, query) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== null && v !== undefined) params.set(k, String(v));
    const q = params.toString();
    return `${base}${path}${q ? '?' + q : ''}`;
  };
  async function send(path, {method = 'GET', body, query, type} = {}) {
    const response = await fetchImpl(url(path, query), {method, body, headers: type ? {'Content-Type': type} : undefined});
    if (!response.ok) {
      const text = await response.text();
      let message = `HTTP ${response.status}`;
      try { message = JSON.parse(text).error || message; } catch { if (text) message = text; }
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return response;
  }
  async function request(path, options) {
    const text = await (await send(path, options)).text();
    return text ? JSON.parse(text) : null;
  }
  const image = blob => ({body: blob, type: blob.type || 'application/octet-stream'});

  return {
    health: () => request('/api/health'),
    models: () => request('/api/models'),
    calibrate: blob => request('/api/calibrate', {method: 'POST', ...image(blob)}),
    resolution: (blob, {force = false} = {}) => request('/api/resolution', {method: 'POST', ...image(blob), query: {force: force ? 1 : 0}}),
    resize: async (blob, scale) => (await send('/api/resize', {method: 'POST', ...image(blob), query: {scale}})).blob(),
    submit: (blob, {name, periods} = {}) => request('/api/jobs', {
      method: 'POST', ...image(blob),
      query: {name, x_period_px: periods?.x_period_px, y_period_px: periods?.y_period_px}
    }),
    job: (id, since = 0) => request(`/api/jobs/${encodeURIComponent(id)}`, {query: since ? {since} : null}),
    cancel: id => request(`/api/jobs/${encodeURIComponent(id)}`, {method: 'DELETE'}),
    samples: () => request('/api/samples'),
    sampleResult: id => request(`/api/samples/${encodeURIComponent(id)}/result`),
    sampleImageUrl: id => url(`/api/samples/${encodeURIComponent(id)}/image`),

    // Submit and follow one job to completion. `onProgress(job)` sees every
    // poll; `onEvidence(items)` receives the detection evidence found since
    // the previous poll (live preview).
    async measure(blob, {name, periods, onProgress, onEvidence, signal} = {}) {
      const {id} = await this.submit(blob, {name, periods});
      let since = 0;
      for (;;) {
        const job = await this.job(id, since);
        if (job.evidence?.length) {
          since = (job.evidence_from ?? since) + job.evidence.length;
          onEvidence?.(job.evidence);
        }
        onProgress?.(job);
        if (job.state === 'done') return job;
        if (job.state === 'error' || job.state === 'cancelled') throw new Error(job.error || `job ${job.state}`);
        if (signal?.aborted) {
          // The service stops a running job at its next progress step.
          await this.cancel(id).catch(() => {});
          throw new Error('cancelled');
        }
        await wait(pollMs);
      }
    }
  };
}

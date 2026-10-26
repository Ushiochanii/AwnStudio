// Client for the local AwnStudio service (service/server.py).

export function createApi({base = '', fetchImpl = (...args) => fetch(...args), pollMs = 700, sleep} = {}) {
  const wait = sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const url = (path, query) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== null && v !== undefined) params.set(k, String(v));
    const q = params.toString();
    return `${base}${path}${q ? '?' + q : ''}`;
  };
  async function request(path, {method = 'GET', body, query, type} = {}) {
    const response = await fetchImpl(url(path, query), {
      method, body, headers: type ? {'Content-Type': type} : undefined
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = {error: text}; }
    if (!response.ok) {
      const error = new Error(data?.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  return {
    health: () => request('/api/health'),
    calibrate: blob => request('/api/calibrate', {method: 'POST', body: blob, type: blob.type || 'application/octet-stream'}),
    submit: (blob, {name, periods} = {}) => request('/api/jobs', {
      method: 'POST', body: blob, type: blob.type || 'application/octet-stream',
      query: {name, x_period_px: periods?.x_period_px, y_period_px: periods?.y_period_px}
    }),
    job: id => request(`/api/jobs/${encodeURIComponent(id)}`),
    cancel: id => request(`/api/jobs/${encodeURIComponent(id)}`, {method: 'DELETE'}),
    samples: () => request('/api/samples'),
    sampleResult: id => request(`/api/samples/${encodeURIComponent(id)}/result`),
    sampleImageUrl: id => url(`/api/samples/${encodeURIComponent(id)}/image`),

    // Submit and follow one job to completion. `onProgress(job)` sees every poll.
    async measure(blob, {name, periods, onProgress, signal} = {}) {
      const {id} = await this.submit(blob, {name, periods});
      for (;;) {
        const job = await this.job(id);
        onProgress?.(job);
        if (job.state === 'done') return job;
        if (job.state === 'error' || job.state === 'cancelled') {
          throw new Error(job.error || `job ${job.state}`);
        }
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

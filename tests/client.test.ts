import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, apiWrite } from '../src/client';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch', () => {
  it('returns parsed JSON on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { hello: 'world' })));
    await expect(apiFetch<{ hello: string }>('/api/x')).resolves.toEqual({ hello: 'world' });
  });

  it('throws the server {error} message on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, { error: 'Widget not found' })));
    await expect(apiFetch('/api/x')).rejects.toThrow('Widget not found');
  });

  it('falls back to a status message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway timeout', { status: 502 })));
    await expect(apiFetch('/api/x')).rejects.toThrow('API /api/x responded 502');
  });
});

describe('apiWrite', () => {
  it('refreshes the touched keys after a successful write', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { ok: true })));
    const refresh = vi.fn(async () => {});
    await apiWrite('/api/x', { method: 'POST', json: { a: 1 } }, ['widgets'], refresh);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(['widgets']);
  });

  it('leaves the cache untouched on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, { error: 'nope' })));
    const refresh = vi.fn(async () => {});
    await expect(apiWrite('/api/x', { method: 'POST' }, ['widgets'], refresh)).rejects.toThrow('nope');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('skips refresh when no keys are given', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {})));
    const refresh = vi.fn(async () => {});
    await apiWrite('/api/x', { method: 'DELETE' }, [], refresh);
    expect(refresh).not.toHaveBeenCalled();
  });
});

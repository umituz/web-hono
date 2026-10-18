import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, apiFetch, apiWrite } from '../src/client';

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

  it('resolves undefined for void endpoints (204 without a body)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await expect(apiFetch('/api/x', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('resolves undefined for an empty 200 body too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    await expect(apiFetch('/api/x')).resolves.toBeUndefined();
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

describe('ApiClientError', () => {
  it('carries status, message, and the conflicts array from a 409 body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(409, { error: 'Open sub-orders', conflicts: ['SO-1', 'SO-2'] })));
    const err = await apiFetch('/api/x').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiClientError);
    const ace = err as ApiClientError;
    expect(ace.status).toBe(409);
    expect(ace.message).toBe('Open sub-orders');
    expect(ace.conflicts).toEqual(['SO-1', 'SO-2']);
    expect(ace.details).toBeUndefined();
  });

  it('exposes fieldErrors details from a validation 400', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, { error: 'Invalid payload', details: { qty: ['expected number'] } })));
    const err = await apiFetch('/api/x').then(
      () => null,
      (e: unknown) => e,
    );
    const ace = err as ApiClientError;
    expect(ace.status).toBe(400);
    expect(ace.details).toEqual({ qty: ['expected number'] });
  });

  it('falls back to a null body on non-JSON failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const err = await apiFetch('/api/x').then(
      () => null,
      (e: unknown) => e,
    );
    const ace = err as ApiClientError;
    expect(ace).toBeInstanceOf(ApiClientError);
    expect(ace.status).toBe(500);
    expect(ace.body).toBeNull();
  });
});

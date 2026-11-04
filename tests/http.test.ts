import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { CACHE_CONTROLS, internalError, requestScopeOf, respondWithEtag } from '../src/http';

function scopeApp() {
  const app = new Hono();
  app.get('/scope', (c) => c.json({ scope: requestScopeOf(c, { queryParam: 'lang', cookieKey: 'target_language' }) }));
  return app;
}

function etagApp() {
  const app = new Hono();
  app.get('/list', (c) => respondWithEtag(c, '"v1"', { items: [1, 2] }));
  app.get('/boom', (c) => internalError(c, 'sync failed', new TypeError('x is not a function')));
  return app;
}

describe('requestScopeOf', () => {
  it('prefers the query parameter', async () => {
    const res = await scopeApp().request('/scope?lang=ko', { headers: { Cookie: 'target_language=ja' } });
    expect(await res.json()).toEqual({ scope: 'ko' });
  });

  it('falls back to the cookie', async () => {
    const res = await scopeApp().request('/scope', { headers: { Cookie: 'other=1; target_language=ko' } });
    expect(await res.json()).toEqual({ scope: 'ko' });
  });

  it('returns null with neither present', async () => {
    const res = await scopeApp().request('/scope');
    expect(await res.json()).toEqual({ scope: null });
  });

  it('ignores an empty query value and uses the cookie', async () => {
    const res = await scopeApp().request('/scope?lang=', { headers: { Cookie: 'target_language=ko' } });
    expect(await res.json()).toEqual({ scope: 'ko' });
  });
});

describe('respondWithEtag', () => {
  it('answers 200 with ETag and no-cache on first request', async () => {
    const res = await etagApp().request('/list');
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"v1"');
    expect(res.headers.get('cache-control')).toBe(CACHE_CONTROLS.etagRevalidate);
    expect(await res.json()).toEqual({ items: [1, 2] });
  });

  it('answers 304 with empty body on a matching If-None-Match', async () => {
    const res = await etagApp().request('/list', { headers: { 'If-None-Match': '"v1"' } });
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe('"v1"');
    expect(await res.text()).toBe('');
  });

  it('matches weak tags and lists', async () => {
    for (const header of ['W/"v1"', '"v0", "v1"']) {
      const res = await etagApp().request('/list', { headers: { 'If-None-Match': header } });
      expect(res.status).toBe(304);
    }
  });

  it('answers 200 when the etag does not match', async () => {
    const res = await etagApp().request('/list', { headers: { 'If-None-Match': '"v0"' } });
    expect(res.status).toBe(200);
  });
});

describe('internalError', () => {
  it('answers the envelope with the error name as details', async () => {
    const res = await etagApp().request('/boom');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'sync failed', details: 'TypeError' });
  });
});

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { parseRange, streamFromBucket } from '../src/r2';
import type { R2StreamBucket } from '../src/r2';
import { CACHE_CONTROLS } from '../src/http';

function fakeBucket(objects: Record<string, { contentType: string; bytes: Uint8Array }>): R2StreamBucket & { rangeCalls: (string | null)[] } {
  const rangeCalls: (string | null)[] = [];
  return {
    rangeCalls,
    async head(key) {
      const obj = objects[key];
      if (!obj) return null;
      let hash = 0;
      for (const byte of obj.bytes) hash = (hash * 31 + byte) | 0;
      return {
        size: obj.bytes.length,
        httpEtag: `"${(hash >>> 0).toString(16)}"`,
        httpMetadata: { contentType: obj.contentType },
      };
    },
    async get(key, options) {
      const obj = objects[key];
      if (!obj) return null;
      rangeCalls.push(options?.range ? `${options.range.offset}+${options.range.length}` : null);
      const slice = options?.range ? obj.bytes.subarray(options.range.offset, options.range.offset + options.range.length) : obj.bytes;
      const copy = slice.slice();
      return { body: new ReadableStream({ start(controller) { controller.enqueue(copy); controller.close(); } }) };
    },
  };
}

const PAYLOAD = new Uint8Array(100).map((_, i) => i);

function streamApp(bucket: R2StreamBucket) {
  const app = new Hono();
  app.get('/file/:key', (c) => streamFromBucket(c, bucket, c.req.param('key'), { cacheControl: CACHE_CONTROLS.privateDay }));
  return app;
}

describe('parseRange', () => {
  it('returns null without a header', () => {
    expect(parseRange(undefined, 100)).toBeNull();
  });

  it('parses a forward window', () => {
    expect(parseRange('bytes=10-19', 100)).toEqual({ offset: 10, length: 10 });
  });

  it('clamps the end to size-1', () => {
    expect(parseRange('bytes=90-', 100)).toEqual({ offset: 90, length: 10 });
  });

  it('parses a suffix window', () => {
    expect(parseRange('bytes=-5', 100)).toEqual({ offset: 95, length: 5 });
  });

  it('clamps a suffix larger than size', () => {
    expect(parseRange('bytes=-500', 100)).toEqual({ offset: 0, length: 100 });
  });

  it('rejects start beyond size', () => {
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
  });

  it('rejects end before start', () => {
    expect(parseRange('bytes=50-10', 100)).toBe('invalid');
  });

  it('rejects malformed headers', () => {
    expect(parseRange('bytes=', 100)).toBe('invalid');
    expect(parseRange('bytes=5-10,20-30', 100)).toBe('invalid');
    expect(parseRange('items=0-1', 100)).toBe('invalid');
  });
});

describe('streamFromBucket', () => {
  it('answers 404 for an empty key', async () => {
    const bucket = fakeBucket({ a: { contentType: 'text/plain', bytes: PAYLOAD } });
    const res = await streamApp(bucket).request('/file/');
    expect(res.status).toBe(404);
  });

  it('answers 404 for a missing key', async () => {
    const bucket = fakeBucket({ a: { contentType: 'text/plain', bytes: PAYLOAD } });
    const res = await streamApp(bucket).request('/file/nope');
    expect(res.status).toBe(404);
  });

  it('streams the full body with cache headers and etag', async () => {
    const bucket = fakeBucket({ a: { contentType: 'image/jpeg', bytes: PAYLOAD } });
    const res = await streamApp(bucket).request('/file/a');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe(CACHE_CONTROLS.privateDay);
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]+"$/);
    expect(res.headers.get('content-length')).toBe('100');
    expect(bucket.rangeCalls).toEqual([null]);
  });

  it('answers 206 with Content-Range for a window', async () => {
    const bucket = fakeBucket({ a: { contentType: 'video/mp4', bytes: PAYLOAD } });
    const res = await streamApp(bucket).request('/file/a', { headers: { Range: 'bytes=10-19' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 10-19/100');
    expect(res.headers.get('content-length')).toBe('10');
    expect(bucket.rangeCalls).toEqual(['10+10']);
  });

  it('answers 206 for a suffix range', async () => {
    const bucket = fakeBucket({ a: { contentType: 'audio/mp4', bytes: PAYLOAD } });
    const res = await streamApp(bucket).request('/file/a', { headers: { Range: 'bytes=-5' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 95-99/100');
  });

  it('answers 416 for a malformed range', async () => {
    const bucket = fakeBucket({ a: { contentType: 'video/mp4', bytes: PAYLOAD } });
    const res = await streamApp(bucket).request('/file/a', { headers: { Range: 'bytes=9-2' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */100');
  });

  it('serves HEAD with length but no body', async () => {
    const bucket = fakeBucket({ a: { contentType: 'image/jpeg', bytes: PAYLOAD } });
    const res = await streamApp(bucket).request('/file/a', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('100');
    expect(await res.text()).toBe('');
  });

  it('passes a content disposition through', async () => {
    const bucket = fakeBucket({ a: { contentType: 'application/pdf', bytes: PAYLOAD } });
    const app = new Hono();
    app.get('/f/:key', (c) => streamFromBucket(c, bucket, c.req.param('key'), {
      cacheControl: CACHE_CONTROLS.privateRevalidate,
      contentDisposition: 'attachment; filename="report.pdf"',
    }));
    const res = await app.request('/f/a');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="report.pdf"');
  });

  it('falls back to octet-stream without metadata', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const bare: R2StreamBucket = {
      head: async (key) => (key === 'a' ? { size: bytes.length, httpEtag: '"x"', httpMetadata: undefined } : null),
      get: async (key) => {
        if (key !== 'a') return null;
        const copy = bytes.slice();
        return { body: new ReadableStream({ start(controller) { controller.enqueue(copy); controller.close(); } }) };
      },
    };
    const res = await streamApp(bare).request('/file/a');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });
});

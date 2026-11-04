import type { Context } from 'hono';

/** The R2 surface streamFromBucket needs — Cloudflare's binding satisfies
 *  it structurally, tests satisfy it with an in-memory fake. */
export interface R2StreamBucket {
  head(key: string): Promise<{
    size: number;
    httpEtag: string;
    httpMetadata?: { contentType?: string } | undefined;
  } | null>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<{ body: ReadableStream } | null>;
}

export interface RangedRequest {
  offset: number;
  length: number;
}

/**
 * Parse a single-range `bytes=` header against a known size: a valid window,
 * 'invalid' (answer 416), or null (no Range header → full body).
 */
export function parseRange(header: string | undefined, size: number): RangedRequest | 'invalid' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';
  const [, startRaw, endRaw] = match;
  if (startRaw === '' && endRaw === '') return 'invalid';
  if (startRaw === '') {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(startRaw);
  if (!Number.isFinite(start) || start < 0) return 'invalid';
  if (start >= size) return 'invalid';
  let end = size - 1;
  if (endRaw !== '') {
    const parsed = Number(endRaw);
    if (!Number.isFinite(parsed) || parsed < start) return 'invalid';
    end = Math.min(parsed, size - 1);
  }
  return { offset: start, length: end - start + 1 };
}

export interface StreamOptions {
  /** Cache-Control value — CACHE_CONTROLS.privateRevalidate / privateDay. */
  cacheControl: string;
  /** e.g. `attachment; filename="report.pdf"`. */
  contentDisposition?: string;
}

/**
 * Serve an R2 object as a Workers response: HEAD support, single-range
 * requests (206 + Content-Range), malformed ranges (416), R2's own ETag
 * and content type. Missing key or empty key answers 404 — callers pass
 * `''` for docs without media.
 */
export async function streamFromBucket(
  c: Context,
  bucket: R2StreamBucket,
  key: string,
  options: StreamOptions,
) {
  if (!key) return c.json({ error: 'not found' }, 404);
  const head = await bucket.head(key);
  if (!head) return c.json({ error: 'not found' }, 404);
  const size = head.size;
  const contentType = head.httpMetadata?.contentType ?? 'application/octet-stream';
  const range = parseRange(c.req.header('Range'), size);

  if (range === 'invalid') {
    return c.body(null, 416, {
      'Content-Range': `bytes */${size}`,
      'Accept-Ranges': 'bytes',
    });
  }

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': options.cacheControl,
    ETag: head.httpEtag,
  };
  if (options.contentDisposition !== undefined) headers['Content-Disposition'] = options.contentDisposition;

  if (c.req.method === 'HEAD') {
    if (range) {
      headers['Content-Length'] = String(range.length);
      headers['Content-Range'] = `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`;
    } else {
      headers['Content-Length'] = String(size);
    }
    return c.body(null, 200, headers);
  }

  if (range) {
    const obj = await bucket.get(key, { range: { offset: range.offset, length: range.length } });
    if (!obj) return c.json({ error: 'not found' }, 404);
    headers['Content-Length'] = String(range.length);
    headers['Content-Range'] = `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`;
    return c.body(obj.body, 206, headers);
  }

  const obj = await bucket.get(key);
  if (!obj) return c.json({ error: 'not found' }, 404);
  headers['Content-Length'] = String(size);
  return c.body(obj.body, 200, headers);
}

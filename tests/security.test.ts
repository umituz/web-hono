import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  securityHeaders,
  buildCspString,
  formatHstsHeader,
  DEFAULT_PERMISSIONS_POLICY,
} from '../src/security';

describe('security headers', () => {
  it('applies default security headers to http responses', async () => {
    const app = new Hono();
    app.use('*', securityHeaders());
    app.get('/test', (c) => c.text('ok'));

    const res = await app.request('http://localhost/test');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Permissions-Policy')).toBe(DEFAULT_PERMISSIONS_POLICY);
    expect(res.headers.get('X-XSS-Protection')).toBe('0');
    expect(res.headers.get('Strict-Transport-Security')).toBeNull();

    const csp = res.headers.get('Content-Security-Policy');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('applies HSTS on https requests', async () => {
    const app = new Hono();
    app.use('*', securityHeaders());
    app.get('/secure', (c) => c.text('secure'));

    const res = await app.request('https://localhost/secure');
    expect(res.status).toBe(200);
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
  });

  it('customizes HSTS options', () => {
    expect(formatHstsHeader({ maxAge: 86400, includeSubDomains: false, preload: true })).toBe(
      'max-age=86400; preload',
    );
    expect(formatHstsHeader({ maxAge: 600, includeSubDomains: true, preload: false })).toBe(
      'max-age=600; includeSubDomains',
    );
  });

  it('supports custom CSP directives and merges with defaults', async () => {
    const app = new Hono();
    app.use(
      '*',
      securityHeaders({
        csp: {
          scriptSrc: ["'self'", 'https://challenges.cloudflare.com'],
          imgSrc: ["'self'", 'data:', 'https://images.unsplash.com'],
        },
      }),
    );
    app.get('/csp', (c) => c.text('csp'));

    const res = await app.request('http://localhost/csp');
    const csp = res.headers.get('Content-Security-Policy');
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain("img-src 'self' data: https://images.unsplash.com");
    expect(csp).toContain("default-src 'self'");
  });

  it('supports disabling CSP and custom xFrameOptions', async () => {
    const app = new Hono();
    app.use(
      '*',
      securityHeaders({
        csp: false,
        xFrameOptions: 'SAMEORIGIN',
        crossOriginOpenerPolicy: 'same-origin',
        crossOriginResourcePolicy: 'same-origin',
      }),
    );
    app.get('/opts', (c) => c.text('opts'));

    const res = await app.request('http://localhost/opts');
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
  });

  it('builds CSP string correctly', () => {
    const built = buildCspString({
      defaultSrc: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
    });
    expect(built).toBe("default-src 'self'; frame-ancestors 'none'; object-src 'none'");
  });
});

import type { MiddlewareHandler } from 'hono';

export interface CspDirectives {
  defaultSrc?: string[];
  scriptSrc?: string[];
  styleSrc?: string[];
  fontSrc?: string[];
  imgSrc?: string[];
  mediaSrc?: string[];
  connectSrc?: string[];
  workerSrc?: string[];
  frameSrc?: string[];
  frameAncestors?: string[];
  formAction?: string[];
  baseUri?: string[];
  objectSrc?: string[];
  [directive: string]: string[] | undefined;
}

export interface HstsOptions {
  maxAge?: number;
  includeSubDomains?: boolean;
  preload?: boolean;
}

export interface SecurityHeadersOptions {
  csp?: CspDirectives | string | false;
  xContentTypeOptions?: boolean;
  xFrameOptions?: 'DENY' | 'SAMEORIGIN' | false;
  referrerPolicy?: string | false;
  permissionsPolicy?: string | false;
  hsts?: HstsOptions | boolean;
  crossOriginOpenerPolicy?: 'same-origin' | 'same-origin-allow-popups' | 'unsafe-none' | false;
  crossOriginResourcePolicy?: 'same-origin' | 'same-site' | 'cross-origin' | false;
  xXssProtection?: string | false;
}

const DEFAULT_CSP_DIRECTIVES: CspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  fontSrc: ["'self'", 'data:'],
  imgSrc: ["'self'", 'data:', 'blob:'],
  mediaSrc: ["'self'", 'blob:', 'data:'],
  connectSrc: ["'self'"],
  workerSrc: ["'self'"],
  frameSrc: ["'self'"],
  frameAncestors: ["'none'"],
  formAction: ["'self'"],
  baseUri: ["'self'"],
  objectSrc: ["'none'"],
};

export const DEFAULT_PERMISSIONS_POLICY = 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()';

function formatDirectiveName(key: string): string {
  return key.replace(/([A-Z])/g, '-$1').toLowerCase();
}

export function buildCspString(directives: CspDirectives): string {
  const parts: string[] = [];
  for (const [key, values] of Object.entries(directives)) {
    if (values && values.length > 0) {
      parts.push(`${formatDirectiveName(key)} ${values.join(' ')}`);
    }
  }
  return parts.join('; ');
}

export function formatHstsHeader(options?: HstsOptions | boolean): string {
  if (typeof options === 'object' && options !== null) {
    const maxAge = options.maxAge ?? 31536000;
    const parts = [`max-age=${maxAge}`];
    if (options.includeSubDomains ?? true) parts.push('includeSubDomains');
    if (options.preload) parts.push('preload');
    return parts.join('; ');
  }
  return 'max-age=31536000; includeSubDomains';
}

export function applySecurityHeaders(headers: Headers, secure: boolean, options: SecurityHeadersOptions = {}): void {
  if (options.csp !== false) {
    if (typeof options.csp === 'string') {
      headers.set('Content-Security-Policy', options.csp);
    } else {
      const merged: CspDirectives = { ...DEFAULT_CSP_DIRECTIVES, ...(options.csp ?? {}) };
      headers.set('Content-Security-Policy', buildCspString(merged));
    }
  }

  if (options.xContentTypeOptions !== false) {
    headers.set('X-Content-Type-Options', 'nosniff');
  }

  if (options.xFrameOptions !== false) {
    headers.set('X-Frame-Options', options.xFrameOptions ?? 'DENY');
  }

  if (options.referrerPolicy !== false) {
    headers.set('Referrer-Policy', options.referrerPolicy ?? 'strict-origin-when-cross-origin');
  }

  if (options.permissionsPolicy !== false) {
    headers.set('Permissions-Policy', options.permissionsPolicy ?? DEFAULT_PERMISSIONS_POLICY);
  }

  if (secure && options.hsts !== false) {
    headers.set('Strict-Transport-Security', formatHstsHeader(options.hsts));
  }

  if (options.xXssProtection !== false) {
    headers.set('X-XSS-Protection', options.xXssProtection ?? '0');
  }

  if (options.crossOriginOpenerPolicy !== false && options.crossOriginOpenerPolicy !== undefined) {
    headers.set('Cross-Origin-Opener-Policy', options.crossOriginOpenerPolicy);
  }

  if (options.crossOriginResourcePolicy !== false && options.crossOriginResourcePolicy !== undefined) {
    headers.set('Cross-Origin-Resource-Policy', options.crossOriginResourcePolicy);
  }
}

export function securityHeaders(options: SecurityHeadersOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const secure = new URL(c.req.url).protocol === 'https:';
    try {
      applySecurityHeaders(c.res.headers, secure, options);
    } catch {
      const headers = new Headers(c.res.headers);
      applySecurityHeaders(headers, secure, options);
      c.res = new Response(c.res.body, {
        status: c.res.status,
        statusText: c.res.statusText,
        headers,
      });
    }
  };
}

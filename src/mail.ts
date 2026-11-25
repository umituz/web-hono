export interface MailEnv {
  RESEND_API_KEY?: string;
}

export interface SendEmailInput {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(env: MailEnv, input: SendEmailInput): Promise<void> {
  if (!env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not configured');
  }
  const body: Record<string, string> = { from: input.from, to: input.to, subject: input.subject, html: input.html };
  if (input.text !== undefined) {
    body.text = input.text;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`resend ${res.status}: ${await res.text()}`);
  }
}

export interface MailTemplate {
  key: string;
  version: number;
  subject: string;
  html: string;
  text: string;
}

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

export function mailTemplateVars(body: string): string[] {
  return [...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!);
}

export function renderMailTemplate(template: MailTemplate, vars: Record<string, string | number | boolean>): RenderedMail {
  const missing = new Set<string>();
  const substitute = (body: string): string =>
    body.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      if (!(key in vars) || vars[key] === undefined || vars[key] === null) {
        missing.add(key);
        return '';
      }
      return String(vars[key]);
    });
  const rendered = {
    subject: substitute(template.subject),
    html: substitute(template.html),
    text: substitute(template.text),
  };
  if (missing.size > 0) {
    throw new Error(`mail template "${template.key}" is missing variables: ${[...missing].sort().join(', ')}`);
  }
  return rendered;
}

export interface MailLayoutInput {
  product: string;
  title: string;
  intro?: string[];
  bodyHtml: string;
  button?: { label: string; url: string };
  footerNote?: string;
  unsubscribeUrl?: string;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function composeMailHtml(input: MailLayoutInput): string {
  const { product, title, intro = [], bodyHtml, button, footerNote, unsubscribeUrl } = input;
  const paragraphs = intro.map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#1f2937;">${p}</p>`).join('');
  const buttonHtml = button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0 6px;"><tr><td style="border-radius:8px;background:#4f46e5;">` +
      `<a href="${button.url}" style="display:inline-block;padding:11px 22px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(button.label)}</a></td></tr></table>` +
      `<p style="margin:0 0 12px;font-size:13px;line-height:1.6;color:#6b7280;">Or paste this link into your browser: ${escapeHtml(button.url)}</p>`
    : '';
  const footer = [
    footerNote ? `<p style="margin:18px 0 6px;font-size:12px;line-height:1.6;color:#9ca3af;">${footerNote}</p>` : '',
    unsubscribeUrl
      ? `<p style="margin:6px 0 0;font-size:12px;line-height:1.6;color:#9ca3af;">Don't want these emails? <a href="${unsubscribeUrl}" style="color:#6b7280;">Unsubscribe in one click</a> — you stay signed in, in-app bells are unaffected.</p>`
      : '',
  ].filter(Boolean).join('');
  return [
    '<!doctype html><html lang="en"><body style="margin:0;padding:0;background:#f3f4f6;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px;"><tr><td align="center">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;">',
    `<tr><td style="padding:24px 28px 8px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;">${escapeHtml(product)}</td></tr>`,
    `<tr><td style="padding:4px 28px 16px;font-family:Arial,Helvetica,sans-serif;font-size:21px;font-weight:700;color:#111827;">${escapeHtml(title)}</td></tr>`,
    `<tr><td style="padding:0 28px 8px;font-family:Arial,Helvetica,sans-serif;">${paragraphs}${bodyHtml}${buttonHtml}</td></tr>`,
    `<tr><td style="padding:14px 28px 26px;font-family:Arial,Helvetica,sans-serif;border-top:1px solid #f3f4f6;">${footer}</td></tr>`,
    '</table></td></tr></table></body></html>',
  ].join('');
}

export function composeMailText(input: MailLayoutInput): string {
  const { product, title, intro = [], bodyHtml, button, footerNote, unsubscribeUrl } = input;
  const strip = (html: string): string =>
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  const lines = [
    `${product.toUpperCase()} — ${title}`,
    '',
    ...intro.map((p) => strip(p)),
    '',
    strip(bodyHtml),
    button ? `\n${button.label}: ${button.url}` : '',
    footerNote ? `\n${footerNote}` : '',
    unsubscribeUrl ? `\nDon't want these emails? Unsubscribe: ${unsubscribeUrl}` : '',
  ];
  return lines.filter((l) => l !== '').join('\n');
}

const encoder = new TextEncoder();

async function hmacKey(secret: string, purpose: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(`${purpose}:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function signMailToken(
  secret: string,
  purpose: string,
  payload: Record<string, string | number | boolean>,
  ttlSeconds: number,
): Promise<string> {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const encoded = toBase64Url(encoder.encode(JSON.stringify(body)));
  const key = await hmacKey(secret, purpose);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(encoded));
  return `${encoded}.${toBase64Url(new Uint8Array(sig))}`;
}

export async function verifyMailToken(
  secret: string,
  token: string,
  purpose: string,
): Promise<Record<string, string | number | boolean> | null> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const [encoded, sig] = [token.slice(0, dot), token.slice(dot + 1)];
  try {
    const key = await hmacKey(secret, purpose);
    const ok = await crypto.subtle.verify('HMAC', key, fromBase64Url(sig) as unknown as BufferSource, encoder.encode(encoded));
    if (!ok) return null;
    const body = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))) as Record<string, string | number | boolean>;
    if (typeof body.exp !== 'number' || body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}

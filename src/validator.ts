import type { Context } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';

export function validateJson<S extends z.ZodType>(schema: S, message = 'Invalid request body') {
  return (value: unknown, c: Context) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      return c.json({ error: message, details: parsed.error.flatten().fieldErrors }, 400);
    }
    return parsed.data as z.output<S>;
  };
}

export function strictJson<S extends z.ZodRawShape>(shape: S, message = 'Invalid request body') {
  return validateJson(z.strictObject(shape), message);
}

export function looseJson<S extends z.ZodRawShape>(shape: S, message = 'Invalid request body') {
  return validateJson(z.looseObject(shape), message);
}

export function zBody<S extends z.ZodType>(schema: S, message = 'Invalid request body') {
  return validator('json', validateJson(schema, message));
}

export function zStrictBody<S extends z.ZodRawShape>(shape: S, message = 'Invalid request body') {
  return validator('json', strictJson(shape, message));
}

export function zLooseBody<S extends z.ZodRawShape>(shape: S, message = 'Invalid request body') {
  return validator('json', looseJson(shape, message));
}

export function zQuery<S extends z.ZodType>(schema: S, message = 'Invalid query parameters') {
  return validator('query', (value: unknown, c: Context) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      return c.json({ error: message, details: parsed.error.flatten().fieldErrors }, 400);
    }
    return parsed.data as z.output<S>;
  });
}

export function zParam<S extends z.ZodType>(schema: S, message = 'Invalid path parameters') {
  return validator('param', (value: unknown, c: Context) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      return c.json({ error: message, details: parsed.error.flatten().fieldErrors }, 400);
    }
    return parsed.data as z.output<S>;
  });
}

export function zStrictQuery<S extends z.ZodRawShape>(shape: S, message = 'Invalid query parameters') {
  return zQuery(z.strictObject(shape), message);
}

export function zLooseQuery<S extends z.ZodRawShape>(shape: S, message = 'Invalid query parameters') {
  return zQuery(z.looseObject(shape), message);
}

export function zStrictParam<S extends z.ZodRawShape>(shape: S, message = 'Invalid path parameters') {
  return zParam(z.strictObject(shape), message);
}

export function zLooseParam<S extends z.ZodRawShape>(shape: S, message = 'Invalid path parameters') {
  return zParam(z.looseObject(shape), message);
}

export const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const dateOnlyCoerce = z.string().min(10).transform((v) => v.slice(0, 10)).pipe(dateOnly);

export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

export const datetimeLocal = z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, 'expected YYYY-MM-DDTHH:MM');

export const datetimeSeconds = z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/, 'expected YYYY-MM-DDTHH:MM:SS');

export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #RRGGBB');

export const uuid = z.string().uuid();

export const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'expected kebab-case slug');

export const positiveInt = z.coerce.number().int().positive();

export const nonNegativeInt = z.coerce.number().int().min(0);

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const email = z.string().trim().toLowerCase().pipe(z.string().email());

export function trimmedString(min = 1, max = 255) {
  return z.string().trim().min(min).max(max);
}

export const safeId = z.string().trim().min(1).max(128);

export const sortOrderQuery = z.enum(['asc', 'desc']).default('asc');

export const booleanQuery = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

export const commaSeparatedQuery = z
  .string()
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

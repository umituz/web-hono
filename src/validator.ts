import type { Context } from 'hono';
import { z } from 'zod';

/**
 * The single definition of the API's JSON-body validation contract:
 * zod safeParse behind hono's `validator('json', …)` — failures answer
 * `400 { error, details: fieldErrors }`, successes flow the parsed (and
 * `.strict()`, `.trim()`-ed) data into the handler via `c.req.valid('json')`.
 *
 * Usage:
 *   app.post(
 *     '/widgets',
 *     validator('json', validateJson(CreateWidgetSchema, 'Invalid widget payload')),
 *     (c) => { const input = c.req.valid('json'); … },
 *   );
 */
export function validateJson<S extends z.ZodType>(schema: S, message = 'Invalid request body') {
  return (value: unknown, c: Context) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      return c.json({ error: message, details: parsed.error.flatten().fieldErrors }, 400);
    }
    return parsed.data as z.output<S>;
  };
}

export const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

export const actorFields = { actorId: z.string().optional(), actorName: z.string().optional() } as const;

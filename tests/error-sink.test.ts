import { describe, expect, it } from 'vitest';
import { pgTable, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { writeErrorLog, createErrorLogSink } from '../src/activity';

const mockErrorTable = pgTable('mock_errors', {
  id: text('id').primaryKey(),
  method: text('method').notNull(),
  path: text('path').notNull(),
  status: integer('status').notNull(),
  message: text('message').notNull(),
  stack: text('stack'),
  createdAt: timestamp('created_at'),
});

describe('writeErrorLog & createErrorLogSink', () => {
  it('writes error log entry to database', async () => {
    const insertedValues: unknown[] = [];
    const mockDb = {
      insert: () => ({
        values: (val: unknown) => {
          insertedValues.push(val);
          return Promise.resolve();
        },
      }),
    };

    await writeErrorLog(
      mockDb as never,
      mockErrorTable as never,
      {
        method: 'GET',
        path: '/api/broken',
        status: 500,
        message: 'Something went wrong',
        stack: 'Error: Something went wrong\n  at test.ts:10',
      },
      'err',
    );

    expect(insertedValues.length).toBe(1);
    const entry = insertedValues[0] as Record<string, unknown>;
    expect(entry.id).toMatch(/^err_/);
    expect(entry.method).toBe('GET');
    expect(entry.path).toBe('/api/broken');
    expect(entry.status).toBe(500);
    expect(entry.message).toBe('Something went wrong');
    expect(entry.stack).toContain('Error: Something went wrong');
  });

  it('createErrorLogSink filters status < 500 and records 500 errors', async () => {
    const insertedValues: unknown[] = [];
    const mockDb = {
      insert: () => ({
        values: (val: unknown) => {
          insertedValues.push(val);
          return Promise.resolve();
        },
      }),
    };

    const sink = createErrorLogSink(() => mockDb as never, mockErrorTable as never);

    await sink(
      {
        method: 'GET',
        path: '/api/not-found',
        status: 404,
        message: 'Not found',
        error: new Error('Not found'),
      },
      {} as never,
    );
    expect(insertedValues.length).toBe(0);

    await sink(
      {
        method: 'POST',
        path: '/api/crash',
        status: 500,
        message: 'Database connection failed',
        error: new Error('Crash stack error'),
      },
      {} as never,
    );

    expect(insertedValues.length).toBe(1);
    const crashEntry = insertedValues[0] as Record<string, unknown>;
    expect(crashEntry.method).toBe('POST');
    expect(crashEntry.path).toBe('/api/crash');
    expect(crashEntry.status).toBe(500);
    expect(crashEntry.message).toBe('Database connection failed');
  });
});

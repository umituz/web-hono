import { describe, expectTypeOf, it } from 'vitest';
import type { ClientRow, Row, Serialized } from '../src/types';
import { journals, widgets } from './helpers';

/* Compile-time assertions only — the type bridge has no runtime. */

describe('type bridge', () => {
  it('Row keeps the server shapes (Date for timestamptz)', () => {
    expectTypeOf<Row<typeof widgets>['createdAt']>().toEqualTypeOf<Date>();
    expectTypeOf<Row<typeof widgets>['deletedAt']>().toEqualTypeOf<Date | null>();
    expectTypeOf<Row<typeof widgets>['count']>().toEqualTypeOf<number | null>();
  });

  it('ClientRow maps Date → ISO string over the wire', () => {
    expectTypeOf<ClientRow<typeof widgets>['createdAt']>().toEqualTypeOf<string>();
    expectTypeOf<ClientRow<typeof widgets>['deletedAt']>().toEqualTypeOf<string | null>();
    expectTypeOf<ClientRow<typeof widgets>['openedAt']>().toEqualTypeOf<string | null>();
  });

  it('non-Date columns pass through untouched', () => {
    expectTypeOf<ClientRow<typeof widgets>['id']>().toEqualTypeOf<string>();
    expectTypeOf<ClientRow<typeof widgets>['count']>().toEqualTypeOf<number | null>();
    // date mode:'string' columns are already strings — no double mapping
    expectTypeOf<ClientRow<typeof widgets>['bestBefore']>().toEqualTypeOf<string | null>();
    expectTypeOf<ClientRow<typeof journals>['createdAt']>().toEqualTypeOf<string>();
  });

  it('Serialized works standalone on plain interfaces', () => {
    type WithDates = { a: Date; b: Date | null; c: string; d?: Date | undefined };
    expectTypeOf<Serialized<WithDates>['a']>().toEqualTypeOf<string>();
    expectTypeOf<Serialized<WithDates>['b']>().toEqualTypeOf<string | null>();
    expectTypeOf<Serialized<WithDates>['c']>().toEqualTypeOf<string>();
  });
});

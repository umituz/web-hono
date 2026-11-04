// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCookieChannel } from '../src/cookies';

const channel = createCookieChannel({ key: 'prefs_theme', maxAgeSeconds: 60, sameSite: 'lax' });
const strictChannel = createCookieChannel({ key: 'prefs_view', maxAgeSeconds: 10, sameSite: 'strict' });

const proto = Object.getPrototypeOf(document) as Document;
const cookieDesc = Object.getOwnPropertyDescriptor(proto, 'cookie')!;
const writes: string[] = [];

beforeEach(() => {
  writes.length = 0;
  Object.defineProperty(proto, 'cookie', {
    ...cookieDesc,
    set(value: string) {
      writes.push(value);
      cookieDesc.set!.call(this, value);
    },
  });
  document.cookie = '';
});

afterEach(() => {
  Object.defineProperty(proto, 'cookie', cookieDesc);
});

describe('createCookieChannel', () => {
  it('reads null when absent', () => {
    expect(channel.read()).toBeNull();
  });

  it('writes then reads back its own key', () => {
    channel.write('dark');
    expect(channel.read()).toBe('dark');
    expect(writes.at(-1)).toContain('path=/');
    expect(writes.at(-1)).toContain('max-age=60');
    expect(writes.at(-1)).toContain('samesite=lax');
  });

  it('ignores other cookies with different names', () => {
    strictChannel.write('grid');
    channel.write('dark');
    expect(strictChannel.read()).toBe('grid');
    expect(channel.read()).toBe('dark');
  });

  it('serializes the configured samesite', () => {
    strictChannel.write('list');
    expect(writes.at(-1)).toContain('samesite=strict');
  });

  it('clear removes the value', () => {
    channel.write('dark');
    channel.clear();
    expect(channel.read()).toBeNull();
    expect(writes.at(-1)).toContain('max-age=0');
  });

  it('treats an empty value as absent', () => {
    document.cookie = 'prefs_theme=; path=/; max-age=60; samesite=lax';
    expect(channel.read()).toBeNull();
  });
});

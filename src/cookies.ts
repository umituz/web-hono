export type CookieSameSite = 'lax' | 'strict' | 'none';

export interface CookieChannelConfig {
  key: string;
  maxAgeSeconds: number;
  sameSite: CookieSameSite;
}

export interface CookieChannel {
  read(): string | null;
  write(value: string): void;
  clear(): void;
}

export function createCookieChannel(config: CookieChannelConfig): CookieChannel {
  const prefix = `${config.key}=`;
  return {
    read() {
      const entry = document.cookie
        .split('; ')
        .find((part) => part.startsWith(prefix));
      const value = entry === undefined ? null : entry.slice(prefix.length);
      if (value === null || value.length === 0) return null;
      return value;
    },
    write(value) {
      document.cookie = `${config.key}=${value}; path=/; max-age=${config.maxAgeSeconds}; samesite=${config.sameSite}`;
    },
    clear() {
      document.cookie = `${config.key}=; path=/; max-age=0; samesite=${config.sameSite}`;
    },
  };
}

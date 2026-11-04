export type CookieSameSite = 'lax' | 'strict' | 'none';

export interface CookieChannelConfig {
  /** Wire name of the cookie (`prefs_theme`…). */
  key: string;
  /** max-age in seconds — long-lived preferences pass a year. */
  maxAgeSeconds: number;
  sameSite: CookieSameSite;
}

export interface CookieChannel {
  /** Current value, or null when the cookie is absent/empty. */
  read(): string | null;
  write(value: string): void;
  clear(): void;
}

/**
 * One named browser cookie, read/write/clear — the only cookie surface apps
 * should hand-roll. Serializes exactly `key=value; path=/; max-age=N;
 * samesite=X` and parses back defensively (values never contain `;`).
 */
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

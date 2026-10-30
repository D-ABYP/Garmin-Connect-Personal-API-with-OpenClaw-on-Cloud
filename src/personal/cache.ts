import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CacheStats } from './context-types';
import { expandHomePath } from './paths';

const CACHE_SCHEMA_VERSION = 1;
const CURRENT_DAY_TTL_MS = 10 * 60_000;
const RECENT_DAY_TTL_MS = 6 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

type CacheEntry<T> = {
  version: number;
  key: string;
  date: string;
  fetchedAt: number;
  payload: T;
};

export type JsonCacheOptions = {
  directory?: string;
  now?: () => number;
};

export class JsonCache {
  private readonly directory: string;
  private readonly now: () => number;
  private counters: CacheStats = { hits: 0, misses: 0, writes: 0, writeErrors: 0 };

  constructor(options: JsonCacheOptions = {}) {
    this.directory = expandHomePath(options.directory ?? process.env.GARMIN_CACHE_DIR ?? path.join(os.homedir(), '.config', 'garmin', 'cache'));
    this.now = options.now ?? Date.now;
  }

  async getOrFetch<T>(
    key: string,
    date: string,
    fetcher: () => Promise<T | null>,
    validate?: (payload: unknown) => payload is T,
  ): Promise<T | null> {
    const cached = await this.read<T>(key, date, validate);
    if (cached !== null) {
      this.counters.hits++;
      return cached;
    }

    this.counters.misses++;
    const value = await fetcher();
    if (value === null) return null;

    try {
      await this.write(key, date, value);
      this.counters.writes++;
    } catch {
      this.counters.writeErrors++;
    }
    return value;
  }

  stats(): CacheStats {
    return { ...this.counters };
  }

  resetStats(): void {
    this.counters = { hits: 0, misses: 0, writes: 0, writeErrors: 0 };
  }

  private fileName(key: string): string {
    const digest = createHash('sha256').update(`${CACHE_SCHEMA_VERSION}\0${key}`).digest('hex');
    return path.join(this.directory, `${digest}.json`);
  }

  private async read<T>(key: string, date: string, validate?: (payload: unknown) => payload is T): Promise<T | null> {
    try {
      const entry = JSON.parse(await readFile(this.fileName(key), 'utf8')) as CacheEntry<T>;
      if (
        entry.version !== CACHE_SCHEMA_VERSION ||
        entry.key !== key ||
        entry.date !== date ||
        typeof entry.fetchedAt !== 'number' ||
        !Object.prototype.hasOwnProperty.call(entry, 'payload') ||
        entry.payload === null ||
        (validate && !validate(entry.payload))
      ) {
        return null;
      }
      const maxAge = this.maxAge(date);
      if (maxAge !== Number.POSITIVE_INFINITY && this.now() - entry.fetchedAt > maxAge) return null;
      return entry.payload;
    } catch {
      return null;
    }
  }

  private async write<T>(key: string, date: string, payload: T): Promise<void> {
    const file = this.fileName(key);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const entry: CacheEntry<T> = {
      version: CACHE_SCHEMA_VERSION,
      key,
      date,
      fetchedAt: this.now(),
      payload,
    };
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(entry), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private maxAge(date: string): number {
    const target = Date.parse(`${date}T00:00:00.000Z`);
    const today = Date.parse(`${new Date(this.now()).toISOString().slice(0, 10)}T00:00:00.000Z`);
    if (!Number.isFinite(target)) return CURRENT_DAY_TTL_MS;
    const ageDays = Math.floor((today - target) / DAY_MS);
    if (ageDays <= 0) return CURRENT_DAY_TTL_MS;
    if (ageDays <= 2) return RECENT_DAY_TTL_MS;
    return Number.POSITIVE_INFINITY;
  }
}

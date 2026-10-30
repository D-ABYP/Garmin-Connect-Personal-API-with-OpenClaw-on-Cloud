import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonCache } from './cache';

const tempDirs: string[] = [];
const INITIAL_NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'garmin-json-cache-test-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('JsonCache', () => {
  it('reuses current-day data for ten minutes and then refreshes it', async () => {
    let now = INITIAL_NOW;
    const cache = new JsonCache({ directory: await tempDir(), now: () => now });
    let fetches = 0;
    const fetcher = async () => ({ value: ++fetches });

    expect(await cache.getOrFetch('sleep:2026-10-30', '2026-10-30', fetcher)).toEqual({ value: 1 });
    now += 5 * 60_000;
    expect(await cache.getOrFetch('sleep:2026-10-30', '2026-10-30', fetcher)).toEqual({ value: 1 });
    now += 6 * 60_000;
    expect(await cache.getOrFetch('sleep:2026-10-30', '2026-10-30', fetcher)).toEqual({ value: 2 });
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 2, writes: 2 });
  });

  it('allows late sync updates for six hours on the previous two days', async () => {
    let now = INITIAL_NOW;
    const cache = new JsonCache({ directory: await tempDir(), now: () => now });
    let fetches = 0;
    const fetcher = async () => ({ value: ++fetches });

    await cache.getOrFetch('hrv:2026-10-29', '2026-10-29', fetcher);
    now += 5 * 60 * 60_000;
    expect(await cache.getOrFetch('hrv:2026-10-29', '2026-10-29', fetcher)).toEqual({ value: 1 });
    now += 2 * 60 * 60_000;
    expect(await cache.getOrFetch('hrv:2026-10-29', '2026-10-29', fetcher)).toEqual({ value: 2 });
  });

  it('keeps closed historical dates without refetching the full history', async () => {
    let now = INITIAL_NOW;
    const cache = new JsonCache({ directory: await tempDir(), now: () => now });
    let fetches = 0;
    const fetcher = async () => ({ value: ++fetches });

    await cache.getOrFetch('activities:2026-09-01', '2026-09-01', fetcher);
    now += 45 * 24 * 60 * 60_000;
    expect(await cache.getOrFetch('activities:2026-09-01', '2026-09-01', fetcher)).toEqual({ value: 1 });
    expect(fetches).toBe(1);
  });

  it('ignores a corrupted cache file', async () => {
    const directory = await tempDir();
    const cache = new JsonCache({ directory, now: () => INITIAL_NOW });
    await cache.getOrFetch('broken', '2026-10-30', async () => ({ good: true }));
    const files = await readdir(directory);
    await writeFile(path.join(directory, files[0]!), '{not-json', 'utf8');

    expect(await cache.getOrFetch('broken', '2026-10-30', async () => ({ replaced: true }))).toEqual({ replaced: true });
  });

  it('ignores entries from another cache schema version', async () => {
    const directory = await tempDir();
    const cache = new JsonCache({ directory, now: () => INITIAL_NOW });
    await cache.getOrFetch('versioned', '2026-10-30', async () => ({ version: 1 }));
    const files = await readdir(directory);
    const file = path.join(directory, files[0]!);
    const entry = JSON.parse(await readFile(file, 'utf8')) as { version: number };
    entry.version = 999;
    await writeFile(file, JSON.stringify(entry), 'utf8');

    expect(await cache.getOrFetch('versioned', '2026-10-30', async () => ({ version: 2 }))).toEqual({ version: 2 });
  });

  it('treats an entry without a payload as a cache miss', async () => {
    const directory = await tempDir();
    const cache = new JsonCache({ directory, now: () => INITIAL_NOW });
    await cache.getOrFetch('missing-payload', '2026-10-30', async () => ({ original: true }));
    const files = await readdir(directory);
    const file = path.join(directory, files[0]!);
    const entry = JSON.parse(await readFile(file, 'utf8')) as { payload?: unknown };
    delete entry.payload;
    await writeFile(file, JSON.stringify(entry), 'utf8');

    expect(await cache.getOrFetch('missing-payload', '2026-10-30', async () => ({ replaced: true }))).toEqual({ replaced: true });
  });

  it('rejects a payload that fails runtime validation', async () => {
    const directory = await tempDir();
    const cache = new JsonCache({ directory, now: () => INITIAL_NOW });
    await cache.getOrFetch('invalid-payload', '2026-10-30', async () => ({ value: 1 }));
    const files = await readdir(directory);
    const file = path.join(directory, files[0]!);
    const entry = JSON.parse(await readFile(file, 'utf8')) as { payload: unknown };
    entry.payload = { value: 'wrong-type' };
    await writeFile(file, JSON.stringify(entry), 'utf8');
    const validate = (payload: unknown): payload is { value: number } =>
      typeof payload === 'object' && payload !== null && typeof (payload as { value?: unknown }).value === 'number';

    expect(await cache.getOrFetch('invalid-payload', '2026-10-30', async () => ({ value: 2 }), validate)).toEqual({ value: 2 });
  });

  it('does not cache null responses', async () => {
    const cache = new JsonCache({ directory: await tempDir(), now: () => INITIAL_NOW });
    let fetches = 0;
    const fetcher = async () => { fetches++; return null; };

    expect(await cache.getOrFetch('empty', '2026-10-30', fetcher)).toBeNull();
    expect(await cache.getOrFetch('empty', '2026-10-30', fetcher)).toBeNull();
    expect(fetches).toBe(2);
    expect(cache.stats().writes).toBe(0);
  });

  it('expands a home-relative GARMIN_CACHE_DIR path', async () => {
    const home = await tempDir();
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('GARMIN_CACHE_DIR', '~/cache');
    const cache = new JsonCache({ now: () => INITIAL_NOW });

    await cache.getOrFetch('home-path', '2026-10-30', async () => ({ ok: true }));

    expect(await readdir(path.join(home, 'cache'))).toHaveLength(1);
  });

  it('returns fetched data when the cache is not writable', async () => {
    const directory = await tempDir();
    const blocked = path.join(directory, 'not-a-directory');
    await writeFile(blocked, 'file', 'utf8');
    const cache = new JsonCache({ directory: blocked, now: () => INITIAL_NOW });

    expect(await cache.getOrFetch('value', '2026-10-30', async () => ({ ok: true }))).toEqual({ ok: true });
    expect(cache.stats().writeErrors).toBe(1);
  });
});

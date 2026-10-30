import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersonalApiError } from './errors';
import { HttpTransportError } from './http-transport';
import { PersonalApiClient } from './personal-api';
import {
  FakeTransport,
  NOW_MS,
  SECOND_TEST_API_KEY,
  TEST_API_KEY,
  jsonResponse,
  makeTestJwt,
} from './test-helpers';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'garmin-personal-api-test-'));
  tempDirs.push(directory);
  return directory;
}

async function keyFile(contents = `${TEST_API_KEY}\n`): Promise<string> {
  const directory = await tempDir();
  const file = path.join(directory, 'api_key');
  await writeFile(file, contents, 'utf8');
  return file;
}

function clientOptions(transport: FakeTransport, apiKeyFile: string, tokenCacheFile: string, logs: string[] = []) {
  return {
    transport,
    apiKeyFile,
    tokenCacheFile,
    now: () => NOW_MS,
    sleep: async () => undefined,
    logger: (message: string) => logs.push(message),
    timeoutMs: 1234,
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('PersonalApiClient credentials and token cache', () => {
  it('uses GARMIN_API_KEY_FILE and exchanges the key for a bearer token', async () => {
    const file = await keyFile();
    vi.stubEnv('GARMIN_API_KEY_FILE', file);
    const transport = new FakeTransport();
    const token = makeTestJwt(NOW_MS / 1000 + 7200);
    transport.enqueue(jsonResponse(200, `${token}\n`));
    transport.enqueue(jsonResponse(200, { value: 42 }));
    const cache = path.join(await tempDir(), 'token.json');
    const client = new PersonalApiClient(clientOptions(transport, file, cache));

    await expect(client.get<{ value: number }>('/example-service/value')).resolves.toEqual({ value: 42 });

    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token',
      headers: { Authorization: `ApiKey ${TEST_API_KEY}` },
      timeoutMs: 1234,
    });
    expect(transport.calls[1]).toMatchObject({
      method: 'GET',
      url: 'https://personal.connectapi.garmin.com/example-service/value',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await readFile(cache, 'utf8')).not.toContain(TEST_API_KEY);
  });

  it('expands a home-relative GARMIN_API_KEY_FILE path', async () => {
    const home = await tempDir();
    await writeFile(path.join(home, 'custom-key'), TEST_API_KEY, 'utf8');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('GARMIN_API_KEY_FILE', '~/custom-key');
    const transport = new FakeTransport();
    transport.enqueue(jsonResponse(200, makeTestJwt(NOW_MS / 1000 + 7200)));
    transport.enqueue(jsonResponse(200, { ok: true }));
    const options = {
      ...clientOptions(transport, path.join(home, 'unused-key'), path.join(home, 'token.json')),
      apiKeyFile: undefined,
    };
    const client = new PersonalApiClient(options);

    await expect(client.get('/example')).resolves.toEqual({ ok: true });
    expect(transport.calls[0]?.headers.Authorization).toBe(`ApiKey ${TEST_API_KEY}`);
  });

  it('prefers an explicit key file over the environment path', async () => {
    const explicit = await keyFile(TEST_API_KEY);
    const environment = await keyFile(SECOND_TEST_API_KEY);
    vi.stubEnv('GARMIN_API_KEY_FILE', environment);
    const transport = new FakeTransport();
    transport.enqueue(jsonResponse(200, makeTestJwt(NOW_MS / 1000 + 7200)));
    transport.enqueue(jsonResponse(200, { ok: true }));
    const client = new PersonalApiClient(clientOptions(transport, explicit, path.join(await tempDir(), 'token.json')));

    await client.get('/example');

    expect(transport.calls[0]?.headers.Authorization).toBe(`ApiKey ${TEST_API_KEY}`);
  });

  it('rejects a missing key file without making a request', async () => {
    const transport = new FakeTransport();
    const missing = path.join(await tempDir(), 'missing-key');
    const client = new PersonalApiClient(clientOptions(transport, missing, path.join(await tempDir(), 'token.json')));

    await expect(client.get('/example')).rejects.toMatchObject({ code: 'missing_api_key' });
    expect(transport.calls).toHaveLength(0);
  });

  it('rejects an empty key file', async () => {
    const file = await keyFile(' \n');
    const transport = new FakeTransport();
    const client = new PersonalApiClient(clientOptions(transport, file, path.join(await tempDir(), 'token.json')));

    await expect(client.get('/example')).rejects.toMatchObject({ code: 'empty_api_key' });
    expect(transport.calls).toHaveLength(0);
  });

  it('reuses an unexpired token across client instances', async () => {
    const file = await keyFile();
    const cache = path.join(await tempDir(), 'token.json');
    const transport = new FakeTransport();
    transport.enqueue(jsonResponse(200, makeTestJwt(NOW_MS / 1000 + 7200)));
    transport.enqueue(jsonResponse(200, { first: true }));
    transport.enqueue(jsonResponse(200, { second: true }));

    await new PersonalApiClient(clientOptions(transport, file, cache)).get('/first');
    await new PersonalApiClient(clientOptions(transport, file, cache)).get('/second');

    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(transport.calls).toHaveLength(3);
  });

  it('refreshes a cached token inside the one-hour refresh window', async () => {
    const file = await keyFile();
    const cache = path.join(await tempDir(), 'token.json');
    const transport = new FakeTransport();
    transport.enqueue(jsonResponse(200, makeTestJwt(NOW_MS / 1000 + 1800, 'old')));
    transport.enqueue(jsonResponse(200, { first: true }));
    transport.enqueue(jsonResponse(200, makeTestJwt(NOW_MS / 1000 + 86_400, 'new')));
    transport.enqueue(jsonResponse(200, { second: true }));

    await new PersonalApiClient(clientOptions(transport, file, cache)).get('/first');
    await new PersonalApiClient(clientOptions(transport, file, cache)).get('/second');

    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });

  it('does not reuse a token cached for a different key', async () => {
    const file = await keyFile();
    const cache = path.join(await tempDir(), 'token.json');
    const transport = new FakeTransport();
    transport.enqueue(jsonResponse(200, makeTestJwt(NOW_MS / 1000 + 7200, 'first')));
    transport.enqueue(jsonResponse(200, { first: true }));
    await new PersonalApiClient(clientOptions(transport, file, cache)).get('/first');

    await writeFile(file, SECOND_TEST_API_KEY, 'utf8');
    transport.enqueue(jsonResponse(200, makeTestJwt(NOW_MS / 1000 + 7200, 'second')));
    transport.enqueue(jsonResponse(200, { second: true }));
    await new PersonalApiClient(clientOptions(transport, file, cache)).get('/second');

    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
    const serializedCache = await readFile(cache, 'utf8');
    expect(serializedCache).not.toContain(TEST_API_KEY);
    expect(serializedCache).not.toContain(SECOND_TEST_API_KEY);
  });

  it('exposes only a key-bound cache fingerprint, not the raw key', async () => {
    const file = await keyFile();
    const transport = new FakeTransport();
    const client = new PersonalApiClient(clientOptions(transport, file, path.join(await tempDir(), 'token.json')));

    const namespace = await client.getCacheNamespace();

    expect(namespace).toMatch(/^[a-f0-9]{64}$/);
    expect(namespace).not.toContain(TEST_API_KEY);
    expect(transport.calls).toHaveLength(0);
  });

  it('ignores a malformed token cache and obtains a new token', async () => {
    const file = await keyFile();
    const cache = path.join(await tempDir(), 'token.json');
    await writeFile(cache, '{not-json', 'utf8');
    const transport = new FakeTransport();
    transport.enqueue(jsonResponse(200, makeTestJwt(NOW_MS / 1000 + 7200)));
    transport.enqueue(jsonResponse(200, { ok: true }));
    const client = new PersonalApiClient(clientOptions(transport, file, cache));

    await expect(client.get('/example')).resolves.toEqual({ ok: true });
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('writes the token cache with user-only permissions', async () => {
    const file = await keyFile();
    const cache = path.join(await tempDir(), 'token.json');
    const transport = new FakeTransport();
    transport.enqueue(jsonResponse(200, makeTestJwt(NOW_MS / 1000 + 7200)));
    transport.enqueue(jsonResponse(200, { ok: true }));

    await new PersonalApiClient(clientOptions(transport, file, cache)).get('/example');

    expect((await stat(cache)).mode & 0o777).toBe(0o600);
  });
});

describe('PersonalApiClient request behavior', () => {
  it('refreshes once after a data 401 and retries with the new token', async () => {
    const file = await keyFile();
    const transport = new FakeTransport();
    const oldToken = makeTestJwt(NOW_MS / 1000 + 7200, 'old');
    const newToken = makeTestJwt(NOW_MS / 1000 + 7200, 'new');
    transport.enqueue(jsonResponse(200, oldToken));
    transport.enqueue(jsonResponse(401, { message: 'expired' }));
    transport.enqueue(jsonResponse(200, newToken));
    transport.enqueue(jsonResponse(200, { ok: true }));
    const client = new PersonalApiClient(clientOptions(transport, file, path.join(await tempDir(), 'token.json')));

    await expect(client.get('/example')).resolves.toEqual({ ok: true });

    const dataCalls = transport.calls.filter((call) => call.method === 'GET');
    expect(dataCalls).toHaveLength(2);
    expect(dataCalls[0]?.headers.Authorization).toBe(`Bearer ${oldToken}`);
    expect(dataCalls[1]?.headers.Authorization).toBe(`Bearer ${newToken}`);
  });

  it('fails after a second data 401 without another token exchange', async () => {
    const file = await keyFile();
    const transport = new FakeTransport();
    transport.enqueue(jsonResponse(200, makeTestJwt(NOW_MS / 1000 + 7200, 'old')));
    transport.enqueue(jsonResponse(401, null));
    transport.enqueue(jsonResponse(200, makeTestJwt(NOW_MS / 1000 + 7200, 'new')));
    transport.enqueue(jsonResponse(401, null));
    const client = new PersonalApiClient(clientOptions(transport, file, path.join(await tempDir(), 'token.json')));

    await expect(client.get('/example')).rejects.toMatchObject({ code: 'authentication_failed', status: 401 });
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
    expect(transport.calls.filter((call) => call.method === 'GET')).toHaveLength(2);
  });

  it('does not retry token authentication failures or expose the key', async () => {
    const file = await keyFile();
    const logs: string[] = [];
    const transport = new FakeTransport();
    transport.enqueue(jsonResponse(401, { message: `invalid ${TEST_API_KEY}` }));
    const client = new PersonalApiClient(clientOptions(transport, file, path.join(await tempDir(), 'token.json'), logs));

    let error: unknown;
    await client.get('/example').catch((caught: unknown) => { error = caught; });

    expect(error).toBeInstanceOf(PersonalApiError);
    expect(error).toMatchObject({ code: 'authentication_failed', status: 401 });
    expect(String(error)).not.toContain(TEST_API_KEY);
    expect(logs.join('\n')).not.toContain(TEST_API_KEY);
    expect(transport.calls).toHaveLength(1);
  });

  it('honors Retry-After for a 429 response', async () => {
    const file = await keyFile();
    const transport = new FakeTransport();
    transport.enqueue(jsonResponse(200, makeTestJwt(NOW_MS / 1000 + 7200)));
    transport.enqueue(jsonResponse(429, null, { 'retry-after': '1' }));
    transport.enqueue(jsonResponse(200, { ok: true }));
    const delays: number[] = [];
    const options = {
      ...clientOptions(transport, file, path.join(await tempDir(), 'token.json')),
      sleep: async (ms: number) => { delays.push(ms); },
    };
    const client = new PersonalApiClient(options);

    await expect(client.get('/example')).resolves.toEqual({ ok: true });
    expect(delays).toEqual([1000]);
  });

  it('limits 5xx retries and reports a sanitized server error', async () => {
    const file = await keyFile();
    const transport = new FakeTransport();
    transport.enqueue(jsonResponse(200, makeTestJwt(NOW_MS / 1000 + 7200)));
    transport.enqueue(jsonResponse(500, { message: TEST_API_KEY }));
    transport.enqueue(jsonResponse(502, null));
    transport.enqueue(jsonResponse(503, null));
    const client = new PersonalApiClient(clientOptions(transport, file, path.join(await tempDir(), 'token.json')));

    await expect(client.get('/example')).rejects.toMatchObject({ code: 'server_unavailable', status: 503 });
    expect(transport.calls.filter((call) => call.method === 'GET')).toHaveLength(3);
  });

  it('retries token request timeouts with bounded exponential backoff', async () => {
    const file = await keyFile();
    const transport = new FakeTransport();
    transport.enqueue(new HttpTransportError('timeout', 'socket timeout'));
    transport.enqueue(new HttpTransportError('timeout', 'socket timeout'));
    transport.enqueue(new HttpTransportError('timeout', 'socket timeout'));
    const delays: number[] = [];
    const client = new PersonalApiClient({
      ...clientOptions(transport, file, path.join(await tempDir(), 'token.json')),
      sleep: async (ms: number) => { delays.push(ms); },
    });

    await expect(client.get('/example')).rejects.toMatchObject({ code: 'timeout', retryable: true });
    expect(transport.calls).toHaveLength(3);
    expect(delays).toEqual([250, 500]);
  });

  it('retries a network failure and then returns data', async () => {
    const file = await keyFile();
    const transport = new FakeTransport();
    transport.enqueue(jsonResponse(200, makeTestJwt(NOW_MS / 1000 + 7200)));
    transport.enqueue(new HttpTransportError('network', 'connection reset'));
    transport.enqueue(jsonResponse(200, { ok: true }));
    const client = new PersonalApiClient(clientOptions(transport, file, path.join(await tempDir(), 'token.json')));

    await expect(client.get('/example')).resolves.toEqual({ ok: true });
  });

  it('maps a final network failure to network_error', async () => {
    const file = await keyFile();
    const transport = new FakeTransport();
    transport.enqueue(jsonResponse(200, makeTestJwt(NOW_MS / 1000 + 7200)));
    transport.enqueue(new HttpTransportError('network', 'connection reset'));
    transport.enqueue(new HttpTransportError('network', 'connection reset'));
    transport.enqueue(new HttpTransportError('network', 'connection reset'));
    const client = new PersonalApiClient(clientOptions(transport, file, path.join(await tempDir(), 'token.json')));

    await expect(client.get('/example')).rejects.toMatchObject({ code: 'network_error', retryable: true });
  });

  it('returns null for a 204 response', async () => {
    const file = await keyFile();
    const transport = new FakeTransport();
    transport.enqueue(jsonResponse(200, makeTestJwt(NOW_MS / 1000 + 7200)));
    transport.enqueue(jsonResponse(204, null));
    const client = new PersonalApiClient(clientOptions(transport, file, path.join(await tempDir(), 'token.json')));

    await expect(client.get('/empty')).resolves.toBeNull();
  });

  it('classifies a 404 without retrying it', async () => {
    const file = await keyFile();
    const transport = new FakeTransport();
    transport.enqueue(jsonResponse(200, makeTestJwt(NOW_MS / 1000 + 7200)));
    transport.enqueue(jsonResponse(404, { message: 'not found' }));
    const client = new PersonalApiClient(clientOptions(transport, file, path.join(await tempDir(), 'token.json')));

    await expect(client.get('/missing')).rejects.toMatchObject({ code: 'not_found', retryable: false });
    expect(transport.calls.filter((call) => call.method === 'GET')).toHaveLength(1);
  });

  it('rejects a token response without an exp claim', async () => {
    const file = await keyFile();
    const transport = new FakeTransport();
    transport.enqueue(jsonResponse(200, 'not-a-jwt'));
    const cache = path.join(await tempDir(), 'token.json');
    const client = new PersonalApiClient(clientOptions(transport, file, cache));

    await expect(client.get('/example')).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(readFile(cache, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never writes secrets to success or failure logs', async () => {
    const file = await keyFile();
    const logs: string[] = [];
    const transport = new FakeTransport();
    const token = makeTestJwt(NOW_MS / 1000 + 7200);
    transport.enqueue(jsonResponse(200, token));
    transport.enqueue(jsonResponse(500, { token, key: TEST_API_KEY }));
    transport.enqueue(jsonResponse(500, { token, key: TEST_API_KEY }));
    transport.enqueue(jsonResponse(500, { token, key: TEST_API_KEY }));
    const client = new PersonalApiClient(clientOptions(transport, file, path.join(await tempDir(), 'token.json'), logs));

    await expect(client.get('/example')).rejects.toBeInstanceOf(PersonalApiError);
    const logged = logs.join('\n');
    expect(logged).not.toContain(TEST_API_KEY);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain('Authorization');
  });
});

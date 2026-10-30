import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PersonalApiError } from './errors';
import {
  AxiosHttpTransport,
  HttpTransportError,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type QueryParams,
} from './http-transport';
import { expandHomePath } from './paths';
import { redactSecrets } from './redaction';

const BASE_URL = 'https://personal.connectapi.garmin.com';
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
const DEFAULT_API_KEY_FILE = path.join(os.homedir(), '.config', 'garmin', 'api_key');
const DEFAULT_TOKEN_CACHE_FILE = path.join(os.homedir(), '.config', 'garmin', 'access_token.json');
const TOKEN_REFRESH_WINDOW_SECONDS = 3600;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5000;
const DEFAULT_TIMEOUT_MS = 30_000;

type AccessToken = {
  accessToken: string;
  expiresAt: number;
};

type TokenCache = AccessToken & {
  fingerprint: string;
};

export type PersonalApiClientOptions = {
  apiKeyFile?: string;
  tokenCacheFile?: string;
  transport?: HttpTransport;
  now?: () => number;
  timeoutMs?: number;
  logger?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

export class PersonalApiClient {
  private readonly apiKeyFile: string;
  private readonly tokenCacheFile: string;
  private readonly transport: HttpTransport;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly logger: (message: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private token: AccessToken | null = null;
  private tokenPromise: Promise<AccessToken> | null = null;

  constructor(options: PersonalApiClientOptions = {}) {
    this.apiKeyFile = expandHomePath(options.apiKeyFile ?? process.env.GARMIN_API_KEY_FILE ?? DEFAULT_API_KEY_FILE);
    this.tokenCacheFile = expandHomePath(options.tokenCacheFile ?? process.env.GARMIN_TOKEN_CACHE_FILE ?? DEFAULT_TOKEN_CACHE_FILE);
    this.transport = options.transport ?? new AxiosHttpTransport();
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger ?? ((message: string) => console.error(message));
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new PersonalApiError('invalid_config', 'Request timeout must be greater than zero');
    }
  }

  async getCacheNamespace(): Promise<string> {
    const apiKey = await this.readApiKey();
    return createHash('sha256').update(`${BASE_URL}\0${apiKey}`).digest('hex');
  }

  async get<T>(pathName: string, params?: QueryParams): Promise<T | null> {
    if (!pathName.startsWith('/') || pathName.includes('://')) {
      throw new PersonalApiError('invalid_config', 'Personal API path must be relative');
    }

    let refreshed = false;
    while (true) {
      const token = await this.getAccessToken(refreshed);
      const response = await this.requestWithRetry({
        method: 'GET',
        url: `${BASE_URL}${pathName}`,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token.accessToken}`,
        },
        params,
        timeoutMs: this.timeoutMs,
      }, pathName);

      if (response.status === 204) return null;
      if (response.status >= 200 && response.status < 300) return response.data as T;
      if (response.status === 404) {
        throw new PersonalApiError('not_found', 'Garmin resource was not found', { status: 404 });
      }
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new PersonalApiError('authentication_failed', 'Garmin authentication failed', {
          status: response.status,
        });
      }
      throw new PersonalApiError('http_error', `Garmin request failed with status ${response.status}`, {
        status: response.status,
      });
    }
  }

  private async getAccessToken(forceRefresh: boolean): Promise<AccessToken> {
    if (!forceRefresh && this.token && this.isTokenUsable(this.token)) return this.token;
    if (this.tokenPromise) return this.tokenPromise;

    this.tokenPromise = this.acquireToken(forceRefresh).finally(() => {
      this.tokenPromise = null;
    });
    return this.tokenPromise;
  }

  private async acquireToken(forceRefresh: boolean): Promise<AccessToken> {
    const apiKey = await this.readApiKey();
    const fingerprint = createHash('sha256').update(`${BASE_URL}\0${apiKey}`).digest('hex');

    if (!forceRefresh) {
      const cached = await this.readTokenCache();
      if (cached?.fingerprint === fingerprint && this.isTokenUsable(cached)) {
        this.token = { accessToken: cached.accessToken, expiresAt: cached.expiresAt };
        return this.token;
      }
    }

    const response = await this.requestWithRetry({
      method: 'POST',
      url: `${BASE_URL}${TOKEN_PATH}`,
      headers: {
        Accept: '*/*',
        Authorization: `ApiKey ${apiKey}`,
      },
      timeoutMs: this.timeoutMs,
      responseType: 'text',
    }, TOKEN_PATH);

    if (response.status === 401 || response.status === 403) {
      throw new PersonalApiError('authentication_failed', 'Garmin Personal API key was rejected', {
        status: response.status,
      });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new PersonalApiError('http_error', `Garmin token request failed with status ${response.status}`, {
        status: response.status,
      });
    }
    if (typeof response.data !== 'string') {
      throw new PersonalApiError('invalid_token', 'Garmin token response was not a JWT');
    }

    const accessToken = response.data.trim();
    const token = { accessToken, expiresAt: this.readJwtExpiration(accessToken) };
    await this.writeTokenCache({ ...token, fingerprint });
    this.token = token;
    return token;
  }

  private async readApiKey(): Promise<string> {
    let contents: string;
    try {
      contents = await readFile(this.apiKeyFile, 'utf8');
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new PersonalApiError(
        code === 'ENOENT' ? 'missing_api_key' : 'invalid_api_key_file',
        code === 'ENOENT' ? 'Garmin Personal API key file is missing' : 'Garmin Personal API key file is unreadable',
      );
    }

    const apiKey = contents.trim();
    if (!apiKey) throw new PersonalApiError('empty_api_key', 'Garmin Personal API key file is empty');
    return apiKey;
  }

  private async readTokenCache(): Promise<TokenCache | null> {
    try {
      const cache = JSON.parse(await readFile(this.tokenCacheFile, 'utf8')) as Partial<TokenCache>;
      if (
        typeof cache.accessToken !== 'string' ||
        typeof cache.expiresAt !== 'number' ||
        typeof cache.fingerprint !== 'string'
      ) {
        return null;
      }
      return cache as TokenCache;
    } catch {
      return null;
    }
  }

  private async writeTokenCache(cache: TokenCache): Promise<void> {
    const temporary = `${this.tokenCacheFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(this.tokenCacheFile), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(cache), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.tokenCacheFile);
    } catch {
      throw new PersonalApiError('cache_error', 'Unable to write the Garmin token cache');
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private readJwtExpiration(token: string): number {
    try {
      const payload = token.split('.')[1];
      if (!payload) throw new Error('missing payload');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
      if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) throw new Error('missing exp');
      return claims.exp;
    } catch {
      throw new PersonalApiError('invalid_token', 'Garmin token response did not contain a valid JWT exp claim');
    }
  }

  private isTokenUsable(token: AccessToken): boolean {
    return token.expiresAt - this.now() / 1000 > TOKEN_REFRESH_WINDOW_SECONDS;
  }

  private async requestWithRetry(request: HttpRequest, pathName: string): Promise<HttpResponse<unknown>> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      this.log(`Garmin ${request.method} ${pathName} attempt ${attempt}`, request.headers.Authorization);
      try {
        const response = await this.transport.request(request);
        if (response.status === 429 || response.status >= 500) {
          if (attempt < MAX_ATTEMPTS) {
            const delay = this.retryDelay(response, attempt);
            this.log(`Garmin ${request.method} ${pathName} retry after ${delay}ms`, request.headers.Authorization);
            await this.sleep(delay);
            continue;
          }
          throw new PersonalApiError(
            response.status === 429 ? 'rate_limited' : 'server_unavailable',
            response.status === 429 ? 'Garmin rate limit was exceeded' : 'Garmin service is unavailable',
            { status: response.status, retryable: true },
          );
        }
        return response;
      } catch (error: unknown) {
        if (error instanceof PersonalApiError) throw error;
        if (!(error instanceof HttpTransportError)) {
          throw new PersonalApiError('network_error', 'Garmin request failed unexpectedly');
        }
        if (attempt === MAX_ATTEMPTS) {
          throw new PersonalApiError(
            error.kind === 'timeout' ? 'timeout' : 'network_error',
            error.kind === 'timeout' ? 'Garmin request timed out' : 'Garmin network request failed',
            { retryable: true },
          );
        }
        const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
        await this.sleep(delay);
      }
    }
    throw new PersonalApiError('network_error', 'Garmin request failed unexpectedly');
  }

  private retryDelay(response: HttpResponse<unknown>, attempt: number): number {
    const exponential = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
    const header = response.headers['retry-after'];
    if (!header) return exponential;

    const seconds = Number(header);
    const retryAt = Number.isFinite(seconds)
      ? this.now() + seconds * 1000
      : Date.parse(header);
    if (!Number.isFinite(retryAt)) return exponential;
    return Math.min(Math.max(exponential, retryAt - this.now()), MAX_RETRY_DELAY_MS);
  }

  private log(message: string, secret?: string): void {
    this.logger(redactSecrets(message, [secret]));
  }
}

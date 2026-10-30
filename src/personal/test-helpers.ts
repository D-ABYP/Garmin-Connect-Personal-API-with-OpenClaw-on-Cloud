import type { HttpRequest, HttpResponse, HttpTransport } from './http-transport';

export const TEST_API_KEY = 'test-api-key-not-a-real-secret';
export const SECOND_TEST_API_KEY = 'second-test-api-key-not-a-real-secret';
export const NOW_MS = 1_800_000_000_000;

export function makeTestJwt(expiresAtSeconds: number, marker = 'fake-access-token'): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp: expiresAtSeconds, sub: marker })}.fake-signature`;
}

export function jsonResponse<T>(status: number, data: T, headers: Record<string, string> = {}): HttpResponse<T> {
  return { status, data, headers };
}

type FakeTransportResult = HttpResponse<unknown> | Error | ((request: HttpRequest) => HttpResponse<unknown> | Error);

export class FakeTransport implements HttpTransport {
  readonly calls: HttpRequest[] = [];
  private readonly results: FakeTransportResult[] = [];

  enqueue(result: FakeTransportResult): void {
    this.results.push(result);
  }

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.calls.push(request);
    const result = this.results.shift();
    if (!result) throw new Error(`Unexpected ${request.method} ${request.url}`);
    const resolved = typeof result === 'function' ? result(request) : result;
    if (resolved instanceof Error) throw resolved;
    return resolved as HttpResponse<T>;
  }
}

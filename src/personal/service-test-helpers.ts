import type { QueryParams } from './http-transport';

type Route = {
  path: string;
  params: QueryParams;
  result: unknown;
  error?: Error;
};

export class FakePersonalApiClient {
  readonly calls: Array<{ path: string; params: QueryParams }> = [];
  private readonly routes: Route[] = [];

  when(path: string, result: unknown, params: QueryParams = {}): void {
    this.routes.push({ path, params, result });
  }

  whenError(path: string, error: Error, params: QueryParams = {}): void {
    this.routes.push({ path, params, result: null, error });
  }

  async get<T>(path: string, params: QueryParams = {}): Promise<T | null> {
    this.calls.push({ path, params });
    const route = [...this.routes].reverse().find((candidate) =>
      candidate.path === path && JSON.stringify(candidate.params) === JSON.stringify(params));
    if (!route) throw new Error(`Unexpected Personal API route: ${path} ${JSON.stringify(params)}`);
    if (route.error) throw route.error;
    return route.result as T;
  }
}

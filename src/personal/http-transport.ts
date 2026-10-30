import axios from 'axios';

export type QueryParams = Record<string, string | number | boolean>;

export type HttpRequest = {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  params?: QueryParams;
  timeoutMs: number;
  responseType?: 'json' | 'text';
};

export type HttpResponse<T> = {
  status: number;
  data: T;
  headers: Record<string, string>;
};

export interface HttpTransport {
  request<T>(request: HttpRequest): Promise<HttpResponse<T>>;
}

export class HttpTransportError extends Error {
  readonly kind: 'timeout' | 'network';

  constructor(kind: 'timeout' | 'network', message: string) {
    super(message);
    this.name = 'HttpTransportError';
    this.kind = kind;
  }
}

function responseHeaders(headers: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value.join(', ') : String(value ?? ''),
    ]),
  );
}

export class AxiosHttpTransport implements HttpTransport {
  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    try {
      const response = await axios.request<T>({
        method: request.method,
        url: request.url,
        headers: request.headers,
        params: request.params,
        timeout: request.timeoutMs,
        responseType: request.responseType ?? 'json',
        validateStatus: () => true,
      });
      return {
        status: response.status,
        data: response.data,
        headers: responseHeaders(response.headers as Record<string, unknown>),
      };
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        const isTimeout = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
        throw new HttpTransportError(isTimeout ? 'timeout' : 'network', 'Garmin request failed');
      }
      throw error;
    }
  }
}

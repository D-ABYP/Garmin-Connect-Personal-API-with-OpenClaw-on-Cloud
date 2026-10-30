export type PersonalApiErrorCode =
  | 'missing_api_key'
  | 'empty_api_key'
  | 'invalid_api_key_file'
  | 'invalid_token'
  | 'authentication_failed'
  | 'rate_limited'
  | 'server_unavailable'
  | 'timeout'
  | 'network_error'
  | 'not_found'
  | 'invalid_response'
  | 'http_error'
  | 'cache_error'
  | 'invalid_config';

export class PersonalApiError extends Error {
  readonly code: PersonalApiErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(code: PersonalApiErrorCode, message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'PersonalApiError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

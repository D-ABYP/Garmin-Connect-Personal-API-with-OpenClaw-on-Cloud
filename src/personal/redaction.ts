const AUTHORIZATION_PATTERN = /\b(Bearer|ApiKey)\s+[^\s,;]+/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const CREDENTIAL_FIELD_PATTERN = /(["']?(?:access_token|refresh_token|api_key|password|authorization)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi;

export function redactSecrets(value: unknown, secrets: Array<string | undefined> = []): string {
  let text = typeof value === 'string' ? value : String(value);

  for (const secret of secrets.filter((item): item is string => Boolean(item)).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('[REDACTED]');
  }

  return text
    .replace(AUTHORIZATION_PATTERN, '$1 [REDACTED]')
    .replace(JWT_PATTERN, '[REDACTED]')
    .replace(CREDENTIAL_FIELD_PATTERN, '$1[REDACTED]');
}

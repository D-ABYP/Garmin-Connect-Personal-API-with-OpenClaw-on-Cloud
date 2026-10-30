import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redaction';
import { TEST_API_KEY, makeTestJwt } from './test-helpers';

describe('redactSecrets', () => {
  it('removes explicit secrets and authorization values', () => {
    const token = makeTestJwt(1_800_003_600);
    const message = `ApiKey ${TEST_API_KEY} Bearer ${token} authorization=another-secret`;

    const redacted = redactSecrets(message, [TEST_API_KEY, token, 'another-secret']);

    expect(redacted).not.toContain(TEST_API_KEY);
    expect(redacted).not.toContain(token);
    expect(redacted).not.toContain('another-secret');
    expect(redacted).toContain('[REDACTED]');
  });

  it('removes JWTs and authorization schemes even without an explicit secret list', () => {
    const token = makeTestJwt(1_800_003_600);

    const redacted = redactSecrets(`Bearer ${token}; ApiKey unknown-test-value`);

    expect(redacted).not.toContain(token);
    expect(redacted).not.toContain('unknown-test-value');
  });

  it('redacts credential fields in serialized errors', () => {
    const redacted = redactSecrets('{"access_token":"fake-token-value","password":"fake-password"}');

    expect(redacted).not.toContain('fake-token-value');
    expect(redacted).not.toContain('fake-password');
  });

  it('leaves non-sensitive diagnostic text readable', () => {
    expect(redactSecrets('GET /hrv-service/hrv failed with status 429')).toBe(
      'GET /hrv-service/hrv failed with status 429',
    );
  });
});

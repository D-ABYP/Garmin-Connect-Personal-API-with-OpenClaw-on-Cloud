import { describe, expect, it } from 'vitest';
import { assertDate } from './data-service';

describe('assertDate', () => {
  it('accepts real calendar dates including leap day', () => {
    expect(() => assertDate('2024-02-29')).not.toThrow();
    expect(() => assertDate('2026-10-30')).not.toThrow();
  });

  it('rejects normalized dates that do not exist on the calendar', () => {
    expect(() => assertDate('2026-02-30')).toThrowError(
      expect.objectContaining({ code: 'invalid_config' }),
    );
    expect(() => assertDate('2025-02-29')).toThrowError(
      expect.objectContaining({ code: 'invalid_config' }),
    );
  });
});

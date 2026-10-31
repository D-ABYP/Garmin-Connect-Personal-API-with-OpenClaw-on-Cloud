import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PersonalDataService } from './data-service';
import { PersonalApiError } from './errors';
import { FakePersonalApiClient } from './service-test-helpers';

const tempDirs: string[] = [];
const NOW = Date.UTC(2026, 9, 30, 8, 0, 0);
const DATE = '2026-10-30';

async function service(client: FakePersonalApiClient): Promise<PersonalDataService> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'garmin-recovery-test-'));
  tempDirs.push(directory);
  return new PersonalDataService({ client, cacheDirectory: directory, now: () => NOW });
}

function settings(client: FakePersonalApiClient): void {
  client.when('/userprofile-service/userprofile/settings', {
    timeZone: 'Asia/Shanghai',
    firstDayOfWeek: { dayName: 'monday' },
  });
}

function currentRecovery(client: FakePersonalApiClient): void {
  client.when('/sleep-service/sleep/dailySleep', {
    calendarDate: DATE,
    sleepTimeSeconds: 25_200,
    deepSleepSeconds: 5_400,
    sleepScores: { overall: { value: 82, qualifierKey: 'GOOD' } },
  }, { date: DATE });
  client.when(`/hrv-service/hrv/${DATE}`, {
    hrvSummary: { calendarDate: DATE, lastNightAvg: 55, weeklyAvg: 52, status: 'BALANCED' },
  });
  client.when('/usersummary-service/v2/dailysummaries', {
    data: [{
      calendarDate: DATE,
      heartRate: { restingValue: 47 },
      bodyBattery: { latestValue: 76 },
      stress: { avgLevel: 25 },
      respiration: { avgValue: 14 },
    }],
  }, { startDate: DATE, endDate: DATE });
  client.when('/usersummary-service/usersummary/daily', {
    calendarDate: DATE,
    lastSyncTimestampGMT: '2026-10-30T07:30:00.000Z',
  }, { calendarDate: DATE });
}

function historyRecovery(client: FakePersonalApiClient): void {
  const range = { startDate: '2026-10-27', endDate: '2026-10-29' };
  client.when('/sleep-service/sleep/dailySleepSummariesByDate', [
    { calendarDate: '2026-10-27', sleepTimeSeconds: 20_000 },
    { calendarDate: '2026-10-28', sleepTimeSeconds: 22_000 },
    { calendarDate: '2026-10-29', sleepTimeSeconds: 24_000 },
  ], range);
  client.when('/hrv-service/hrv/daily/2026-10-27/2026-10-29', {
    hrvSummaries: [
      { calendarDate: '2026-10-27', lastNightAvg: 40 },
      { calendarDate: '2026-10-28', lastNightAvg: 50 },
      { calendarDate: '2026-10-29', lastNightAvg: 60 },
    ],
  });
  client.when('/usersummary-service/v2/dailysummaries', {
    data: [
      { calendarDate: '2026-10-27', heartRate: { restingValue: 40 }, bodyBattery: { latestValue: 60 }, stress: { avgLevel: 20 }, respiration: { avgValue: 12 } },
      { calendarDate: '2026-10-28', heartRate: { restingValue: 50 }, bodyBattery: { latestValue: 70 }, stress: { avgLevel: 30 }, respiration: { avgValue: 14 } },
      { calendarDate: '2026-10-29', heartRate: { restingValue: 60 }, bodyBattery: { latestValue: 80 }, stress: { avgLevel: 40 }, respiration: { avgValue: 16 } },
    ],
  }, range);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('PersonalDataService.getRecoveryContext', () => {
  it('returns current recovery, historical series, baselines and sync metadata', async () => {
    const client = new FakePersonalApiClient();
    settings(client);
    currentRecovery(client);
    historyRecovery(client);
    const dataService = await service(client);

    const result = await dataService.getRecoveryContext(DATE, 3);

    expect(result.meta).toMatchObject({ date: DATE, startDate: '2026-10-27', endDate: DATE, timezone: 'Asia/Shanghai' });
    expect(result.meta.units.hrv).toBe('ms');
    expect(result.data.sleep).toMatchObject({ sleepTimeSeconds: 25_200 });
    expect(result.data.hrv).toMatchObject({ lastNightAvg: 55 });
    expect(result.data.history.sleep).toHaveLength(3);
    expect(result.data.history.hrv).toHaveLength(3);
    expect(result.data.baselines.sleepTimeSeconds).toMatchObject({ count: 3, mean: 22_000, median: 22_000 });
    expect(result.data.baselines.hrvLastNightAvg).toMatchObject({ count: 3, mean: 50 });
    expect(result.data.baselines.restingHeartRateBpm).toMatchObject({ count: 3, mean: 50 });
    expect(result.data.baselines.bodyBatteryLatest).toMatchObject({ mean: 70 });
    expect(result.data.baselines.stressAvg).toMatchObject({ mean: 30 });
    expect(result.data.baselines.respirationAvg).toMatchObject({ mean: 14 });
    expect(result.data.sync).toMatchObject({ status: 'ok', lagHours: 0.5 });
    expect(result.issues).toEqual([]);
  });

  it('uses cached normalized responses on a repeated call', async () => {
    const client = new FakePersonalApiClient();
    settings(client);
    currentRecovery(client);
    historyRecovery(client);
    const dataService = await service(client);

    await dataService.getRecoveryContext(DATE, 3);
    const callsAfterFirst = client.calls.length;
    const second = await dataService.getRecoveryContext(DATE, 3);

    expect(client.calls).toHaveLength(callsAfterFirst);
    expect(second.meta.cache.hits).toBeGreaterThan(0);
    expect(second.meta.cache.misses).toBe(0);
    expect(JSON.stringify(second)).not.toMatch(/latitude|longitude|polyline/i);
  });

  it('isolates a missing sleep response and preserves other recovery data', async () => {
    const client = new FakePersonalApiClient();
    settings(client);
    currentRecovery(client);
    historyRecovery(client);
    client.whenError('/sleep-service/sleep/dailySleep', new PersonalApiError('not_found', 'not found', { status: 404 }), { date: DATE });
    const dataService = await service(client);

    const result = await dataService.getRecoveryContext(DATE, 3);

    expect(result.data.sleep).toBeNull();
    expect(result.data.hrv).toMatchObject({ lastNightAvg: 55 });
    expect(result.data.history.sleep).toHaveLength(3);
    expect(result.issues).toContainEqual(expect.objectContaining({ path: 'sleep.current', code: 'not_found' }));
    expect(result.data.sync.anomalies).toContain('current_data_incomplete');
  });

  it('records a missing required field without discarding other fields', async () => {
    const client = new FakePersonalApiClient();
    settings(client);
    currentRecovery(client);
    historyRecovery(client);
    client.when('/sleep-service/sleep/dailySleep', {
      calendarDate: DATE,
      deepSleepSeconds: 5_400,
    }, { date: DATE });
    const dataService = await service(client);

    const result = await dataService.getRecoveryContext(DATE, 3);

    expect(result.data.sleep).toMatchObject({ sleepTimeSeconds: null, deepSleepSeconds: 5_400 });
    expect(result.issues).toContainEqual(expect.objectContaining({
      path: 'sleep.current.sleepTimeSeconds',
      code: 'missing_field',
    }));

    const cachedResult = await dataService.getRecoveryContext(DATE, 3);
    expect(cachedResult.issues).toContainEqual(expect.objectContaining({
      path: 'sleep.current.sleepTimeSeconds',
      code: 'missing_field',
    }));
  });

  it('distinguishes an invalid field type from a missing field', async () => {
    const client = new FakePersonalApiClient();
    settings(client);
    currentRecovery(client);
    historyRecovery(client);
    client.when('/sleep-service/sleep/dailySleep', {
      calendarDate: DATE,
      sleepTimeSeconds: 'not-a-number',
    }, { date: DATE });
    const dataService = await service(client);

    const result = await dataService.getRecoveryContext(DATE, 3);

    expect(result.data.sleep?.sleepTimeSeconds).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({
      path: 'sleep.current.sleepTimeSeconds',
      code: 'invalid_field',
    }));
  });

  it('marks an old sync timestamp as stale', async () => {
    const client = new FakePersonalApiClient();
    settings(client);
    currentRecovery(client);
    historyRecovery(client);
    client.when('/usersummary-service/usersummary/daily', {
      calendarDate: DATE,
      lastSyncTimestampGMT: '2026-10-28T08:00:00.000Z',
    }, { calendarDate: DATE });
    const dataService = await service(client);

    const result = await dataService.getRecoveryContext(DATE, 3);

    expect(result.data.sync).toMatchObject({ status: 'stale', lagHours: 48 });
    expect(result.data.sync.anomalies).toContain('sync_stale');
  });

  it('rejects an invalid baseline window before making requests', async () => {
    const client = new FakePersonalApiClient();
    const dataService = await service(client);

    await expect(dataService.getRecoveryContext(DATE, 0)).rejects.toMatchObject({ code: 'invalid_config' });
    expect(client.calls).toHaveLength(0);
  });
});

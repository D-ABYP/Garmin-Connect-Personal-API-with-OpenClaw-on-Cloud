import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PersonalDataService } from './data-service';
import { FakePersonalApiClient } from './service-test-helpers';

const tempDirs: string[] = [];
const NOW = Date.UTC(2026, 9, 30, 8, 0, 0);
const DATE = '2026-10-30';
const RANGE = { startDate: '2026-10-02', endDate: '2026-10-29' };

async function service(client: FakePersonalApiClient): Promise<PersonalDataService> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'garmin-baseline-28-test-'));
  tempDirs.push(directory);
  return new PersonalDataService({ client, cacheDirectory: directory, now: () => NOW });
}

function configure(client: FakePersonalApiClient, mode: 'full' | 'empty' | 'partial'): void {
  client.when('/userprofile-service/userprofile/settings', {
    timeZone: 'Asia/Shanghai',
    firstDayOfWeek: { dayName: 'monday' },
  });
  client.when('/sleep-service/sleep/dailySleep', {
    calendarDate: DATE,
    sleepTimeSeconds: 25_200,
  }, { date: DATE });
  client.when(`/hrv-service/hrv/${DATE}`, {
    hrvSummary: { calendarDate: DATE, lastNightAvg: 60 },
  });
  client.when('/usersummary-service/v2/dailysummaries', {
    data: [{ calendarDate: DATE, heartRate: { restingValue: 55 } }],
  }, { startDate: DATE, endDate: DATE });
  client.when('/usersummary-service/usersummary/daily', {
    calendarDate: DATE,
    lastSyncTimestampGMT: '2026-10-30T07:30:00Z',
  }, { calendarDate: DATE });

  const days = mode === 'empty' ? [] : Array.from({ length: 28 }, (_, index) => index);
  client.when('/sleep-service/sleep/dailySleepSummariesByDate', days.map((index) => ({
    calendarDate: `2026-10-${String(index + 2).padStart(2, '0')}`,
    sleepTimeSeconds: mode === 'partial' && index === 0 ? null : 20_000 + index * 100,
  })), RANGE);
  client.when(`/hrv-service/hrv/daily/${RANGE.startDate}/${RANGE.endDate}`, {
    hrvSummaries: days.map((index) => ({
      calendarDate: `2026-10-${String(index + 2).padStart(2, '0')}`,
      lastNightAvg: 40 + index,
    })),
  });
  client.when('/usersummary-service/v2/dailysummaries', {
    data: days.map((index) => ({
      calendarDate: `2026-10-${String(index + 2).padStart(2, '0')}`,
      heartRate: { restingValue: 50 + index },
      bodyBattery: { latestValue: 60 + index },
      stress: { avgLevel: 20 + index },
      respiration: { avgValue: 12 + index },
    })),
  }, RANGE);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('28-day recovery baseline', () => {
  it('uses the exact prior 28 days by default and excludes the report day', async () => {
    const client = new FakePersonalApiClient();
    configure(client, 'full');
    const dataService = await service(client);

    const result = await dataService.getRecoveryContext(DATE);

    expect(result.meta).toMatchObject({ startDate: '2026-10-02', endDate: DATE });
    expect(result.data.history.sleep).toHaveLength(28);
    expect(result.data.history.sleep?.[27]?.calendarDate).toBe('2026-10-29');
    expect(result.data.baselines.sleepTimeSeconds).toMatchObject({ count: 28, mean: 21_350 });
    expect(result.data.baselines.hrvLastNightAvg).toMatchObject({ count: 28, mean: 53.5 });
    expect(result.data.baselines.restingHeartRateBpm).toMatchObject({ count: 28, mean: 63.5 });
  });

  it('returns null baselines for an empty 28-day history', async () => {
    const client = new FakePersonalApiClient();
    configure(client, 'empty');
    const dataService = await service(client);

    const result = await dataService.getRecoveryContext(DATE);

    expect(result.data.history.sleep).toEqual([]);
    for (const baseline of Object.values(result.data.baselines)) {
      expect(baseline).toBeNull();
    }
  });

  it('uses only actual samples when some values are missing', async () => {
    const client = new FakePersonalApiClient();
    configure(client, 'partial');
    const dataService = await service(client);

    const result = await dataService.getRecoveryContext(DATE);

    expect(result.data.baselines.sleepTimeSeconds).toMatchObject({ count: 27, mean: 21_400 });
    expect(result.data.baselines.hrvLastNightAvg).toMatchObject({ count: 28, mean: 53.5 });
  });
});

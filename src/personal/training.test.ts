import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PersonalDataService, shiftDate } from './data-service';
import { PersonalApiError } from './errors';
import { FakePersonalApiClient } from './service-test-helpers';

const tempDirs: string[] = [];
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const DATE = '2026-10-30';
const ACTIVITY_PATH = '/activitylist-service/activities/search/activities';

async function service(client: FakePersonalApiClient): Promise<PersonalDataService> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'garmin-training-test-'));
  tempDirs.push(directory);
  return new PersonalDataService({ client, cacheDirectory: directory, now: () => NOW });
}

function settings(client: FakePersonalApiClient): void {
  client.when('/userprofile-service/userprofile/settings', {
    timeZone: 'Asia/Shanghai',
    firstDayOfWeek: { dayName: 'monday' },
  });
}

function activity(activityId: number, date = DATE): Record<string, unknown> {
  return {
    activityId,
    activityName: `Run ${activityId}`,
    activityType: { typeKey: 'running' },
    startTimeLocal: `${date}T06:30:00`,
    startTimeGMT: `${date}T00:30:00`,
    startLatitude: 31.23,
    startLongitude: 121.47,
    distance: 1_000,
    duration: 60,
    averageSpeed: 4,
    elevationGain: 5,
    averageHR: 140,
    maxHR: 160,
    aerobicTrainingEffect: 2,
    anaerobicTrainingEffect: 0.2,
    activityTrainingLoad: 10,
    hrTimeInZone_1: 30,
    hrTimeInZone_2: 20,
    hrTimeInZone_3: 10,
  };
}

function emptyDays(client: FakePersonalApiClient, startDate: string, endDate: string): void {
  const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000);
  for (let index = 0; index <= days; index++) {
    const date = shiftDate(startDate, index);
    client.when(ACTIVITY_PATH, [], { start: 0, limit: 20, startDate: date, endDate: date });
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('PersonalDataService training contexts', () => {
  it('paginates and deduplicates daily activities and builds weekly trends', async () => {
    const client = new FakePersonalApiClient();
    settings(client);
    emptyDays(client, '2026-10-24', DATE);
    client.when(ACTIVITY_PATH, Array.from({ length: 20 }, (_, index) => activity(index + 1)), {
      start: 0, limit: 20, startDate: DATE, endDate: DATE,
    });
    client.when(ACTIVITY_PATH, [activity(20), activity(21)], {
      start: 20, limit: 20, startDate: DATE, endDate: DATE,
    });
    client.when('/usersummary-service/usersummary/daily', {
      calendarDate: DATE,
      totalSteps: 9_000,
      totalDistanceMeters: 7_000,
      totalKilocalories: 2_200,
      moderateIntensityMinutes: 20,
      vigorousIntensityMinutes: 30,
      lastSyncTimestampGMT: '2026-10-30T11:00:00Z',
    }, { calendarDate: DATE });
    const dataService = await service(client);

    const result = await dataService.getTrainingDayContext(DATE, 7);

    expect(result.data.activities).toMatchObject({ complete: true, missingDays: [] });
    expect(result.data.activities.items).toHaveLength(21);
    expect(result.data.health).toMatchObject({ totalSteps: 9_000 });
    expect(result.data.history).toHaveLength(2);
    expect(result.data.history[0]).toMatchObject({
      complete: false,
      activityCount: null,
      durationSeconds: null,
      trainingLoad: null,
    });
    expect(result.data.history[0]?.missingDays).toEqual([
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
    ]);
    const week = result.data.history.find((item) => item.activityCount === 21);
    expect(week).toMatchObject({
      activityCount: 21,
      durationSeconds: 1_260,
      distanceMeters: 21_000,
      trainingLoad: 210,
      heartRateZonesSeconds: { zone1: 630, zone2: 420, zone3: 210, zone4: null, zone5: null },
    });
    expect(week?.majorSports[0]).toMatchObject({ activityType: 'running', count: 21, durationSeconds: 1_260 });
    expect(JSON.stringify(result)).not.toMatch(/latitude|longitude|polyline/i);
  });

  it('keeps partial history and identifies a failed day without inventing zeros', async () => {
    const client = new FakePersonalApiClient();
    settings(client);
    emptyDays(client, '2026-10-28', DATE);
    client.when(ACTIVITY_PATH, [activity(1, '2026-10-28')], {
      start: 0, limit: 20, startDate: '2026-10-28', endDate: '2026-10-28',
    });
    client.whenError(ACTIVITY_PATH, new PersonalApiError('server_unavailable', 'unavailable', { status: 503, retryable: true }), {
      start: 0, limit: 20, startDate: '2026-10-29', endDate: '2026-10-29',
    });
    client.when('/usersummary-service/usersummary/daily', { calendarDate: DATE }, { calendarDate: DATE });
    const dataService = await service(client);

    const result = await dataService.getTrainingDayContext(DATE, 3);

    expect(result.data.activities.items).toHaveLength(1);
    expect(result.data.activities).toMatchObject({ complete: false, missingDays: ['2026-10-29'] });
    expect(result.data.history[0]).toMatchObject({ complete: false, activityCount: 1 });
    expect(result.issues).toContainEqual(expect.objectContaining({
      path: 'activities.2026-10-29',
      code: 'server_unavailable',
      retryable: true,
    }));
  });

  it('returns null aggregates for an empty week whose activity reads failed', async () => {
    const client = new FakePersonalApiClient();
    settings(client);
    emptyDays(client, '2026-10-24', DATE);
    for (let index = 0; index < 7; index++) {
      const date = shiftDate('2026-10-24', index);
      client.whenError(ACTIVITY_PATH, new PersonalApiError('server_unavailable', 'unavailable', { status: 503, retryable: true }), {
        start: 0, limit: 20, startDate: date, endDate: date,
      });
    }
    client.when('/usersummary-service/usersummary/daily', { calendarDate: DATE }, { calendarDate: DATE });
    const dataService = await service(client);

    const result = await dataService.getTrainingDayContext(DATE, 7);

    expect(result.data.activities.items).toHaveLength(0);
    expect(result.data.history).toHaveLength(2);
    for (const week of result.data.history) {
      expect(week).toMatchObject({
        complete: false,
        activityCount: null,
        durationSeconds: null,
        trainingLoad: null,
      });
    }
  });

  it('records an explicit issue when the week-start fallback is used', async () => {
    const client = new FakePersonalApiClient();
    client.when('/userprofile-service/userprofile/settings', { timeZone: 'Asia/Shanghai' });
    emptyDays(client, DATE, DATE);
    client.when('/usersummary-service/usersummary/daily', { calendarDate: DATE }, { calendarDate: DATE });
    const dataService = await service(client);

    const result = await dataService.getTrainingDayContext(DATE, 1);

    expect(result.issues).toContainEqual(expect.objectContaining({
      path: 'settings.firstDayOfWeek',
      code: 'missing_field',
    }));
  });

  it('summarizes a 56-day history by week', async () => {
    const client = new FakePersonalApiClient();
    settings(client);
    emptyDays(client, '2026-09-05', DATE);
    client.when(ACTIVITY_PATH, [activity(1, '2026-09-10')], {
      start: 0, limit: 20, startDate: '2026-09-10', endDate: '2026-09-10',
    });
    client.when(ACTIVITY_PATH, [activity(2, DATE)], {
      start: 0, limit: 20, startDate: DATE, endDate: DATE,
    });
    const dataService = await service(client);

    const result = await dataService.getTrainingHistory('2026-09-05', DATE);

    expect(result.data.coverage).toEqual({ complete: true, missingDays: [] });
    expect(result.data.weeks.reduce((sum, week) => sum + (week.activityCount ?? 0), 0)).toBe(2);
    expect(result.data.weeks.reduce((sum, week) => sum + (week.durationSeconds ?? 0), 0)).toBe(120);
    expect(result.meta).toMatchObject({ startDate: '2026-09-05', endDate: DATE, timezone: 'Asia/Shanghai' });
  });

  it('uses cached daily activity shards on repeated history calls', async () => {
    const client = new FakePersonalApiClient();
    settings(client);
    emptyDays(client, '2026-09-05', DATE);
    const dataService = await service(client);

    await dataService.getTrainingHistory('2026-09-05', DATE);
    const callsAfterFirst = client.calls.length;
    const result = await dataService.getTrainingHistory('2026-09-05', DATE);

    expect(client.calls).toHaveLength(callsAfterFirst);
    expect(result.meta.cache.misses).toBe(0);
    expect(result.meta.cache.hits).toBeGreaterThan(50);
  });

  it('rejects ranges outside eight to twelve weeks', async () => {
    const client = new FakePersonalApiClient();
    const dataService = await service(client);

    await expect(dataService.getTrainingHistory('2026-10-01', DATE)).rejects.toMatchObject({ code: 'invalid_config' });
    await expect(dataService.getTrainingHistory('2026-07-01', DATE)).rejects.toMatchObject({ code: 'invalid_config' });
    expect(client.calls).toHaveLength(0);
  });
});

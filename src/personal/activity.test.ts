import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PersonalDataService } from './data-service';
import { PersonalApiError } from './errors';
import { FakePersonalApiClient } from './service-test-helpers';

const tempDirs: string[] = [];
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

async function service(client: FakePersonalApiClient): Promise<PersonalDataService> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'garmin-activity-test-'));
  tempDirs.push(directory);
  return new PersonalDataService({ client, cacheDirectory: directory, now: () => NOW });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('PersonalDataService.getActivityDetails', () => {
  it('returns documented detail and splits, supplements HR zones, and removes locations', async () => {
    const client = new FakePersonalApiClient();
    client.when('/activity-service/activity/123', {
      activityId: 123,
      activityName: 'Morning run',
      activityTypeDTO: { typeKey: 'running' },
      timeZoneUnitDTO: { timeZone: 'Asia/Shanghai' },
      startLatitude: 31.23,
      startLongitude: 121.47,
      summaryDTO: {
        startTimeLocal: '2026-10-30T06:30:00',
        startTimeGMT: '2026-10-29T22:30:00',
        startLatitude: 31.23,
        startLongitude: 121.47,
        distance: 10_000,
        duration: 3_000,
        averageSpeed: 4,
        elevationGain: 80,
        averageHR: 145,
        maxHR: 170,
        trainingEffect: 3.1,
      },
      splitSummaries: [{
        splitType: 'MARKER_KILOMETER',
        noOfSplits: 1,
        startLatitude: 31.23,
        startLongitude: 121.47,
        distance: 1_000,
        duration: 300,
        averageSpeed: 4,
        averageHR: 140,
      }],
    });
    client.when('/activitylist-service/activities/search/activities', [{
      activityId: 123,
      activityType: { typeKey: 'running' },
      startTimeLocal: '2026-10-30T06:30:00',
      hrTimeInZone_1: 60,
      hrTimeInZone_2: 240,
      hrTimeInZone_3: 900,
      hrTimeInZone_4: 1_200,
      hrTimeInZone_5: 600,
      endLatitude: 31.23,
      endLongitude: 121.47,
    }], { start: 0, limit: 20, startDate: '2026-10-30', endDate: '2026-10-30' });
    const dataService = await service(client);

    const result = await dataService.getActivityDetails(123);

    expect(result.meta.timezone).toBe('Asia/Shanghai');
    expect(result.data.activity).toMatchObject({
      activityId: 123,
      averagePaceSecondsPerKm: 250,
      heartRateZonesSeconds: { zone1: 60, zone2: 240, zone3: 900, zone4: 1_200, zone5: 600 },
    });
    expect(result.data.activity?.splitSummaries).toHaveLength(1);
    expect(result.data.timeSeries).toEqual({ heartRate: null, pace: null });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'unsupported_field' }));
    expect(JSON.stringify(result)).not.toMatch(/latitude|longitude|polyline|fitFile/i);
  });

  it('returns null activity for a missing detail response', async () => {
    const client = new FakePersonalApiClient();
    client.whenError('/activity-service/activity/999', new PersonalApiError('not_found', 'not found', { status: 404 }));
    const dataService = await service(client);

    const result = await dataService.getActivityDetails(999);

    expect(result.data.activity).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({ path: 'activity.detail', code: 'not_found' }));
  });

  it('writes only sanitized activity data to the local cache', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'garmin-activity-privacy-cache-'));
    tempDirs.push(directory);
    const client = new FakePersonalApiClient();
    client.when('/activity-service/activity/123', {
      activityId: 123,
      startLatitude: 31.23,
      startLongitude: 121.47,
      polyline: [{ latitude: 31.23, longitude: 121.47 }],
      summaryDTO: {
        startTimeLocal: '2026-10-30T06:30:00',
        startLatitude: 31.23,
        startLongitude: 121.47,
        distance: 1_000,
        duration: 300,
      },
    });
    const dataService = new PersonalDataService({ client, cacheDirectory: directory, now: () => NOW });

    await dataService.getActivityDetails(123);

    const files = await readdir(directory);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const contents = await readFile(path.join(directory, file), 'utf8');
      expect(contents).not.toMatch(/latitude|longitude|polyline|fitFile/i);
      expect(contents).not.toContain('31.23');
      expect(contents).not.toContain('121.47');
    }
  });

  it('rejects an invalid activity ID before making requests', async () => {
    const client = new FakePersonalApiClient();
    const dataService = await service(client);

    await expect(dataService.getActivityDetails(0)).rejects.toMatchObject({ code: 'invalid_config' });
    expect(client.calls).toHaveLength(0);
  });
});

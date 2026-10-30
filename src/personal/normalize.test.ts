import { describe, expect, it } from 'vitest';
import {
  normalizeActivity,
  normalizeActivityList,
  normalizeLegacyDailySummary,
  normalizeSleep,
  normalizeV2DailySummary,
} from './normalize';

describe('normalizeActivity', () => {
  it('maps documented activity fields and derives pace without retaining location data', () => {
    const activity = normalizeActivity({
      activityId: 123,
      activityName: 'Morning run',
      activityTypeDTO: { typeKey: 'running' },
      timeZoneUnitDTO: { timeZone: 'Asia/Shanghai' },
      startLatitude: 31.23,
      startLongitude: 121.47,
      polyline: [{ latitude: 31.23, longitude: 121.47 }],
      summaryDTO: {
        startTimeLocal: '2026-10-30T06:30:00',
        startTimeGMT: '2026-10-29T22:30:00',
        startLatitude: 31.23,
        startLongitude: 121.47,
        distance: 10_000,
        duration: 3_000,
        movingDuration: 2_950,
        elapsedDuration: 3_020,
        averageSpeed: 4,
        elevationGain: 85,
        averageHR: 145,
        maxHR: 170,
        trainingEffect: 3.2,
        anaerobicTrainingEffect: 0.4,
        activityTrainingLoad: 110,
      },
      splitSummaries: [{
        splitType: 'MARKER_KILOMETER',
        noOfSplits: 1,
        startLatitude: 31.23,
        startLongitude: 121.47,
        distance: 1_000,
        duration: 300,
        averageSpeed: 4,
        elevationGain: 8,
        averageHR: 140,
        maxHR: 150,
      }],
    });

    expect(activity).toMatchObject({
      activityId: 123,
      activityType: 'running',
      timeZone: 'Asia/Shanghai',
      distanceMeters: 10_000,
      durationSeconds: 3_000,
      averageSpeedMetersPerSecond: 4,
      averagePaceSecondsPerKm: 250,
      elevationGainMeters: 85,
      averageHeartRateBpm: 145,
      trainingEffect: 3.2,
    });
    expect(activity.splitSummaries?.[0]).toMatchObject({
      splitType: 'MARKER_KILOMETER',
      averagePaceSecondsPerKm: 250,
    });
    expect(JSON.stringify(activity)).not.toMatch(/latitude|longitude|polyline|fitFile/i);
  });

  it('keeps heart-rate zones from the documented activity list summary', () => {
    const activities = normalizeActivityList([{
      activityId: 123,
      activityType: { typeKey: 'running' },
      startTimeLocal: '2026-10-30T06:30:00',
      duration: 3_000,
      hrTimeInZone_1: 60,
      hrTimeInZone_2: 240,
      hrTimeInZone_3: 900,
      hrTimeInZone_4: 1_200,
      hrTimeInZone_5: 600,
      aerobicTrainingEffect: 3.2,
      endLatitude: 31.23,
      endLongitude: 121.47,
    }]);

    expect(activities[0]?.heartRateZonesSeconds).toEqual({
      zone1: 60,
      zone2: 240,
      zone3: 900,
      zone4: 1_200,
      zone5: 600,
    });
    expect(JSON.stringify(activities)).not.toMatch(/latitude|longitude/i);
  });

  it('returns null pace when speed is missing or not positive', () => {
    const missing = normalizeActivity({ activityId: 1, summaryDTO: { averageSpeed: null } });
    const zero = normalizeActivity({ activityId: 2, summaryDTO: { averageSpeed: 0 } });

    expect(missing.averagePaceSecondsPerKm).toBeNull();
    expect(zero.averagePaceSecondsPerKm).toBeNull();
  });

  it('rejects a malformed root response instead of inventing an activity', () => {
    expect(() => normalizeActivityList({ data: [] })).toThrowError(
      expect.objectContaining({ code: 'invalid_response' }),
    );
  });
});

describe('normalize health responses', () => {
  it('keeps actual sleep stages and all provided score keys', () => {
    const sleep = normalizeSleep({
      calendarDate: '2026-10-30',
      sleepStartTimestampLocal: '2026-10-29T23:10:00',
      sleepEndTimestampLocal: '2026-10-30T06:40:00',
      sleepTimeSeconds: 25_200,
      deepSleepSeconds: 5_400,
      lightSleepSeconds: 13_200,
      remSleepSeconds: 5_100,
      awakeSleepSeconds: 1_500,
      sleepScores: {
        overall: { value: 82, qualifierKey: 'GOOD' },
        recovery: { value: 75, qualifierKey: 'FAIR' },
      },
    });

    expect(sleep.sleepTimeSeconds).toBe(25_200);
    expect(sleep.sleepScores).toEqual({
      overall: { value: 82, qualifierKey: 'GOOD' },
      recovery: { value: 75, qualifierKey: 'FAIR' },
    });
  });

  it('normalizes numeric epoch sleep timestamps to ISO strings', () => {
    const sleep = normalizeSleep({
      sleepStartTimestampGMT: 1_700_000_000_000,
      sleepEndTimestampGMT: 1_700_000_000,
    });

    expect(sleep.sleepStartTimestampGMT).toBe('2023-11-14T22:13:20.000Z');
    expect(sleep.sleepEndTimestampGMT).toBe('2023-11-14T22:13:20.000Z');
  });

  it('maps V2 recovery values with their documented scales', () => {
    const daily = normalizeV2DailySummary({
      calendarDate: '2026-10-29',
      heartRate: { restingValue: 48 },
      bodyBattery: { latestValue: 76, minValue: 20, maxValue: 90, chargedValue: 55, drainedValue: 30 },
      stress: { avgLevel: 28, maxLevel: 70, qualifier: 'LOW' },
      respiration: { avgValue: 14, minValue: 12, maxValue: 17, latestValue: 15 },
    });

    expect(daily).toMatchObject({
      calendarDate: '2026-10-29',
      restingHeartRateBpm: 48,
      bodyBattery: { latestValue: 76, chargedValue: 55 },
      stress: { avgLevel: 28, qualifier: 'LOW' },
      respiration: { avgValue: 14, latestValue: 15 },
    });
  });

  it('maps daily health totals and the last sync timestamp', () => {
    const daily = normalizeLegacyDailySummary({
      calendarDate: '2026-10-30',
      totalSteps: 8_500,
      totalDistanceMeters: 6_200,
      totalKilocalories: 2_100,
      moderateIntensityMinutes: 20,
      vigorousIntensityMinutes: 25,
      restingHeartRate: 47,
      bodyBatteryMostRecentValue: 70,
      averageStressLevel: 31,
      avgWakingRespirationValue: 14.5,
      lastSyncTimestampGMT: '2026-10-30T08:00:00Z',
    });

    expect(daily).toMatchObject({
      totalSteps: 8_500,
      totalDistanceMeters: 6_200,
      restingHeartRateBpm: 47,
      bodyBattery: { latestValue: 70 },
      stress: { avgLevel: 31 },
      respiration: { avgValue: 14.5 },
      lastSyncTimestampGMT: '2026-10-30T08:00:00Z',
    });
  });
});

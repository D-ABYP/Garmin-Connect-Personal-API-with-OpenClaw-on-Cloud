import { PersonalApiError } from './errors';
import type {
  ActivitySplit,
  DailyHealth,
  HeartRateZonesSeconds,
  HrvSummary,
  NormalizedActivity,
  NormalizedSleep,
  UserContextSettings,
} from './context-types';

type JsonRecord = Record<string, unknown>;

function invalid(message: string): never {
  throw new PersonalApiError('invalid_response', message);
}

function asRecord(value: unknown, message = 'Garmin response must be an object'): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(message);
  return value as JsonRecord;
}

function nestedRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function timestampValue(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const milliseconds = value >= 1_000_000_000_000 ? value : value >= 1_000_000_000 ? value * 1000 : null;
  if (milliseconds === null) return null;
  const timestamp = new Date(milliseconds);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function pace(speed: number | null): number | null {
  return speed && speed > 0 ? 1000 / speed : null;
}

function emptyBodyBattery(): DailyHealth['bodyBattery'] {
  return { latestValue: null, minValue: null, maxValue: null, chargedValue: null, drainedValue: null };
}

function emptyStress(): DailyHealth['stress'] {
  return { avgLevel: null, maxLevel: null, qualifier: null };
}

function emptyRespiration(): DailyHealth['respiration'] {
  return { avgValue: null, minValue: null, maxValue: null, latestValue: null };
}

function normalizeSplit(value: unknown): ActivitySplit {
  const split = asRecord(value, 'Garmin activity split must be an object');
  const speed = numberValue(split.averageSpeed);
  return {
    splitType: stringValue(split.splitType),
    noOfSplits: numberValue(split.noOfSplits),
    startTimeLocal: stringValue(split.startTimeLocal),
    startTimeGMT: stringValue(split.startTimeGMT),
    distanceMeters: numberValue(split.distance),
    durationSeconds: numberValue(split.duration),
    movingDurationSeconds: numberValue(split.movingDuration),
    elapsedDurationSeconds: numberValue(split.elapsedDuration),
    averageSpeedMetersPerSecond: speed,
    averagePaceSecondsPerKm: pace(speed),
    elevationGainMeters: numberValue(split.elevationGain),
    averageHeartRateBpm: numberValue(split.averageHR),
    maxHeartRateBpm: numberValue(split.maxHR),
  };
}

export function normalizeActivity(value: unknown): NormalizedActivity {
  const root = asRecord(value, 'Garmin activity must be an object');
  const activityId = numberValue(root.activityId);
  if (activityId === null) return invalid('Garmin activity is missing a numeric activityId');
  const summary = nestedRecord(root.summaryDTO) ?? root;
  const activityType = nestedRecord(root.activityTypeDTO) ?? nestedRecord(root.activityType);
  const timeZone = nestedRecord(root.timeZoneUnitDTO);
  const speed = numberValue(summary.averageSpeed);

  return {
    activityId,
    activityName: stringValue(root.activityName),
    activityType: stringValue(activityType?.typeKey),
    timeZone: stringValue(timeZone?.timeZone) ?? stringValue(timeZone?.unitKey),
    startTimeLocal: stringValue(summary.startTimeLocal),
    startTimeGMT: stringValue(summary.startTimeGMT),
    distanceMeters: numberValue(summary.distance),
    durationSeconds: numberValue(summary.duration),
    movingDurationSeconds: numberValue(summary.movingDuration),
    elapsedDurationSeconds: numberValue(summary.elapsedDuration),
    averageSpeedMetersPerSecond: speed,
    averagePaceSecondsPerKm: pace(speed),
    elevationGainMeters: numberValue(summary.elevationGain),
    averageHeartRateBpm: numberValue(summary.averageHR),
    maxHeartRateBpm: numberValue(summary.maxHR),
    trainingEffect: numberValue(summary.trainingEffect),
    aerobicTrainingEffect: numberValue(summary.aerobicTrainingEffect),
    anaerobicTrainingEffect: numberValue(summary.anaerobicTrainingEffect),
    activityTrainingLoad: numberValue(summary.activityTrainingLoad),
    heartRateZonesSeconds: {
      zone1: numberValue(summary.hrTimeInZone_1),
      zone2: numberValue(summary.hrTimeInZone_2),
      zone3: numberValue(summary.hrTimeInZone_3),
      zone4: numberValue(summary.hrTimeInZone_4),
      zone5: numberValue(summary.hrTimeInZone_5),
    },
    splitSummaries: Array.isArray(root.splitSummaries) ? root.splitSummaries.map(normalizeSplit) : null,
  };
}

export function normalizeActivityList(value: unknown): NormalizedActivity[] {
  if (!Array.isArray(value)) return invalid('Garmin activity list response must be an array');
  return value.map(normalizeActivity);
}

export function normalizeSleep(value: unknown): NormalizedSleep {
  const sleep = asRecord(value, 'Garmin sleep response must be an object');
  const scores = nestedRecord(sleep.sleepScores);
  return {
    calendarDate: stringValue(sleep.calendarDate),
    sleepStartTimestampLocal: timestampValue(sleep.sleepStartTimestampLocal),
    sleepEndTimestampLocal: timestampValue(sleep.sleepEndTimestampLocal),
    sleepStartTimestampGMT: timestampValue(sleep.sleepStartTimestampGMT),
    sleepEndTimestampGMT: timestampValue(sleep.sleepEndTimestampGMT),
    sleepTimeSeconds: numberValue(sleep.sleepTimeSeconds),
    deepSleepSeconds: numberValue(sleep.deepSleepSeconds),
    lightSleepSeconds: numberValue(sleep.lightSleepSeconds),
    remSleepSeconds: numberValue(sleep.remSleepSeconds),
    awakeSleepSeconds: numberValue(sleep.awakeSleepSeconds),
    averageRespirationValue: numberValue(sleep.averageRespirationValue),
    sleepScores: scores
      ? Object.fromEntries(Object.entries(scores).map(([key, value]) => {
          const score = nestedRecord(value);
          return [key, { value: numberValue(score?.value), qualifierKey: stringValue(score?.qualifierKey) }];
        }))
      : null,
  };
}

export function normalizeSleepRange(value: unknown): NormalizedSleep[] {
  if (!Array.isArray(value)) return invalid('Garmin sleep range response must be an array');
  return value.map(normalizeSleep);
}

export function normalizeHrvSummary(value: unknown): HrvSummary {
  const hrv = asRecord(value, 'Garmin HRV summary must be an object');
  return {
    calendarDate: stringValue(hrv.calendarDate),
    weeklyAvg: numberValue(hrv.weeklyAvg),
    lastNightAvg: numberValue(hrv.lastNightAvg),
    lastNight5MinHigh: numberValue(hrv.lastNight5MinHigh),
    status: stringValue(hrv.status),
    feedbackPhrase: stringValue(hrv.feedbackPhrase),
  };
}

export function normalizeHrvChart(value: unknown): HrvSummary {
  const chart = asRecord(value, 'Garmin HRV chart response must be an object');
  return normalizeHrvSummary(chart.hrvSummary);
}

export function normalizeHrvRange(value: unknown): HrvSummary[] {
  const range = asRecord(value, 'Garmin HRV range response must be an object');
  if (!Array.isArray(range.hrvSummaries)) return invalid('Garmin HRV range is missing hrvSummaries');
  return range.hrvSummaries.map(normalizeHrvSummary);
}

export function normalizeV2DailySummary(value: unknown): DailyHealth {
  const daily = asRecord(value, 'Garmin daily summary must be an object');
  const heartRate = nestedRecord(daily.heartRate);
  const bodyBattery = nestedRecord(daily.bodyBattery);
  const stress = nestedRecord(daily.stress);
  const respiration = nestedRecord(daily.respiration);
  return {
    calendarDate: stringValue(daily.calendarDate),
    totalSteps: null,
    totalDistanceMeters: null,
    totalKilocalories: null,
    moderateIntensityMinutes: null,
    vigorousIntensityMinutes: null,
    restingHeartRateBpm: numberValue(heartRate?.restingValue),
    bodyBattery: {
      latestValue: numberValue(bodyBattery?.latestValue),
      minValue: numberValue(bodyBattery?.minValue),
      maxValue: numberValue(bodyBattery?.maxValue),
      chargedValue: numberValue(bodyBattery?.chargedValue),
      drainedValue: numberValue(bodyBattery?.drainedValue),
    },
    stress: {
      avgLevel: numberValue(stress?.avgLevel),
      maxLevel: numberValue(stress?.maxLevel),
      qualifier: stringValue(stress?.qualifier),
    },
    respiration: {
      avgValue: numberValue(respiration?.avgValue),
      minValue: numberValue(respiration?.minValue),
      maxValue: numberValue(respiration?.maxValue),
      latestValue: numberValue(respiration?.latestValue),
    },
    lastSyncTimestampGMT: null,
  };
}

export function normalizeV2Range(value: unknown): DailyHealth[] {
  const range = asRecord(value, 'Garmin daily summary range must be an object');
  if (!Array.isArray(range.data)) return invalid('Garmin daily summary range is missing data');
  return range.data.map(normalizeV2DailySummary);
}

export function normalizeLegacyDailySummary(value: unknown): DailyHealth {
  const daily = asRecord(value, 'Garmin daily summary must be an object');
  return {
    calendarDate: stringValue(daily.calendarDate),
    totalSteps: numberValue(daily.totalSteps),
    totalDistanceMeters: numberValue(daily.totalDistanceMeters),
    totalKilocalories: numberValue(daily.totalKilocalories),
    moderateIntensityMinutes: numberValue(daily.moderateIntensityMinutes),
    vigorousIntensityMinutes: numberValue(daily.vigorousIntensityMinutes),
    restingHeartRateBpm: numberValue(daily.restingHeartRate),
    bodyBattery: {
      ...emptyBodyBattery(),
      latestValue: numberValue(daily.bodyBatteryMostRecentValue),
      minValue: numberValue(daily.bodyBatteryLowestValue),
      maxValue: numberValue(daily.bodyBatteryHighestValue),
      chargedValue: numberValue(daily.bodyBatteryChargedValue),
      drainedValue: numberValue(daily.bodyBatteryDrainedValue),
    },
    stress: {
      ...emptyStress(),
      avgLevel: numberValue(daily.averageStressLevel),
      maxLevel: numberValue(daily.maxStressLevel),
      qualifier: stringValue(daily.stressQualifier),
    },
    respiration: {
      ...emptyRespiration(),
      avgValue: numberValue(daily.avgWakingRespirationValue),
      minValue: numberValue(daily.lowestRespirationValue),
      maxValue: numberValue(daily.highestRespirationValue),
      latestValue: numberValue(daily.latestRespirationValue),
    },
    lastSyncTimestampGMT: stringValue(daily.lastSyncTimestampGMT),
  };
}

export function normalizeUserSettings(value: unknown): UserContextSettings {
  const settings = asRecord(value, 'Garmin user settings must be an object');
  const firstDay = nestedRecord(settings.firstDayOfWeek);
  const dayName = stringValue(settings.firstDayOfWeek) ?? stringValue(firstDay?.dayName);
  return {
    timezone: stringValue(settings.timeZone),
    firstDayOfWeek: dayName?.toUpperCase() ?? null,
  };
}

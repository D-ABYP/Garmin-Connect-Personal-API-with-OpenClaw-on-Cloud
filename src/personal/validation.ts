import type { DataIssue } from './context-types';

const NUMERIC_FIELDS = new Set([
  'activityId', 'distance', 'duration', 'movingDuration', 'elapsedDuration', 'averageSpeed', 'elevationGain',
  'averageHR', 'maxHR', 'trainingEffect', 'aerobicTrainingEffect', 'anaerobicTrainingEffect', 'activityTrainingLoad',
  'hrTimeInZone_1', 'hrTimeInZone_2', 'hrTimeInZone_3', 'hrTimeInZone_4', 'hrTimeInZone_5', 'noOfSplits',
  'sleepTimeSeconds', 'deepSleepSeconds', 'lightSleepSeconds', 'remSleepSeconds', 'awakeSleepSeconds',
  'averageRespirationValue', 'weeklyAvg', 'lastNightAvg', 'lastNight5MinHigh', 'restingValue', 'latestValue',
  'minValue', 'maxValue', 'avgValue', 'chargedValue', 'drainedValue', 'avgLevel', 'maxLevel', 'totalSteps',
  'totalDistanceMeters', 'totalKilocalories', 'moderateIntensityMinutes', 'vigorousIntensityMinutes',
  'restingHeartRate', 'bodyBatteryMostRecentValue', 'bodyBatteryLowestValue', 'bodyBatteryHighestValue',
  'bodyBatteryChargedValue', 'bodyBatteryDrainedValue', 'averageStressLevel', 'maxStressLevel',
  'avgWakingRespirationValue', 'lowestRespirationValue', 'highestRespirationValue', 'latestRespirationValue',
]);

const STRING_FIELDS = new Set([
  'activityName', 'typeKey', 'timeZone', 'unitKey', 'startTimeLocal', 'startTimeGMT', 'splitType',
  'calendarDate', 'status', 'feedbackPhrase', 'qualifier', 'qualifierKey', 'stressQualifier',
  'lastSyncTimestampGMT', 'dayName',
]);

const TIMESTAMP_FIELDS = new Set([
  'sleepStartTimestampLocal', 'sleepEndTimestampLocal', 'sleepStartTimestampGMT', 'sleepEndTimestampGMT',
]);

function issue(path: string, code: string, message: string): DataIssue {
  return { path, code, message, retryable: false };
}

export function validateRawFieldTypes(pathName: string, value: unknown, issues: DataIssue[]): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (nested === null || nested === undefined) continue;
    if (NUMERIC_FIELDS.has(key) && (typeof nested !== 'number' || !Number.isFinite(nested))) {
      issues.push(issue(`${pathName}.${key}`, 'invalid_field', 'Garmin field must be a finite number'));
    }
    if (STRING_FIELDS.has(key) && typeof nested !== 'string') {
      issues.push(issue(`${pathName}.${key}`, 'invalid_field', 'Garmin field must be a string'));
    }
    if (TIMESTAMP_FIELDS.has(key) && typeof nested !== 'string' && (typeof nested !== 'number' || !Number.isFinite(nested))) {
      issues.push(issue(`${pathName}.${key}`, 'invalid_field', 'Garmin timestamp must be a string or epoch number'));
    }
    if (typeof nested === 'object') validateRawFieldTypes(pathName, nested, issues);
  }
}

function required(pathName: string, value: unknown, field: string, issues: DataIssue[]): void {
  if ((value as Record<string, unknown>)[field] === null || (value as Record<string, unknown>)[field] === undefined) {
    issues.push(issue(`${pathName}.${field}`, 'missing_field', 'Garmin field is missing'));
  }
}

export function validateRequiredFields(pathName: string, value: unknown, issues: DataIssue[]): void {
  if (!value || typeof value !== 'object') return;
  if (pathName === 'settings') required(pathName, value, 'timezone', issues);
  if (pathName === 'sleep.current') required(pathName, value, 'sleepTimeSeconds', issues);
  if (pathName === 'hrv.current') required(pathName, value, 'lastNightAvg', issues);
  if (pathName === 'daily.current') required(pathName, value, 'restingHeartRateBpm', issues);

  const arrayRequirements: Record<string, string> = {
    'sleep.history': 'sleepTimeSeconds',
    'hrv.history': 'lastNightAvg',
    'daily.history': 'restingHeartRateBpm',
  };
  const field = arrayRequirements[pathName];
  if (field && Array.isArray(value)) {
    value.forEach((item, index) => required(`${pathName}.${index}`, item, field, issues));
  }
}

export function validateWeekStart(value: string | null, issues: DataIssue[]): void {
  if (value === null) {
    issues.push(issue('settings.firstDayOfWeek', 'missing_field', 'Garmin firstDayOfWeek is missing; Monday fallback is used'));
  }
}

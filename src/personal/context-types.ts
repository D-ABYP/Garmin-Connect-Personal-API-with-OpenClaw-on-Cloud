export type DataIssue = {
  path: string;
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
};

export type CacheStats = {
  hits: number;
  misses: number;
  writes: number;
  writeErrors: number;
};

export type ResponseMeta = {
  date?: string;
  startDate?: string;
  endDate?: string;
  timezone: string | null;
  units: Record<string, string>;
  cache: CacheStats;
};

export type DataEnvelope<T> = {
  meta: ResponseMeta;
  data: T;
  issues: DataIssue[];
};

export type HeartRateZonesSeconds = {
  zone1: number | null;
  zone2: number | null;
  zone3: number | null;
  zone4: number | null;
  zone5: number | null;
};

export type ActivitySplit = {
  splitType: string | null;
  noOfSplits: number | null;
  startTimeLocal: string | null;
  startTimeGMT: string | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  movingDurationSeconds: number | null;
  elapsedDurationSeconds: number | null;
  averageSpeedMetersPerSecond: number | null;
  averagePaceSecondsPerKm: number | null;
  elevationGainMeters: number | null;
  averageHeartRateBpm: number | null;
  maxHeartRateBpm: number | null;
};

export type NormalizedActivity = {
  activityId: number;
  activityName: string | null;
  activityType: string | null;
  timeZone: string | null;
  startTimeLocal: string | null;
  startTimeGMT: string | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  movingDurationSeconds: number | null;
  elapsedDurationSeconds: number | null;
  averageSpeedMetersPerSecond: number | null;
  averagePaceSecondsPerKm: number | null;
  elevationGainMeters: number | null;
  averageHeartRateBpm: number | null;
  maxHeartRateBpm: number | null;
  trainingEffect: number | null;
  aerobicTrainingEffect: number | null;
  anaerobicTrainingEffect: number | null;
  activityTrainingLoad: number | null;
  heartRateZonesSeconds: HeartRateZonesSeconds;
  splitSummaries: ActivitySplit[] | null;
};

export type NormalizedSleep = {
  calendarDate: string | null;
  sleepStartTimestampLocal: string | null;
  sleepEndTimestampLocal: string | null;
  sleepStartTimestampGMT: string | null;
  sleepEndTimestampGMT: string | null;
  sleepTimeSeconds: number | null;
  deepSleepSeconds: number | null;
  lightSleepSeconds: number | null;
  remSleepSeconds: number | null;
  awakeSleepSeconds: number | null;
  averageRespirationValue: number | null;
  sleepScores: Record<string, { value: number | null; qualifierKey: string | null }> | null;
};

export type HrvSummary = {
  calendarDate: string | null;
  weeklyAvg: number | null;
  lastNightAvg: number | null;
  lastNight5MinHigh: number | null;
  status: string | null;
  feedbackPhrase: string | null;
};

export type DailyHealth = {
  calendarDate: string | null;
  totalSteps: number | null;
  totalDistanceMeters: number | null;
  totalKilocalories: number | null;
  moderateIntensityMinutes: number | null;
  vigorousIntensityMinutes: number | null;
  restingHeartRateBpm: number | null;
  bodyBattery: {
    latestValue: number | null;
    minValue: number | null;
    maxValue: number | null;
    chargedValue: number | null;
    drainedValue: number | null;
  };
  stress: {
    avgLevel: number | null;
    maxLevel: number | null;
    qualifier: string | null;
  };
  respiration: {
    avgValue: number | null;
    minValue: number | null;
    maxValue: number | null;
    latestValue: number | null;
  };
  lastSyncTimestampGMT: string | null;
};

export type UserContextSettings = {
  timezone: string | null;
  firstDayOfWeek: string | null;
};

export type Baseline = {
  count: number;
  mean: number;
  median: number;
  standardDeviation: number;
  min: number;
  max: number;
};

export type SyncInfo = {
  lastSyncTimestampGMT: string | null;
  lagHours: number | null;
  status: 'ok' | 'stale' | 'missing' | 'invalid' | 'incomplete';
  anomalies: string[];
};

export type ActivityCollection = {
  items: NormalizedActivity[];
  complete: boolean;
  missingDays: string[];
};

export type WeeklyTrainingSummary = {
  weekStart: string;
  weekEnd: string;
  complete: boolean;
  missingDays: string[];
  activityCount: number | null;
  durationSeconds: number | null;
  distanceMeters: number | null;
  trainingLoad: number | null;
  heartRateZonesSeconds: HeartRateZonesSeconds;
  majorSports: Array<{ activityType: string; count: number; durationSeconds: number | null }>;
};

export const RESPONSE_UNITS: Record<string, string> = {
  distance: 'meters',
  duration: 'seconds',
  speed: 'meters_per_second',
  pace: 'seconds_per_kilometer',
  elevation: 'meters',
  heartRate: 'beats_per_minute',
  hrv: 'ms',
  sleep: 'seconds',
  bodyBattery: 'score_5_100',
  stress: 'score_0_100',
  respiration: 'breaths_per_minute',
  calories: 'kilocalories',
  trainingLoad: 'garmin_score',
};

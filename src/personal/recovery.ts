import type { Baseline, DailyHealth, HrvSummary, NormalizedSleep, SyncInfo } from './context-types';

export type RecoveryData = {
  sleep: NormalizedSleep | null;
  hrv: HrvSummary | null;
  daily: DailyHealth | null;
  history: {
    sleep: NormalizedSleep[] | null;
    hrv: HrvSummary[] | null;
    daily: DailyHealth[] | null;
  };
  baselines: {
    sleepTimeSeconds: Baseline | null;
    hrvLastNightAvg: Baseline | null;
    restingHeartRateBpm: Baseline | null;
    bodyBatteryLatest: Baseline | null;
    stressAvg: Baseline | null;
    respirationAvg: Baseline | null;
  };
  sync: SyncInfo;
};

export function calculateBaseline(values: Array<number | null>): Baseline | null {
  const samples = values.filter((value): value is number => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
  if (samples.length === 0) return null;

  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const middle = Math.floor(samples.length / 2);
  const median = samples.length % 2 === 0
    ? (samples[middle - 1]! + samples[middle]!) / 2
    : samples[middle]!;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
  const round = (value: number): number => Math.round(value * 100) / 100;

  return {
    count: samples.length,
    mean: round(mean),
    median: round(median),
    standardDeviation: round(Math.sqrt(variance)),
    min: samples[0]!,
    max: samples[samples.length - 1]!,
  };
}

export function buildBaselines(history: RecoveryData['history']): RecoveryData['baselines'] {
  return {
    sleepTimeSeconds: calculateBaseline(history.sleep?.map((item) => item.sleepTimeSeconds) ?? []),
    hrvLastNightAvg: calculateBaseline(history.hrv?.map((item) => item.lastNightAvg) ?? []),
    restingHeartRateBpm: calculateBaseline(history.daily?.map((item) => item.restingHeartRateBpm) ?? []),
    bodyBatteryLatest: calculateBaseline(history.daily?.map((item) => item.bodyBattery.latestValue) ?? []),
    stressAvg: calculateBaseline(history.daily?.map((item) => item.stress.avgLevel) ?? []),
    respirationAvg: calculateBaseline(history.daily?.map((item) => item.respiration.avgValue) ?? []),
  };
}

export function buildSyncInfo(lastSyncTimestampGMT: string | null, now: number, currentIncomplete: boolean): SyncInfo {
  const anomalies: string[] = [];
  if (currentIncomplete) anomalies.push('current_data_incomplete');
  if (!lastSyncTimestampGMT) {
    anomalies.push('sync_missing');
    return { lastSyncTimestampGMT: null, lagHours: null, status: 'missing', anomalies };
  }

  const timestamp = Date.parse(lastSyncTimestampGMT);
  if (!Number.isFinite(timestamp)) {
    anomalies.push('sync_timestamp_invalid');
    return { lastSyncTimestampGMT, lagHours: null, status: 'invalid', anomalies };
  }

  const lagHours = Math.round(Math.max(0, now - timestamp) / 36_000) / 100;
  if (lagHours > 24) anomalies.push('sync_stale');
  const status = lagHours > 24 ? 'stale' : currentIncomplete ? 'incomplete' : 'ok';
  return { lastSyncTimestampGMT, lagHours, status, anomalies };
}

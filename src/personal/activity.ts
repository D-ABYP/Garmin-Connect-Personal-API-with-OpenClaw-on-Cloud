import type { NormalizedActivity } from './context-types';

export type ActivityDetailsData = {
  activity: NormalizedActivity | null;
  timeSeries: {
    heartRate: null;
    pace: null;
  };
};

export function mergeActivitySummary(
  detail: NormalizedActivity,
  summary: NormalizedActivity | undefined,
): NormalizedActivity {
  if (!summary) return detail;
  return {
    ...detail,
    aerobicTrainingEffect: detail.aerobicTrainingEffect ?? summary.aerobicTrainingEffect,
    anaerobicTrainingEffect: detail.anaerobicTrainingEffect ?? summary.anaerobicTrainingEffect,
    activityTrainingLoad: detail.activityTrainingLoad ?? summary.activityTrainingLoad,
    heartRateZonesSeconds: {
      zone1: detail.heartRateZonesSeconds.zone1 ?? summary.heartRateZonesSeconds.zone1,
      zone2: detail.heartRateZonesSeconds.zone2 ?? summary.heartRateZonesSeconds.zone2,
      zone3: detail.heartRateZonesSeconds.zone3 ?? summary.heartRateZonesSeconds.zone3,
      zone4: detail.heartRateZonesSeconds.zone4 ?? summary.heartRateZonesSeconds.zone4,
      zone5: detail.heartRateZonesSeconds.zone5 ?? summary.heartRateZonesSeconds.zone5,
    },
  };
}

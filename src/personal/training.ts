import type {
  ActivityCollection,
  DailyHealth,
  HeartRateZonesSeconds,
  NormalizedActivity,
  WeeklyTrainingSummary,
} from './context-types';
import { shiftDate } from './data-service';

export type TrainingDayData = {
  activities: ActivityCollection;
  health: DailyHealth | null;
  history: WeeklyTrainingSummary[];
};

export type TrainingHistoryData = {
  weeks: WeeklyTrainingSummary[];
  coverage: {
    complete: boolean;
    missingDays: string[];
  };
};

type Sum = { value: number; count: number };

type SportSummary = {
  count: number;
  duration: Sum;
};

function emptySum(): Sum {
  return { value: 0, count: 0 };
}

function add(sum: Sum, value: number | null): void {
  if (value !== null && Number.isFinite(value)) {
    sum.value += value;
    sum.count++;
  }
}

function result(sum: Sum): number | null {
  return sum.count > 0 ? sum.value : null;
}

function emptyZones(): Record<keyof HeartRateZonesSeconds, Sum> {
  return { zone1: emptySum(), zone2: emptySum(), zone3: emptySum(), zone4: emptySum(), zone5: emptySum() };
}

function activityDate(activity: NormalizedActivity): string | null {
  const timestamp = activity.startTimeLocal ?? activity.startTimeGMT;
  return timestamp && /^\d{4}-\d{2}-\d{2}/.test(timestamp) ? timestamp.slice(0, 10) : null;
}

function weekStart(date: string, firstDayOfWeek: string): string {
  const days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  const first = Math.max(0, days.indexOf(firstDayOfWeek.toUpperCase()));
  const current = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return shiftDate(date, -((current - first + 7) % 7));
}

export function summarizeWeeks(
  activities: NormalizedActivity[],
  firstDayOfWeek = 'MONDAY',
  startDate?: string,
  endDate?: string,
  missingDays: string[] = [],
): WeeklyTrainingSummary[] {
  const grouped = new Map<string, NormalizedActivity[]>();
  if (startDate && endDate) {
    const lastWeek = weekStart(endDate, firstDayOfWeek);
    for (let start = weekStart(startDate, firstDayOfWeek); start <= lastWeek; start = shiftDate(start, 7)) {
      grouped.set(start, []);
    }
  }
  for (const activity of activities) {
    const date = activityDate(activity);
    if (!date) continue;
    const start = weekStart(date, firstDayOfWeek);
    const group = grouped.get(start) ?? [];
    group.push(activity);
    grouped.set(start, group);
  }

  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([start, items]) => {
    const duration = emptySum();
    const distance = emptySum();
    const trainingLoad = emptySum();
    const zones = emptyZones();
    const sports = new Map<string, SportSummary>();
    const failedDays = missingDays.filter((date) => weekStart(date, firstDayOfWeek) === start);
    const unqueriedDays: string[] = [];
    for (let index = 0; index < 7; index++) {
      const date = shiftDate(start, index);
      if ((startDate && date < startDate) || (endDate && date > endDate)) unqueriedDays.push(date);
    }
    const weekMissingDays = [...new Set([...failedDays, ...unqueriedDays])].sort();
    const complete = weekMissingDays.length === 0;
    const emptyCompleteWeek = items.length === 0 && complete;

    for (const item of items) {
      add(duration, item.durationSeconds);
      add(distance, item.distanceMeters);
      add(trainingLoad, item.activityTrainingLoad);
      for (const zone of Object.keys(zones) as Array<keyof HeartRateZonesSeconds>) {
        add(zones[zone], item.heartRateZonesSeconds[zone]);
      }
      const type = item.activityType ?? 'unknown';
      const sport = sports.get(type) ?? { count: 0, duration: emptySum() };
      sport.count++;
      add(sport.duration, item.durationSeconds);
      sports.set(type, sport);
    }

    return {
      weekStart: start,
      weekEnd: shiftDate(start, 6),
      complete,
      missingDays: weekMissingDays,
      activityCount: items.length === 0 && !complete ? null : items.length,
      durationSeconds: emptyCompleteWeek ? 0 : result(duration),
      distanceMeters: emptyCompleteWeek ? 0 : result(distance),
      trainingLoad: emptyCompleteWeek ? 0 : result(trainingLoad),
      heartRateZonesSeconds: {
        zone1: emptyCompleteWeek ? 0 : result(zones.zone1),
        zone2: emptyCompleteWeek ? 0 : result(zones.zone2),
        zone3: emptyCompleteWeek ? 0 : result(zones.zone3),
        zone4: emptyCompleteWeek ? 0 : result(zones.zone4),
        zone5: emptyCompleteWeek ? 0 : result(zones.zone5),
      },
      majorSports: [...sports.entries()]
        .map(([activityType, sport]) => ({
          activityType,
          count: sport.count,
          durationSeconds: result(sport.duration),
        }))
        .sort((left, right) => (right.durationSeconds ?? -1) - (left.durationSeconds ?? -1)),
    };
  });
}

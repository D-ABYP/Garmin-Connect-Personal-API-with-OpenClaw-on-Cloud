import { mergeActivitySummary, type ActivityDetailsData } from './activity';
import { JsonCache } from './cache';
import {
  RESPONSE_UNITS,
  type ActivityCollection,
  type DataEnvelope,
  type DataIssue,
  type NormalizedActivity,
} from './context-types';
import { PersonalApiError } from './errors';
import type { QueryParams } from './http-transport';
import {
  normalizeActivity,
  normalizeActivityList,
  normalizeHrvChart,
  normalizeHrvRange,
  normalizeLegacyDailySummary,
  normalizeSleep,
  normalizeSleepRange,
  normalizeUserSettings,
  normalizeV2Range,
} from './normalize';
import { PersonalApiClient } from './personal-api';
import { buildBaselines, buildSyncInfo, type RecoveryData } from './recovery';
import { redactSecrets } from './redaction';
import { summarizeWeeks, type TrainingDayData, type TrainingHistoryData } from './training';
import { validateRawFieldTypes, validateRequiredFields, validateWeekStart } from './validation';

const ACTIVITY_LIST_PATH = '/activitylist-service/activities/search/activities';
const ACTIVITY_PAGE_SIZE = 20;

export interface PersonalApiReader {
  get<T>(path: string, params?: QueryParams): Promise<T | null>;
  getCacheNamespace?(): Promise<string>;
}

export type PersonalDataServiceOptions = {
  client?: PersonalApiReader;
  cache?: JsonCache;
  cacheDirectory?: string;
  now?: () => number;
};

export function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

export function assertDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new PersonalApiError('invalid_config', 'Date must use YYYY-MM-DD format');
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new PersonalApiError('invalid_config', 'Date must be a real calendar date in YYYY-MM-DD format');
  }
}

export class PersonalDataService {
  private readonly client: PersonalApiReader;
  private readonly cache: JsonCache;
  private readonly now: () => number;
  private cacheNamespacePromise: Promise<string> | null = null;

  constructor(options: PersonalDataServiceOptions = {}) {
    this.client = options.client ?? new PersonalApiClient();
    this.now = options.now ?? Date.now;
    this.cache = options.cache ?? new JsonCache({ directory: options.cacheDirectory, now: this.now });
  }

  async getRecoveryContext(date: string, baselineDays = 28): Promise<DataEnvelope<RecoveryData>> {
    assertDate(date);
    if (!Number.isInteger(baselineDays) || baselineDays < 1 || baselineDays > 90) {
      throw new PersonalApiError('invalid_config', 'baseline_days must be an integer between 1 and 90');
    }

    this.cache.resetStats();
    this.cacheNamespacePromise = null;
    const issues: DataIssue[] = [];
    const startDate = shiftDate(date, -baselineDays);
    const historyEndDate = shiftDate(date, -1);
    const historyRange = { startDate, endDate: historyEndDate };

    const [settings, sleep, hrv, daily, legacyDaily, sleepHistory, hrvHistory, dailyHistory] = await Promise.all([
      this.readItem('settings', issues, '/userprofile-service/userprofile/settings', {}, date, normalizeUserSettings),
      this.readItem('sleep.current', issues, '/sleep-service/sleep/dailySleep', { date }, date, normalizeSleep),
      this.readItem('hrv.current', issues, `/hrv-service/hrv/${date}`, {}, date, normalizeHrvChart),
      this.readItem('daily.current', issues, '/usersummary-service/v2/dailysummaries', { startDate: date, endDate: date }, date, (value) => {
        const values = normalizeV2Range(value);
        return values[0] ?? null;
      }),
      this.readItem('daily.sync', issues, '/usersummary-service/usersummary/daily', { calendarDate: date }, date, normalizeLegacyDailySummary),
      this.readItem('sleep.history', issues, '/sleep-service/sleep/dailySleepSummariesByDate', historyRange, historyEndDate, normalizeSleepRange),
      this.readItem('hrv.history', issues, `/hrv-service/hrv/daily/${startDate}/${historyEndDate}`, {}, historyEndDate, normalizeHrvRange),
      this.readItem('daily.history', issues, '/usersummary-service/v2/dailysummaries', historyRange, historyEndDate, normalizeV2Range),
    ]);

    const history = { sleep: sleepHistory, hrv: hrvHistory, daily: dailyHistory };
    const sync = buildSyncInfo(
      legacyDaily?.lastSyncTimestampGMT ?? null,
      this.now(),
      sleep === null || hrv === null || daily === null,
    );
    if (sleepHistory === null || hrvHistory === null || dailyHistory === null) {
      sync.anomalies.push('history_incomplete');
      if (sync.status === 'ok') sync.status = 'incomplete';
    }

    return {
      meta: {
        date,
        startDate,
        endDate: date,
        timezone: settings?.timezone ?? null,
        units: { ...RESPONSE_UNITS },
        cache: this.cache.stats(),
      },
      data: {
        sleep,
        hrv,
        daily,
        history,
        baselines: buildBaselines(history),
        sync,
      },
      issues,
    };
  }

  async getTrainingDayContext(date: string, historyDays = 42): Promise<DataEnvelope<TrainingDayData>> {
    assertDate(date);
    if (!Number.isInteger(historyDays) || historyDays < 1 || historyDays > 90) {
      throw new PersonalApiError('invalid_config', 'history_days must be an integer between 1 and 90');
    }

    this.cache.resetStats();
    this.cacheNamespacePromise = null;
    const issues: DataIssue[] = [];
    const startDate = shiftDate(date, -(historyDays - 1));
    const [settings, health, activities] = await Promise.all([
      this.readItem('settings', issues, '/userprofile-service/userprofile/settings', {}, date, normalizeUserSettings),
      this.readItem('health.current', issues, '/usersummary-service/usersummary/daily', { calendarDate: date }, date, normalizeLegacyDailySummary),
      this.getActivitiesRange(startDate, date, issues),
    ]);
    validateWeekStart(settings?.firstDayOfWeek ?? null, issues);

    return {
      meta: {
        date,
        startDate,
        endDate: date,
        timezone: settings?.timezone ?? null,
        units: { ...RESPONSE_UNITS },
        cache: this.cache.stats(),
      },
      data: {
        activities,
        health,
        history: summarizeWeeks(activities.items, settings?.firstDayOfWeek ?? 'MONDAY', startDate, date, activities.missingDays),
      },
      issues,
    };
  }

  async getTrainingHistory(startDate: string, endDate: string): Promise<DataEnvelope<TrainingHistoryData>> {
    assertDate(startDate);
    assertDate(endDate);
    const days = Math.round((Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86_400_000) + 1;
    if (days < 56 || days > 84) {
      throw new PersonalApiError('invalid_config', 'Training history range must be between 56 and 84 days');
    }

    this.cache.resetStats();
    this.cacheNamespacePromise = null;
    const issues: DataIssue[] = [];
    const [settings, activities] = await Promise.all([
      this.readItem('settings', issues, '/userprofile-service/userprofile/settings', {}, endDate, normalizeUserSettings),
      this.getActivitiesRange(startDate, endDate, issues),
    ]);
    validateWeekStart(settings?.firstDayOfWeek ?? null, issues);

    return {
      meta: {
        startDate,
        endDate,
        timezone: settings?.timezone ?? null,
        units: { ...RESPONSE_UNITS },
        cache: this.cache.stats(),
      },
      data: {
        weeks: summarizeWeeks(activities.items, settings?.firstDayOfWeek ?? 'MONDAY', startDate, endDate, activities.missingDays),
        coverage: { complete: activities.complete, missingDays: activities.missingDays },
      },
      issues,
    };
  }

  async getActivityDetails(activityId: number): Promise<DataEnvelope<ActivityDetailsData>> {
    if (!Number.isInteger(activityId) || activityId <= 0) {
      throw new PersonalApiError('invalid_config', 'activity_id must be a positive integer');
    }

    this.cache.resetStats();
    this.cacheNamespacePromise = null;
    const issues: DataIssue[] = [];
    const detail = await this.readItem(
      'activity.detail',
      issues,
      `/activity-service/activity/${activityId}`,
      {},
      'immutable',
      normalizeActivity,
    );
    const activityDate = detail?.startTimeLocal?.slice(0, 10) ?? detail?.startTimeGMT?.slice(0, 10);
    let activity = detail;

    if (detail && activityDate && /^\d{4}-\d{2}-\d{2}$/.test(activityDate)) {
      const summaries = await this.getActivitiesForDay(activityDate, `activity.summary.${activityDate}`, issues);
      activity = mergeActivitySummary(detail, summaries?.find((item) => item.activityId === activityId));
    }
    if (activity) {
      issues.push({
        path: 'activity.timeSeries',
        code: 'unsupported_field',
        message: 'Personal API does not expose heart-rate or pace time series for this activity',
        retryable: false,
      });
    }

    return {
      meta: {
        ...(activityDate ? { date: activityDate } : {}),
        timezone: activity?.timeZone ?? null,
        units: { ...RESPONSE_UNITS },
        cache: this.cache.stats(),
      },
      data: {
        activity,
        timeSeries: { heartRate: null, pace: null },
      },
      issues,
    };
  }

  private async getActivitiesRange(startDate: string, endDate: string, issues: DataIssue[]): Promise<ActivityCollection> {
    const days = Math.round((Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86_400_000) + 1;
    const activities = new Map<number, NormalizedActivity>();
    const missingDays: string[] = [];

    for (let index = 0; index < days; index++) {
      const date = shiftDate(startDate, index);
      const items = await this.getActivitiesForDay(date, `activities.${date}`, issues);
      if (items === null) {
        missingDays.push(date);
        continue;
      }
      for (const item of items) activities.set(item.activityId, item);
    }

    return {
      items: [...activities.values()],
      complete: missingDays.length === 0,
      missingDays,
    };
  }

  private async getActivitiesForDay(date: string, pathName: string, issues: DataIssue[]): Promise<NormalizedActivity[] | null> {
    try {
      const cacheKey = await this.cacheKey(`v1:activities-day:${date}`);
      const value = await this.cache.getOrFetch(cacheKey, date, async () => {
        const activities = new Map<number, NormalizedActivity>();
        let start = 0;
        while (true) {
          const response = await this.client.get(ACTIVITY_LIST_PATH, {
            start,
            limit: ACTIVITY_PAGE_SIZE,
            startDate: date,
            endDate: date,
          });
          if (response === null) return null;
          validateRawFieldTypes(pathName, response, issues);
          const page = normalizeActivityList(response);
          for (const item of page) activities.set(item.activityId, item);
          if (page.length < ACTIVITY_PAGE_SIZE) break;
          start += ACTIVITY_PAGE_SIZE;
        }
        return [...activities.values()];
      }, (payload): payload is NormalizedActivity[] => Array.isArray(payload) && payload.every((item) =>
        typeof item === 'object' && item !== null && typeof (item as NormalizedActivity).activityId === 'number'));
      if (value === null) {
        issues.push({ path: pathName, code: 'no_data', message: 'Garmin returned no activity data for this day', retryable: false });
      }
      return value;
    } catch (error: unknown) {
      issues.push(this.toIssue(pathName, error));
      return null;
    }
  }

  private async readItem<T>(
    pathName: string,
    issues: DataIssue[],
    endpoint: string,
    params: QueryParams,
    cacheDate: string,
    normalize: (value: unknown) => T | null,
  ): Promise<T | null> {
    try {
      const cacheKey = await this.cacheKey(`v1:${endpoint}:${JSON.stringify(params)}`);
      const value = await this.cache.getOrFetch(cacheKey, cacheDate, async () => {
        const response = await this.client.get(endpoint, params);
        if (response === null) return null;
        validateRawFieldTypes(pathName, response, issues);
        return normalize(response);
      }, (payload): payload is T => typeof payload === 'object' && payload !== null);
      if (value !== null) validateRequiredFields(pathName, value, issues);
      if (value === null) {
        issues.push({ path: pathName, code: 'no_data', message: 'Garmin returned no data for this item', retryable: false });
      }
      return value;
    } catch (error: unknown) {
      issues.push(this.toIssue(pathName, error));
      return null;
    }
  }

  private async cacheKey(key: string): Promise<string> {
    if (!this.cacheNamespacePromise) {
      this.cacheNamespacePromise = this.client.getCacheNamespace?.() ?? Promise.resolve('default');
    }
    const namespace = await this.cacheNamespacePromise;
    return `${namespace}:${key}`;
  }

  private toIssue(pathName: string, error: unknown): DataIssue {
    if (error instanceof PersonalApiError) {
      return {
        path: pathName,
        code: error.code,
        message: redactSecrets(error.message),
        retryable: error.retryable,
        ...(error.status === undefined ? {} : { status: error.status }),
      };
    }
    return {
      path: pathName,
      code: 'unknown',
      message: 'Garmin data item could not be read',
      retryable: false,
    };
  }
}

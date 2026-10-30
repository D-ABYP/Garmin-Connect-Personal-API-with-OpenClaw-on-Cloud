import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PersonalDataService } from './data-service';
import { FakePersonalApiClient } from './service-test-helpers';

const tempDirs: string[] = [];
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const DATE = '2026-10-30';
const ACTIVITY_PATH = '/activitylist-service/activities/search/activities';

class AccountClient extends FakePersonalApiClient {
  constructor(private readonly namespace: string) {
    super();
  }

  async getCacheNamespace(): Promise<string> {
    return this.namespace;
  }
}

function accountResponses(client: AccountClient, marker: number): void {
  client.when('/userprofile-service/userprofile/settings', {
    timeZone: 'Asia/Shanghai',
    firstDayOfWeek: { dayName: 'monday' },
  });
  client.when('/usersummary-service/usersummary/daily', {
    calendarDate: DATE,
    totalSteps: marker,
    lastSyncTimestampGMT: '2026-10-30T11:00:00Z',
  }, { calendarDate: DATE });
  client.when(ACTIVITY_PATH, [{
    activityId: marker,
    activityType: { typeKey: 'running' },
    startTimeLocal: `${DATE}T06:30:00`,
    distance: marker,
    duration: 60,
  }], { start: 0, limit: 20, startDate: DATE, endDate: DATE });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('account-scoped data cache', () => {
  it('does not return health or activity data cached for another account', async () => {
    const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), 'garmin-account-cache-test-'));
    tempDirs.push(cacheDirectory);
    const clientA = new AccountClient('account-a');
    accountResponses(clientA, 100);
    const serviceA = new PersonalDataService({ client: clientA, cacheDirectory, now: () => NOW });
    const first = await serviceA.getTrainingDayContext(DATE, 1);
    expect(first.data.health?.totalSteps).toBe(100);

    const clientB = new AccountClient('account-b');
    accountResponses(clientB, 200);
    const serviceB = new PersonalDataService({ client: clientB, cacheDirectory, now: () => NOW });
    const second = await serviceB.getTrainingDayContext(DATE, 1);

    expect(second.data.health?.totalSteps).toBe(200);
    expect(second.data.activities.items.map((item) => item.activityId)).toEqual([200]);
    expect(second.meta.cache.hits).toBe(0);
  });
});

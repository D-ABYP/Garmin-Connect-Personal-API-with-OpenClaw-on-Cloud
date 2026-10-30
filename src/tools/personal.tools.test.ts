import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PersonalDataService } from '../personal/data-service';
import { registerPersonalTools } from './personal.tools';

type Registration = {
  name: string;
  config: { inputSchema?: Record<string, z.ZodTypeAny> };
  handler: (args: any) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

function setup() {
  const registrations: Registration[] = [];
  const server = {
    registerTool: (name: string, config: Registration['config'], handler: Registration['handler']) => {
      registrations.push({ name, config, handler });
    },
  } as unknown as McpServer;
  const payload = { meta: {}, data: { ok: true }, issues: [] };
  const service = {
    getRecoveryContext: vi.fn(async () => payload),
    getTrainingDayContext: vi.fn(async () => payload),
    getTrainingHistory: vi.fn(async () => payload),
    getActivityDetails: vi.fn(async () => payload),
  } as unknown as PersonalDataService;
  registerPersonalTools(server, service);
  return { registrations, service, payload };
}

describe('registerPersonalTools', () => {
  it('registers exactly the four read-only Personal API tools', () => {
    const { registrations } = setup();

    expect(registrations.map((item) => item.name).sort()).toEqual([
      'get_activity_details',
      'get_recovery_context',
      'get_training_day_context',
      'get_training_history',
    ]);
    expect(registrations.some((item) => /delete|create|set_|add_/i.test(item.name))).toBe(false);
  });

  it('applies default recovery and training windows and serializes data as JSON', async () => {
    const { registrations, service, payload } = setup();
    const recovery = registrations.find((item) => item.name === 'get_recovery_context')!;
    const training = registrations.find((item) => item.name === 'get_training_day_context')!;

    const recoveryResult = await recovery.handler({ date: '2026-10-30', baseline_days: undefined });
    await training.handler({ date: '2026-10-30', history_days: undefined });

    expect(service.getRecoveryContext).toHaveBeenCalledWith('2026-10-30', 28);
    expect(service.getTrainingDayContext).toHaveBeenCalledWith('2026-10-30', 42);
    expect(JSON.parse(recoveryResult.content[0]!.text)).toEqual(payload);
  });

  it('passes explicit history and activity arguments to the data service', async () => {
    const { registrations, service } = setup();
    const history = registrations.find((item) => item.name === 'get_training_history')!;
    const activity = registrations.find((item) => item.name === 'get_activity_details')!;

    await history.handler({ start_date: '2026-09-05', end_date: '2026-10-30' });
    await activity.handler({ activity_id: 123 });

    expect(service.getTrainingHistory).toHaveBeenCalledWith('2026-09-05', '2026-10-30');
    expect(service.getActivityDetails).toHaveBeenCalledWith(123);
  });

  it('rejects malformed dates at the MCP input boundary', () => {
    const { registrations } = setup();
    const recovery = registrations.find((item) => item.name === 'get_recovery_context')!;
    const schema = z.object(recovery.config.inputSchema!);

    expect(() => schema.parse({ date: '30/10/2026', baseline_days: 28 })).toThrow();
    expect(() => schema.parse({ date: '2026-10-30', baseline_days: 28 })).not.toThrow();
  });

  it('serves all four tools through a real MCP client and in-memory transport', async () => {
    const payload = { meta: {}, data: { ok: true }, issues: [] };
    const service = {
      getRecoveryContext: vi.fn(async () => payload),
      getTrainingDayContext: vi.fn(async () => payload),
      getTrainingHistory: vi.fn(async () => payload),
      getActivityDetails: vi.fn(async () => payload),
    } as unknown as PersonalDataService;
    const server = new McpServer({ name: 'garmin-test-server', version: '1.0.0' });
    const client = new Client({ name: 'garmin-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    registerPersonalTools(server, service);

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'get_activity_details',
        'get_recovery_context',
        'get_training_day_context',
        'get_training_history',
      ]);

      const calls = [
        ['get_recovery_context', { date: '2026-10-30', baseline_days: 28 }],
        ['get_training_day_context', { date: '2026-10-30', history_days: 42 }],
        ['get_training_history', { start_date: '2026-09-05', end_date: '2026-10-30' }],
        ['get_activity_details', { activity_id: 123 }],
      ] as const;
      for (const [name, args] of calls) {
        const result = await client.callTool({ name, arguments: args });
        const content = result.content as Array<{ type: string; text: string }>;
        expect(JSON.parse(content[0]!.text)).toEqual(payload);
      }
      expect(service.getRecoveryContext).toHaveBeenCalledOnce();
      expect(service.getTrainingDayContext).toHaveBeenCalledOnce();
      expect(service.getTrainingHistory).toHaveBeenCalledOnce();
      expect(service.getActivityDetails).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

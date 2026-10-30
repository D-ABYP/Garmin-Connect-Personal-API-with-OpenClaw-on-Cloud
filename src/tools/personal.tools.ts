import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PersonalDataService } from '../personal/data-service';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format');

const recoveryContextSchema = z.object({
  date: dateString.describe('Report morning date in YYYY-MM-DD format'),
  baseline_days: z.number().int().min(1).max(90).default(28).optional().describe('Days before the report date used for baselines'),
});

const trainingDayContextSchema = z.object({
  date: dateString.describe('Training day in YYYY-MM-DD format'),
  history_days: z.number().int().min(1).max(90).default(42).optional().describe('Days including the requested day used for trends'),
});

const trainingHistorySchema = z.object({
  start_date: dateString.describe('History start date in YYYY-MM-DD format'),
  end_date: dateString.describe('History end date in YYYY-MM-DD format; the range must be 56-84 days'),
});

const activityDetailsSchema = z.object({
  activity_id: z.number().int().positive().describe('The Garmin activity ID'),
});

function jsonResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function registerPersonalTools(server: McpServer, service: PersonalDataService): void {
  server.registerTool(
    'get_recovery_context',
    {
      description: 'Get sleep, HRV, daily recovery values, historical baselines, missing data and sync status',
      inputSchema: recoveryContextSchema.shape,
    },
    async ({ date, baseline_days }) => jsonResult(await service.getRecoveryContext(date, baseline_days ?? 28)),
  );

  server.registerTool(
    'get_training_day_context',
    {
      description: 'Get all activities and health data for a day with six weeks of training frequency and load trends',
      inputSchema: trainingDayContextSchema.shape,
    },
    async ({ date, history_days }) => jsonResult(await service.getTrainingDayContext(date, history_days ?? 42)),
  );

  server.registerTool(
    'get_training_history',
    {
      description: 'Summarize 8-12 weeks of training by week, duration, heart-rate zones and major sports',
      inputSchema: trainingHistorySchema.shape,
    },
    async ({ start_date, end_date }) => jsonResult(await service.getTrainingHistory(start_date, end_date)),
  );

  server.registerTool(
    'get_activity_details',
    {
      description: 'Get pace, heart rate, elevation, splits and heart-rate zones for one activity without GPS tracks',
      inputSchema: activityDetailsSchema.shape,
    },
    async ({ activity_id }) => jsonResult(await service.getActivityDetails(activity_id)),
  );
}

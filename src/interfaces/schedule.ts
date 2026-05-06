import type { WorkflowDefinition } from './workflow.js';

export interface Schedule {
  id: string;
  cron_expression: string;
  timezone: string;
  workflow_definition: WorkflowDefinition;
  next_fire_at: Date;
  enabled: boolean;
  last_fired_at: Date | null;
}

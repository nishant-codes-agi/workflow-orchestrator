export type TaskStatus = 'PENDING' | 'READY' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface Task {
  id: string;
  logical_id: string;
  workflow_id: string;
  handler_name: string;
  input: unknown;
  status: TaskStatus;
  priority: number;
  scheduled_at: Date;
  submission_order: bigint;
  attempts: number;
  max_attempts: number;
  backoff_base_ms: number;
  backoff_cap_ms: number;
  last_sleep_ms: number;
  timeout_ms: number;
  pending_deps: number;
  last_heartbeat_at: Date | null;
  error: string | null;
  completed_at: Date | null;
}

export interface TaskDefinition {
  id: string;
  handler: string;
  input?: unknown;
  dependsOn?: string[];
  retryPolicy?: {
    maxAttempts: number;
    backoffBase: number;
    backoffCap: number;
  };
  timeoutMs?: number;
  priority?: number;
}

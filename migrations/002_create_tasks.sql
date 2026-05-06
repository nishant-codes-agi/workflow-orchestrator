CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  logical_id TEXT NOT NULL,
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  handler_name TEXT NOT NULL,
  input JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'PENDING',
  priority INT NOT NULL DEFAULT 0,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submission_order BIGSERIAL,
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  backoff_base_ms INT NOT NULL DEFAULT 1000,
  backoff_cap_ms INT NOT NULL DEFAULT 30000,
  last_sleep_ms INT NOT NULL DEFAULT 0,
  timeout_ms INT NOT NULL DEFAULT 30000,
  pending_deps INT NOT NULL DEFAULT 0,
  last_heartbeat_at TIMESTAMPTZ,
  error TEXT,
  completed_at TIMESTAMPTZ,
  UNIQUE(workflow_id, logical_id)
);

CREATE INDEX idx_tasks_workflow_status ON tasks(workflow_id, status);
CREATE INDEX idx_tasks_status_scheduled_priority ON tasks(status, scheduled_at, priority);
CREATE INDEX idx_tasks_running ON tasks(workflow_id, status) WHERE status = 'RUNNING';

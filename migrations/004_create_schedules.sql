CREATE TABLE schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cron_expression TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  workflow_definition JSONB NOT NULL,
  next_fire_at TIMESTAMPTZ NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_fired_at TIMESTAMPTZ
);

CREATE INDEX idx_schedules_next_fire ON schedules(next_fire_at) WHERE enabled = TRUE;

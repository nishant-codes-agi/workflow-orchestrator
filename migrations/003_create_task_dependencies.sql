CREATE TABLE task_dependencies (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE INDEX idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id);

export type WorkflowStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLING'
  | 'CANCELLED';

export interface Workflow {
  id: string;
  status: WorkflowStatus;
  created_at: Date;
  updated_at: Date;
}

export interface WorkflowDefinition {
  tasks: import('./task.js').TaskDefinition[];
}

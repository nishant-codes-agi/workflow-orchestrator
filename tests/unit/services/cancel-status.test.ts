import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowService } from '../../../src/services/workflow.service.js';
import type { TaskRepository } from '../../../src/repositories/task.repository.js';
import type { WorkflowRepository } from '../../../src/repositories/workflow.repository.js';
import { HandlerRegistry } from '../../../src/engine/handler-registry.js';
import type pg from 'pg';

function createMockLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    silent: vi.fn(),
    level: 'info',
  } as unknown as import('fastify').FastifyBaseLogger;
}

describe('WorkflowService cancel/status', () => {
  let service: WorkflowService;
  let mockTaskRepo: TaskRepository;
  let mockWorkflowRepo: WorkflowRepository;
  let mockPool: pg.Pool;
  let handlerRegistry: HandlerRegistry;

  beforeEach(() => {
    mockTaskRepo = {
      getTasksByWorkflowId: vi.fn().mockResolvedValue([
        {
          id: 't1', logical_id: 'A', workflow_id: 'wf-1', handler_name: 'noop',
          status: 'COMPLETED', attempts: 1, max_attempts: 3, error: null,
          completed_at: new Date(),
        },
        {
          id: 't2', logical_id: 'B', workflow_id: 'wf-1', handler_name: 'noop',
          status: 'RUNNING', attempts: 1, max_attempts: 3, error: null,
          completed_at: null,
        },
      ]),
      cancelNonStartedTasks: vi.fn().mockResolvedValue(2),
      countNonTerminalTasks: vi.fn().mockResolvedValue(1),
    } as unknown as TaskRepository;

    mockWorkflowRepo = {
      findById: vi.fn().mockResolvedValue({
        id: 'wf-1',
        status: 'RUNNING',
        created_at: new Date(),
        updated_at: new Date(),
      }),
      getStatus: vi.fn().mockResolvedValue('RUNNING'),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as WorkflowRepository;

    mockPool = {
      connect: vi.fn(),
      query: vi.fn(),
    } as unknown as pg.Pool;

    handlerRegistry = new HandlerRegistry();
    handlerRegistry.register('noop', async () => {});

    service = new WorkflowService(
      mockPool,
      mockTaskRepo,
      mockWorkflowRepo,
      handlerRegistry,
      createMockLogger(),
    );
  });

  describe('getWorkflow', () => {
    it('returns workflow with per-task statuses', async () => {
      const result = await service.getWorkflow('wf-1');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('wf-1');
      expect(result!.status).toBe('RUNNING');
      expect(result!.tasks).toHaveLength(2);
      expect(result!.tasks[0]!.logicalId).toBe('A');
      expect(result!.tasks[0]!.status).toBe('COMPLETED');
      expect(result!.tasks[1]!.status).toBe('RUNNING');
    });

    it('returns null for non-existent workflow', async () => {
      vi.mocked(mockWorkflowRepo.findById).mockResolvedValue(null);
      const result = await service.getWorkflow('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('cancelWorkflow', () => {
    it('cancel a RUNNING workflow: tasks in READY/PENDING become CANCELLED', async () => {
      const result = await service.cancelWorkflow('wf-1');
      expect(result.statusCode).toBe(200);
      expect(result.body.status).toBe('CANCELLING');
      expect(mockWorkflowRepo.updateStatus).toHaveBeenCalledWith(
        mockPool, 'wf-1', 'CANCELLING',
      );
      expect(mockTaskRepo.cancelNonStartedTasks).toHaveBeenCalledWith(mockPool, 'wf-1');
    });

    it('cancel already-cancelled workflow: 200, no-op', async () => {
      vi.mocked(mockWorkflowRepo.getStatus).mockResolvedValue('CANCELLED');
      const result = await service.cancelWorkflow('wf-1');
      expect(result.statusCode).toBe(200);
      expect(mockWorkflowRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('cancel CANCELLING workflow: 200, no-op', async () => {
      vi.mocked(mockWorkflowRepo.getStatus).mockResolvedValue('CANCELLING');
      const result = await service.cancelWorkflow('wf-1');
      expect(result.statusCode).toBe(200);
      expect(mockWorkflowRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('cancel COMPLETED workflow: 409', async () => {
      vi.mocked(mockWorkflowRepo.getStatus).mockResolvedValue('COMPLETED');
      const result = await service.cancelWorkflow('wf-1');
      expect(result.statusCode).toBe(409);
    });

    it('cancel FAILED workflow: 409', async () => {
      vi.mocked(mockWorkflowRepo.getStatus).mockResolvedValue('FAILED');
      const result = await service.cancelWorkflow('wf-1');
      expect(result.statusCode).toBe(409);
    });

    it('cancel non-existent workflow: 404', async () => {
      vi.mocked(mockWorkflowRepo.getStatus).mockResolvedValue(null);
      const result = await service.cancelWorkflow('nonexistent');
      expect(result.statusCode).toBe(404);
    });

    it('cancel with no running tasks: goes directly to CANCELLED', async () => {
      vi.mocked(mockTaskRepo.countNonTerminalTasks).mockResolvedValue(0);
      const result = await service.cancelWorkflow('wf-1');
      expect(result.statusCode).toBe(200);
      expect(result.body.status).toBe('CANCELLED');
      expect(mockWorkflowRepo.updateStatus).toHaveBeenCalledWith(
        mockPool, 'wf-1', 'CANCELLED',
      );
    });
  });
});

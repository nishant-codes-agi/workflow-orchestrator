import type { FastifyInstance } from 'fastify';
import { WorkflowService, SubmissionError } from '../services/workflow.service.js';

const taskDefinitionSchema = {
  type: 'object' as const,
  required: ['id', 'handler'],
  properties: {
    id: { type: 'string' as const },
    handler: { type: 'string' as const },
    input: {},
    dependsOn: { type: 'array' as const, items: { type: 'string' as const } },
    retryPolicy: {
      type: 'object' as const,
      properties: {
        maxAttempts: { type: 'number' as const },
        backoffBase: { type: 'number' as const },
        backoffCap: { type: 'number' as const },
      },
    },
    timeoutMs: { type: 'number' as const },
    priority: { type: 'number' as const },
  },
};

const submitWorkflowSchema = {
  body: {
    type: 'object' as const,
    required: ['tasks'],
    properties: {
      tasks: {
        type: 'array' as const,
        items: taskDefinitionSchema,
      },
    },
  },
};

export function registerWorkflowRoutes(
  server: FastifyInstance,
  workflowService: WorkflowService,
): void {
  server.post('/workflows', { schema: submitWorkflowSchema }, async (request, reply) => {
    try {
      const body = request.body as { tasks: import('../interfaces/task.js').TaskDefinition[] };
      const result = await workflowService.submitWorkflow({ tasks: body.tasks });
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof SubmissionError) {
        return reply.status(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  server.get<{ Params: { id: string } }>('/workflows/:id', async (request, reply) => {
    const workflow = await workflowService.getWorkflow(request.params.id);
    if (!workflow) {
      return reply.status(404).send({ error: 'Workflow not found' });
    }
    return reply.send(workflow);
  });

  server.post<{ Params: { id: string } }>('/workflows/:id/cancel', async (request, reply) => {
    const result = await workflowService.cancelWorkflow(request.params.id);
    return reply.status(result.statusCode).send(result.body);
  });
}

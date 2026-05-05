import { describe, it, expect } from 'vitest';
import { MinHeap, createTaskComparator, type TaskHeapEntry } from '../../../src/data-structures/min-heap.js';

describe('MinHeap', () => {
  it('insert 1000 random items, extractMin returns them in sorted order', () => {
    const heap = new MinHeap<number>((a, b) => a - b);
    const items: number[] = [];
    for (let i = 0; i < 1000; i++) {
      items.push(Math.random() * 100000);
    }
    for (const item of items) {
      heap.insert(item);
    }
    const sorted = items.slice().sort((a, b) => a - b);
    for (const expected of sorted) {
      expect(heap.extractMin()).toBe(expected);
    }
  });

  it('priority tie-breaking: same priority, earlier scheduledAt wins', () => {
    const compare = createTaskComparator();
    const heap = new MinHeap<TaskHeapEntry>(compare);

    heap.insert({ taskId: 'late', priority: 5, scheduledAt: 2000, submissionOrder: 1n });
    heap.insert({ taskId: 'early', priority: 5, scheduledAt: 1000, submissionOrder: 2n });

    expect(heap.extractMin()!.taskId).toBe('early');
    expect(heap.extractMin()!.taskId).toBe('late');
  });

  it('scheduledAt tie-breaking: same priority + scheduledAt, smaller submissionOrder wins', () => {
    const compare = createTaskComparator();
    const heap = new MinHeap<TaskHeapEntry>(compare);

    heap.insert({ taskId: 'second', priority: 5, scheduledAt: 1000, submissionOrder: 10n });
    heap.insert({ taskId: 'first', priority: 5, scheduledAt: 1000, submissionOrder: 5n });

    expect(heap.extractMin()!.taskId).toBe('first');
    expect(heap.extractMin()!.taskId).toBe('second');
  });

  it('extract from empty heap returns undefined', () => {
    const heap = new MinHeap<number>((a, b) => a - b);
    expect(heap.extractMin()).toBeUndefined();
  });

  it('peek does not remove the element', () => {
    const heap = new MinHeap<number>((a, b) => a - b);
    heap.insert(42);
    expect(heap.peek()).toBe(42);
    expect(heap.size()).toBe(1);
    expect(heap.peek()).toBe(42);
  });

  it('insert + extract interleaved maintains heap invariant', () => {
    const heap = new MinHeap<number>((a, b) => a - b);
    heap.insert(5);
    heap.insert(3);
    expect(heap.extractMin()).toBe(3);
    heap.insert(1);
    heap.insert(4);
    expect(heap.extractMin()).toBe(1);
    expect(heap.extractMin()).toBe(4);
    expect(heap.extractMin()).toBe(5);
    expect(heap.extractMin()).toBeUndefined();
  });

  it('10K entries stress test: all extracted in correct order', () => {
    const heap = new MinHeap<number>((a, b) => a - b);
    const items: number[] = [];
    for (let i = 0; i < 10000; i++) {
      items.push(Math.floor(Math.random() * 1000000));
    }
    for (const item of items) {
      heap.insert(item);
    }

    let prev = -Infinity;
    while (heap.size() > 0) {
      const val = heap.extractMin()!;
      expect(val).toBeGreaterThanOrEqual(prev);
      prev = val;
    }
  });

  it('higher priority (larger number) is extracted first with task comparator', () => {
    const compare = createTaskComparator();
    const heap = new MinHeap<TaskHeapEntry>(compare);

    heap.insert({ taskId: 'low', priority: 1, scheduledAt: 1000, submissionOrder: 1n });
    heap.insert({ taskId: 'high', priority: 10, scheduledAt: 1000, submissionOrder: 2n });

    expect(heap.extractMin()!.taskId).toBe('high');
    expect(heap.extractMin()!.taskId).toBe('low');
  });
});

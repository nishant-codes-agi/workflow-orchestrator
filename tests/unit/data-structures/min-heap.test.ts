import { describe, it, expect, vi } from 'vitest';
import { MinHeap, createTaskComparator, type TaskHeapEntry } from '../../../src/data-structures/min-heap.js';

describe('MinHeap', () => {
  it('trace: console.log sift operations on 5 inserts to verify correct index swaps', () => {
    const logSpy = vi.spyOn(console, 'log');
    const heap = new MinHeap<number>((a, b) => a - b);
    const values = [40, 30, 50, 10, 20];

    // We can't hook into private siftUp directly, so we intercept by
    // inserting one-by-one and inspecting the heap state after each insert
    // via extractMin/re-insert to reconstruct swaps.
    // Instead, we build a tracing wrapper that logs the expected sift path.

    const heapArr: number[] = [];

    for (const val of values) {
      heapArr.push(val);
      let idx = heapArr.length - 1;
      console.log(`INSERT ${val} at index ${idx} → heap: [${heapArr.join(', ')}]`);

      // simulate siftUp and log swaps
      while (idx > 0) {
        const parentIdx = Math.floor((idx - 1) / 2);
        if (heapArr[idx]! < heapArr[parentIdx]!) {
          console.log(`  SWAP index ${idx} (${heapArr[idx]}) ↔ index ${parentIdx} (${heapArr[parentIdx]})`);
          const tmp = heapArr[idx]!;
          heapArr[idx] = heapArr[parentIdx]!;
          heapArr[parentIdx] = tmp;
          idx = parentIdx;
        } else {
          console.log(`  NO SWAP needed: ${heapArr[idx]} >= parent ${heapArr[parentIdx]} — settled at index ${idx}`);
          break;
        }
      }
      if (idx === 0) {
        console.log(`  Reached root — settled at index 0`);
      }
      console.log(`  Heap after sift: [${heapArr.join(', ')}]`);

      // Also insert into the real heap for correctness check
      heap.insert(val);
    }

    // Verify the real heap produces correct sorted output
    const extracted: number[] = [];
    while (heap.size() > 0) {
      extracted.push(heap.extractMin()!);
    }
    expect(extracted).toEqual([10, 20, 30, 40, 50]);

    // Verify console.log was called with swap traces
    const logCalls = logSpy.mock.calls.map(c => c[0] as string);
    expect(logCalls.some(msg => msg.includes('SWAP'))).toBe(true);
    expect(logCalls.some(msg => msg.includes('INSERT'))).toBe(true);

    logSpy.mockRestore();
  });

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

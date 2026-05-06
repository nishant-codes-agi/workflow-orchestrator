import { describe, it, expect, vi } from 'vitest';
import { BoundedSemaphore } from '../../../src/data-structures/bounded-semaphore.js';

describe('BoundedSemaphore', () => {
  it('trace: console.log acquire/release during concurrent test, confirm max 3 in parallel', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const sem = new BoundedSemaphore(3);
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 10 }, async (_, i) => {
      await sem.acquire();
      running++;
      console.log(`ACQUIRE task-${i}: running=${running}, permits=${sem.availablePermits()}`);
      if (running > maxRunning) maxRunning = running;
      // assert invariant on every acquire
      expect(running).toBeLessThanOrEqual(3);
      await new Promise((r) => setTimeout(r, Math.random() * 20));
      running--;
      sem.release();
      console.log(`RELEASE task-${i}: running=${running}, permits=${sem.availablePermits()}`);
    });

    await Promise.all(tasks);

    expect(maxRunning).toBeLessThanOrEqual(3);
    expect(sem.availablePermits()).toBe(3);

    // Verify acquire/release logs were emitted
    const logCalls = logSpy.mock.calls.map(c => c[0] as string);
    const acquireLogs = logCalls.filter(msg => msg.startsWith('ACQUIRE'));
    const releaseLogs = logCalls.filter(msg => msg.startsWith('RELEASE'));
    expect(acquireLogs.length).toBe(10);
    expect(releaseLogs.length).toBe(10);

    // Verify no logged running count exceeds 3
    for (const msg of acquireLogs) {
      const match = msg.match(/running=(\d+)/);
      expect(Number(match![1])).toBeLessThanOrEqual(3);
    }

    logSpy.mockRestore();
  });

  it('acquire 3 times immediately, 4th blocks until release', async () => {
    const sem = new BoundedSemaphore(3);

    await sem.acquire();
    await sem.acquire();
    await sem.acquire();

    let fourthResolved = false;
    const fourthPromise = sem.acquire().then(() => {
      fourthResolved = true;
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(fourthResolved).toBe(false);

    sem.release();
    await fourthPromise;
    expect(fourthResolved).toBe(true);
  });

  it('release unblocks oldest waiter first (FIFO)', async () => {
    const sem = new BoundedSemaphore(1);
    await sem.acquire();

    const order: number[] = [];

    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));
    const p3 = sem.acquire().then(() => order.push(3));

    sem.release();
    await p1;

    sem.release();
    await p2;

    sem.release();
    await p3;

    expect(order).toEqual([1, 2, 3]);
  });

  it('availablePermits reflects current state', async () => {
    const sem = new BoundedSemaphore(3);
    expect(sem.availablePermits()).toBe(3);

    await sem.acquire();
    expect(sem.availablePermits()).toBe(2);

    await sem.acquire();
    expect(sem.availablePermits()).toBe(1);

    sem.release();
    expect(sem.availablePermits()).toBe(2);

    sem.release();
    expect(sem.availablePermits()).toBe(3);
  });

  it('rapid acquire/release cycle (1000 iterations): no deadlock, no drift', async () => {
    const sem = new BoundedSemaphore(1);

    for (let i = 0; i < 1000; i++) {
      await sem.acquire();
      sem.release();
    }

    expect(sem.availablePermits()).toBe(1);
  });

  it('concurrent scenario: 10 tasks with semaphore(3), max 3 running simultaneously', async () => {
    const sem = new BoundedSemaphore(3);
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 10 }, async () => {
      await sem.acquire();
      running++;
      if (running > maxRunning) maxRunning = running;
      await new Promise((r) => setTimeout(r, 10));
      running--;
      sem.release();
    });

    await Promise.all(tasks);

    expect(maxRunning).toBeLessThanOrEqual(3);
    expect(sem.availablePermits()).toBe(3);
  });
});

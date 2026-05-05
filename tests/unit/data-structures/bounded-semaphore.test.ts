import { describe, it, expect } from 'vitest';
import { BoundedSemaphore } from '../../../src/data-structures/bounded-semaphore.js';

describe('BoundedSemaphore', () => {
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

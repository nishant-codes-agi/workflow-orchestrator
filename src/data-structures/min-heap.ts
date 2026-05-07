export interface TaskHeapEntry {
  taskId: string;
  priority: number;
  scheduledAt: number;
  submissionOrder: bigint;
}

export function createTaskComparator(): (a: TaskHeapEntry, b: TaskHeapEntry) => number {
  return (a: TaskHeapEntry, b: TaskHeapEntry): number => {
    if (-a.priority !== -b.priority) return -a.priority - -b.priority;
    if (a.scheduledAt !== b.scheduledAt) return a.scheduledAt - b.scheduledAt;
    return a.submissionOrder < b.submissionOrder ? -1 : 1;
  };
}

export class MinHeap<T> {
  private heap: T[] = [];
  private readonly compare: (a: T, b: T) => number;

  constructor(comparator: (a: T, b: T) => number) {
    this.compare = comparator;
  }

  insert(item: T): void {
    this.heap.push(item);
    this.siftUp(this.heap.length - 1);
  }

  extractMin(): T | undefined {
    if (this.heap.length === 0) return undefined;
    const min = this.heap[0];
    if (min === undefined) return undefined;
    const last = this.heap.pop();
    if (last === undefined) return min;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return min;
  }

  peek(): T | undefined {
    return this.heap[0];
  }

  size(): number {
    return this.heap.length;
  }

  private siftUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const parent = this.heap[parentIndex];
      const current = this.heap[index];
      if (parent === undefined || current === undefined) break;
      if (this.compare(current, parent) >= 0) break;
      this.heap[parentIndex] = current;
      this.heap[index] = parent;
      index = parentIndex;
    }
  }

  private siftDown(index: number): void {
    const length = this.heap.length;
    while (true) {
      let smallest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;

      const smallestVal = this.heap[smallest];
      const leftVal = this.heap[left];
      const rightVal = this.heap[right];

      if (smallestVal === undefined) break;
      if (left < length && leftVal !== undefined && this.compare(leftVal, smallestVal) < 0) {
        smallest = left;
      }
      const newSmallestVal = this.heap[smallest];
      if (newSmallestVal === undefined) break;
      if (right < length && rightVal !== undefined && this.compare(rightVal, newSmallestVal) < 0) {
        smallest = right;
      }

      if (smallest === index) break;

      const temp = this.heap[index];
      const swapVal = this.heap[smallest];
      if (temp === undefined || swapVal === undefined) break;
      this.heap[index] = swapVal;
      this.heap[smallest] = temp;
      index = smallest;
    }
  }
}

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
    const min = this.heap[0]!;
    const last = this.heap.pop()!;
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
      const parent = this.heap[parentIndex]!;
      const current = this.heap[index]!;
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

      if (left < length && this.compare(this.heap[left]!, this.heap[smallest]!) < 0) {
        smallest = left;
      }
      if (right < length && this.compare(this.heap[right]!, this.heap[smallest]!) < 0) {
        smallest = right;
      }

      if (smallest === index) break;

      const temp = this.heap[index]!;
      this.heap[index] = this.heap[smallest]!;
      this.heap[smallest] = temp;
      index = smallest;
    }
  }
}

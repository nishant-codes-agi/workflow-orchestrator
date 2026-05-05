import { describe, it, expect } from 'vitest';
import { detectCycle } from '../../../src/data-structures/cycle-detector.js';

describe('detectCycle', () => {
  it('self-loop: A -> A returns [A, A]', () => {
    const adj = new Map([['A', ['A']]]);
    const result = detectCycle(adj);
    expect(result).toEqual(['A', 'A']);
  });

  it('simple cycle: A -> B -> C -> A returns path', () => {
    const adj = new Map([
      ['A', ['B']],
      ['B', ['C']],
      ['C', ['A']],
    ]);
    const result = detectCycle(adj);
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(1);
    expect(result![0]).toBe(result![result!.length - 1]);
  });

  it('diamond: A -> B, A -> C, B -> D, C -> D returns null (valid DAG)', () => {
    const adj = new Map([
      ['A', ['B', 'C']],
      ['B', ['D']],
      ['C', ['D']],
      ['D', []],
    ]);
    expect(detectCycle(adj)).toBeNull();
  });

  it('disconnected components: two separate subgraphs, one with cycle', () => {
    const adj = new Map([
      ['A', ['B']],
      ['B', []],
      ['C', ['D']],
      ['D', ['E']],
      ['E', ['C']],
    ]);
    const result = detectCycle(adj);
    expect(result).not.toBeNull();
    const path = result!;
    expect(path[0]).toBe(path[path.length - 1]);
  });

  it('long chain (100 nodes) with back-edge at end returns full cycle path', () => {
    const adj = new Map<string, string[]>();
    for (let i = 0; i < 100; i++) {
      adj.set(`node-${i}`, [`node-${i + 1}`]);
    }
    adj.set('node-100', ['node-0']);

    const result = detectCycle(adj);
    expect(result).not.toBeNull();
    expect(result![0]).toBe(result![result!.length - 1]);
  });

  it('empty graph returns null', () => {
    const adj = new Map<string, string[]>();
    expect(detectCycle(adj)).toBeNull();
  });

  it('single node, no edges returns null', () => {
    const adj = new Map([['A', [] as string[]]]);
    expect(detectCycle(adj)).toBeNull();
  });

  it('multiple cycles: returns any one of them', () => {
    const adj = new Map([
      ['A', ['B']],
      ['B', ['A']],
      ['C', ['D']],
      ['D', ['C']],
    ]);
    const result = detectCycle(adj);
    expect(result).not.toBeNull();
    const path = result!;
    expect(path[0]).toBe(path[path.length - 1]);
  });

  it('complex DAG with no cycle returns null', () => {
    const adj = new Map([
      ['A', ['B', 'C']],
      ['B', ['D', 'E']],
      ['C', ['E', 'F']],
      ['D', ['G']],
      ['E', ['G']],
      ['F', ['G']],
      ['G', []],
    ]);
    expect(detectCycle(adj)).toBeNull();
  });
});

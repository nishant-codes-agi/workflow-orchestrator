import { describe, it, expect, vi } from 'vitest';
import { detectCycle } from '../../../src/data-structures/cycle-detector.js';

// Color constants matching the source implementation
const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

function colorName(c: number): string {
  switch (c) {
    case WHITE: return 'WHITE';
    case GRAY: return 'GRAY';
    case BLACK: return 'BLACK';
    default: return `UNKNOWN(${c})`;
  }
}

/**
 * A tracing wrapper that performs the same DFS cycle detection
 * but logs every color transition to console.log for diagnostic visibility.
 */
function detectCycleWithTrace(adjacency: Map<string, string[]>): string[] | null {
  const color = new Map<string, number>();

  for (const node of adjacency.keys()) {
    color.set(node, WHITE);
    console.log(`INIT ${node} → ${colorName(WHITE)}`);
  }

  function dfsTrace(node: string, path: string[]): string[] | null {
    const prevColor = color.get(node)!;
    color.set(node, GRAY);
    console.log(`VISIT ${node}: ${colorName(prevColor)} → ${colorName(GRAY)} | path=[${path.join(', ')}, ${node}]`);
    path.push(node);

    const neighbors = adjacency.get(node) ?? [];
    for (const neighbor of neighbors) {
      const neighborColor = color.get(neighbor)!;
      if (neighborColor === GRAY) {
        console.log(`CYCLE DETECTED: ${neighbor} is ${colorName(GRAY)} while visiting from ${node}`);
        return [...path, neighbor];
      }
      if (neighborColor === WHITE) {
        const cycle = dfsTrace(neighbor, path);
        if (cycle) return cycle;
      } else {
        console.log(`SKIP ${neighbor}: already ${colorName(neighborColor)}`);
      }
    }

    color.set(node, BLACK);
    console.log(`FINISH ${node}: ${colorName(GRAY)} → ${colorName(BLACK)}`);
    path.pop();
    return null;
  }

  for (const node of adjacency.keys()) {
    if (color.get(node) === WHITE) {
      const cycle = dfsTrace(node, []);
      if (cycle) return cycle;
    }
  }

  return null;
}

describe('detectCycle', () => {
  it('trace: log color transitions for a 4-node diamond DAG, confirm no false positive', () => {
    const logSpy = vi.spyOn(console, 'log');

    const adj = new Map([
      ['A', ['B', 'C']],
      ['B', ['D']],
      ['C', ['D']],
      ['D', [] as string[]],
    ]);

    // Run our tracing version
    const traceResult = detectCycleWithTrace(adj);

    // Also run the real implementation to verify they agree
    const realResult = detectCycle(adj);

    // Both must return null (no cycle in a diamond DAG)
    expect(traceResult).toBeNull();
    expect(realResult).toBeNull();

    // Verify the log output
    const logCalls = logSpy.mock.calls.map(c => c[0] as string);

    // Every node should have been initialized to WHITE
    for (const node of ['A', 'B', 'C', 'D']) {
      expect(logCalls.some(msg => msg.includes(`INIT ${node}`))).toBe(true);
    }

    // Every node should have been visited (WHITE → GRAY)
    for (const node of ['A', 'B', 'C', 'D']) {
      expect(logCalls.some(msg => msg.includes(`VISIT ${node}`) && msg.includes('WHITE → GRAY'))).toBe(true);
    }

    // Every node should have finished (GRAY → BLACK)
    for (const node of ['A', 'B', 'C', 'D']) {
      expect(logCalls.some(msg => msg.includes(`FINISH ${node}`) && msg.includes('GRAY → BLACK'))).toBe(true);
    }

    // D should be skipped when visited from C (already BLACK)
    expect(logCalls.some(msg => msg.includes('SKIP D') && msg.includes('BLACK'))).toBe(true);

    // No cycle should have been detected
    expect(logCalls.some(msg => msg.includes('CYCLE DETECTED'))).toBe(false);

    logSpy.mockRestore();
  });

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

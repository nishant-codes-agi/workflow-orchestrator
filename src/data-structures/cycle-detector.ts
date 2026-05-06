const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

export function detectCycle(adjacency: Map<string, string[]>): string[] | null {
  const color = new Map<string, number>();

  for (const node of adjacency.keys()) {
    color.set(node, WHITE);
  }

  for (const node of adjacency.keys()) {
    if (color.get(node) === WHITE) {
      const cycle = dfs(node, color, adjacency, []);
      if (cycle) return cycle;
    }
  }

  return null;
}

function dfs(
  node: string,
  color: Map<string, number>,
  adjacency: Map<string, string[]>,
  path: string[],
): string[] | null {
  color.set(node, GRAY);
  path.push(node);

  const neighbors = adjacency.get(node) ?? [];
  for (const neighbor of neighbors) {
    if (color.get(neighbor) === GRAY) {
      return [...path, neighbor];
    }
    if (color.get(neighbor) === WHITE) {
      const cycle = dfs(neighbor, color, adjacency, path);
      if (cycle) return cycle;
    }
  }

  color.set(node, BLACK);
  path.pop();
  return null;
}

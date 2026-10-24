import { isWalkable, type Point } from "./layout";

interface Node {
  x: number;
  y: number;
  g: number;
  f: number;
  parent: Node | null;
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/**
 * A* on a 4-neighbour grid. Cheap and deterministic: ties break on the
 * insertion order, so tests are stable.
 */
export function findPath(
  start: Point,
  goal: Point,
  walkable: (x: number, y: number) => boolean = isWalkable,
): Point[] {
  if (start.x === goal.x && start.y === goal.y) return [];
  if (!walkable(goal.x, goal.y)) return [];

  const open: Node[] = [{ x: start.x, y: start.y, g: 0, f: heuristic(start, goal), parent: null }];
  const best = new Map<string, number>([[`${start.x},${start.y}`, 0]]);
  const closed = new Set<string>();

  while (open.length > 0) {
    open.sort((a, b) => a.f - b.f || a.g - b.g);
    const current = open.shift() as Node;
    const key = `${current.x},${current.y}`;
    if (closed.has(key)) continue;
    closed.add(key);

    if (current.x === goal.x && current.y === goal.y) return unwind(current);

    for (const [dx, dy] of NEIGHBOURS) {
      const x = current.x + (dx as number);
      const y = current.y + (dy as number);
      const nextKey = `${x},${y}`;
      if (closed.has(nextKey) || !walkable(x, y)) continue;
      const g = current.g + 1;
      if (g >= (best.get(nextKey) ?? Number.POSITIVE_INFINITY)) continue;
      best.set(nextKey, g);
      open.push({ x, y, g, f: g + heuristic({ x, y }, goal), parent: current });
    }
  }
  return [];
}

function heuristic(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function unwind(node: Node): Point[] {
  const path: Point[] = [];
  let current: Node | null = node;
  while (current) {
    path.push({ x: current.x, y: current.y });
    current = current.parent;
  }
  path.reverse();
  return path.slice(1);
}

/** Compress a tile path into straight runs, for fewer direction changes. */
export function simplifyPath(path: Point[]): Point[] {
  if (path.length < 3) return path;
  const out: Point[] = [path[0] as Point];
  for (let index = 1; index < path.length - 1; index++) {
    const previous = path[index - 1] as Point;
    const current = path[index] as Point;
    const next = path[index + 1] as Point;
    const sameRow = previous.y === current.y && current.y === next.y;
    const sameColumn = previous.x === current.x && current.x === next.x;
    if (!sameRow && !sameColumn) out.push(current);
  }
  out.push(path[path.length - 1] as Point);
  return out;
}

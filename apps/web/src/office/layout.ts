/** Static office layout. Pure data so it can be unit-tested without Pixi. */

export const TILE = 32;
export const COLS = 32;
export const ROWS = 20;
export const WORLD_WIDTH = COLS * TILE;
export const WORLD_HEIGHT = ROWS * TILE;

export type ZoneId = "boss" | "dev" | "meeting" | "server" | "break";

export interface Zone {
  id: ZoneId;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  floor: number;
  floorAlt: number;
}

export const ZONES: Zone[] = [
  { id: "boss", label: "BOSS OFFICE", x: 1, y: 1, w: 7, h: 7, floor: 0x2b2438, floorAlt: 0x322a42 },
  { id: "dev", label: "DEV BULLPEN", x: 9, y: 1, w: 22, h: 10, floor: 0x1c2a35, floorAlt: 0x213140 },
  { id: "meeting", label: "MEETING ROOM", x: 1, y: 12, w: 10, h: 7, floor: 0x2c2530, floorAlt: 0x332b38 },
  { id: "server", label: "SERVER ROOM", x: 12, y: 12, w: 8, h: 7, floor: 0x1a2b28, floorAlt: 0x1f322e },
  { id: "break", label: "BREAK ROOM", x: 21, y: 12, w: 10, h: 7, floor: 0x2f2a1d, floorAlt: 0x373122 },
];

export interface Point {
  x: number;
  y: number;
}

export interface Desk {
  role: string;
  /** The desk tile itself, not walkable. */
  tile: Point;
  /** Where the agent stands, adjacent to the desk. */
  stand: Point;
  facing: "down" | "up" | "left" | "right";
}

export const DESKS: Desk[] = [
  { role: "boss", tile: { x: 4, y: 3 }, stand: { x: 4, y: 4 }, facing: "up" },
  { role: "frontend", tile: { x: 12, y: 3 }, stand: { x: 12, y: 4 }, facing: "up" },
  { role: "backend", tile: { x: 16, y: 3 }, stand: { x: 16, y: 4 }, facing: "up" },
  { role: "devops", tile: { x: 20, y: 3 }, stand: { x: 20, y: 4 }, facing: "up" },
  { role: "qa", tile: { x: 12, y: 7 }, stand: { x: 12, y: 8 }, facing: "up" },
  { role: "docs", tile: { x: 16, y: 7 }, stand: { x: 16, y: 8 }, facing: "up" },
];

export function deskFor(role: string): Desk {
  return DESKS.find((desk) => desk.role === role) ?? DESKS[2]!;
}

/** Props are solid tiles that make the office feel lived in. */
export const PROPS: Array<{ kind: "table" | "coffee" | "rack" | "plant" | "couch"; x: number; y: number; w?: number; h?: number }> = [
  { kind: "table", x: 3, y: 15, w: 4, h: 2 },
  { kind: "coffee", x: 24, y: 15 },
  { kind: "rack", x: 14, y: 14 },
  { kind: "rack", x: 15, y: 14 },
  { kind: "rack", x: 16, y: 14 },
  { kind: "plant", x: 2, y: 2 },
  { kind: "plant", x: 29, y: 2 },
  { kind: "plant", x: 10, y: 18 },
  { kind: "couch", x: 26, y: 16, w: 2, h: 1 },
];

export const ENTRANCE: Point = { x: 18, y: 18 };
export const BREAK_SPOT: Point = { x: 23, y: 16 };
export const MEETING_SPOTS: Point[] = [
  { x: 3, y: 14 },
  { x: 4, y: 14 },
  { x: 5, y: 14 },
  { x: 6, y: 14 },
  { x: 3, y: 17 },
  { x: 4, y: 17 },
  { x: 5, y: 17 },
  { x: 6, y: 17 },
];

const deskTiles = new Set(DESKS.map((desk) => `${desk.tile.x},${desk.tile.y}`));
const propTiles = new Set<string>();
for (const prop of PROPS) {
  const w = prop.w ?? 1;
  const h = prop.h ?? 1;
  for (let dx = 0; dx < w; dx++) {
    for (let dy = 0; dy < h; dy++) propTiles.add(`${prop.x + dx},${prop.y + dy}`);
  }
}
const breakTiles = new Set<string>();
// The break-room counter is decor, not a wall.

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < COLS && y < ROWS;
}

export function isWall(x: number, y: number): boolean {
  return x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1;
}

export function isWalkable(x: number, y: number): boolean {
  if (!inBounds(x, y) || isWall(x, y)) return false;
  const key = `${x},${y}`;
  if (deskTiles.has(key)) return false;
  if (propTiles.has(key)) return false;
  if (breakTiles.has(key)) return false;
  return true;
}

export function zoneAt(x: number, y: number): Zone | undefined {
  return ZONES.find(
    (zone) => x >= zone.x && x < zone.x + zone.w && y >= zone.y && y < zone.y + zone.h,
  );
}

/** Nearest walkable tile to a point, used for entrance and emergency moves. */
export function nearestWalkable(point: Point): Point {
  if (isWalkable(point.x, point.y)) return point;
  for (let radius = 1; radius <= 6; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        if (isWalkable(point.x + dx, point.y + dy)) return { x: point.x + dx, y: point.y + dy };
      }
    }
  }
  return { x: 1, y: 1 };
}

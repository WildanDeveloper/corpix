import {
  Application,
  Container,
  Graphics,
  Sprite,
  Text,
  type Ticker,
} from "pixi.js";
import type { AgentState } from "@corpix/shared";

/** The subset of the event envelope the office needs. */
export interface SceneEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}
import {
  BREAK_SPOT,
  COLS,
  DESKS,
  ENTRANCE,
  PROPS,
  ROWS,
  TILE,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  ZONES,
  deskFor,
  isWalkable,
  nearestWalkable,
  zoneAt,
  type Point,
} from "./layout";
import { findPath, simplifyPath } from "./pathfinding";
import { frameTexture, type Facing, type Pose } from "./sprites";

const ROLE_COLORS: Record<string, number> = {
  boss: 0xffd75e,
  frontend: 0x7fb2ff,
  backend: 0x6fd7a0,
  devops: 0xffab6b,
  qa: 0xc99bff,
  docs: 0x7fdcdc,
};

const WALK_SPEED = 3.4 * TILE; // pixels per second

interface OfficeAgent {
  id: string;
  role: string;
  name: string;
  root: Container;
  sprite: Sprite;
  label: Text;
  status: Text;
  bubble: Container | null;
  bubbleTimer: number;
  state: AgentState;
  pose: Pose;
  facing: Facing;
  path: Point[];
  tile: Point;
  frame: number;
  clock: number;
  tool?: string;
  idleAfter: number;
}

export interface SceneOptions {
  reducedMotion?: boolean;
}

/**
 * A tiny pixel-art office rendered with PixiJS. It is a pure renderer: agents
 * exist because events told it they do, and every animation maps to a state.
 */
export class OfficeScene {
  private readonly agents = new Map<string, OfficeAgent>();
  private readonly deskScreens = new Map<string, Graphics>();
  private readonly roleNames = new Map<string, string>();
  private readonly reducedMotion: boolean;
  private ready = false;
  private destroyed = false;

  private constructor(
    private readonly app: Application,
    private readonly host: HTMLElement,
    options: SceneOptions,
  ) {
    this.reducedMotion = options.reducedMotion ?? false;
  }

  static async create(host: HTMLElement, options: SceneOptions = {}): Promise<OfficeScene> {
    const app = new Application();
    await app.init({
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
      background: 0x0b0f14,
      antialias: false,
      resolution: 1,
      autoDensity: false,
    });
    const scene = new OfficeScene(app, host, options);
    app.canvas.style.width = "100%";
    app.canvas.style.height = "100%";
    app.canvas.style.display = "block";
    app.canvas.style.imageRendering = "pixelated";
    host.appendChild(app.canvas);
    // Depth sorting: things lower on the screen draw in front, so an agent
    // walking past a desk occludes it and a seated agent sits behind it.
    app.stage.sortableChildren = true;
    scene.drawStatic();
    scene.ready = true;
    app.ticker.add((ticker: Ticker) => scene.update(ticker.deltaMS / 1000));
    return scene;
  }

  setRoleNames(roleNames: Record<string, string>): void {
    for (const [role, name] of Object.entries(roleNames)) this.roleNames.set(role, name);
    for (const agent of this.agents.values()) {
      agent.name = this.roleNames.get(agent.role) ?? agent.name;
      agent.label.text = agent.name;
    }
  }

  /** Every event is applied relative to the run it belongs to. */
  applyEvent(event: SceneEvent): void {
    if (!this.ready || this.destroyed) return;
    const payload = event.payload as Record<string, unknown>;
    switch (event.type) {
      case "run.started":
        this.reset();
        break;
      case "task.assigned":
      case "task.started": {
        const agent = this.ensure(
          String(payload.agentId ?? ""),
          String(payload.role ?? "backend"),
        );
        if (!agent) break;
        this.sendToDesk(agent);
        if (typeof payload.title === "string") this.say(agent, payload.title, 2.2);
        break;
      }
      case "agent.state_changed": {
        const agent = this.ensure(
          String(payload.agentId ?? ""),
          roleFromAgentId(String(payload.agentId ?? "")),
        );
        if (!agent) break;
        this.setState(agent, payload.to as AgentState, payload.tool as string | undefined);
        break;
      }
      case "tool.called": {
        const agent = this.agents.get(String(payload.agentId ?? ""));
        if (!agent) break;
        agent.tool = String(payload.tool ?? "");
        this.setState(agent, "working", agent.tool);
        break;
      }
      case "message.sent": {
        const agent = this.agents.get(String(payload.from ?? ""));
        if (agent && typeof payload.text === "string") this.say(agent, payload.text, 3.5);
        break;
      }
      case "task.completed": {
        const agent = this.agents.get(String(payload.agentId ?? ""));
        if (!agent) break;
        this.setState(agent, "done");
        if (typeof payload.summary === "string") this.say(agent, payload.summary, 3);
        break;
      }
      case "task.failed": {
        const agent = this.agents.get(String(payload.agentId ?? ""));
        if (agent) this.setState(agent, "error");
        break;
      }
      case "approval.requested": {
        const agent = this.agents.get(String(payload.agentId ?? ""));
        if (agent) this.setState(agent, "blocked");
        break;
      }
      case "review.started": {
        const qa = [...this.agents.values()].find((entry) => entry.role === "qa");
        if (qa) {
          this.sendToDesk(qa);
          this.say(qa, "Reviewing the integration branch…", 3);
        }
        break;
      }
      case "run.finished":
      case "run.failed":
      case "run.cancelled": {
        for (const agent of this.agents.values()) this.setState(agent, "idle");
        break;
      }
      default:
        break;
    }
  }

  reset(): void {
    for (const agent of this.agents.values()) agent.root.destroy({ children: true });
    this.agents.clear();
    for (const screen of this.deskScreens.values()) {
      screen.clear().rect(0, 0, 14, 8).fill(0x1a2630);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.app.destroy(true, { children: true });
    this.host.replaceChildren();
  }

  // --- agents ---------------------------------------------------------------

  private ensure(agentId: string, role: string): OfficeAgent | null {
    if (!agentId) return null;
    const existing = this.agents.get(agentId);
    if (existing) return existing;

    const name = this.roleNames.get(role) ?? titleCase(role);
    const root = new Container();
    const sprite = new Sprite(frameTexture(role, "down", "idle", 0));
    sprite.anchor.set(0.5, 1);
    sprite.width = 36;
    sprite.height = 48;
    root.addChild(sprite);

    const label = new Text({
      text: name,
      style: {
        fontFamily: "ui-monospace, monospace",
        fontSize: 9,
        fill: ROLE_COLORS[role] ?? 0xffffff,
        stroke: { color: 0x0b0f14, width: 3 },
      },
    });
    label.anchor.set(0.5, 1);
    label.position.set(0, -50);
    root.addChild(label);

    const status = new Text({
      text: "",
      style: {
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        fill: 0xffffff,
        stroke: { color: 0x0b0f14, width: 3 },
      },
    });
    status.anchor.set(0.5, 1);
    status.position.set(0, -62);
    root.addChild(status);

    const start = nearestWalkable(ENTRANCE);
    root.position.set(start.x * TILE + TILE / 2, start.y * TILE + TILE - 2);
    root.zIndex = root.position.y;
    this.app.stage.addChild(root);

    const agent: OfficeAgent = {
      id: agentId,
      role,
      name,
      root,
      sprite,
      label,
      status,
      bubble: null,
      bubbleTimer: 0,
      state: "idle",
      pose: "idle",
      facing: "down",
      path: [],
      tile: start,
      frame: 0,
      clock: 0,
      idleAfter: 0,
    };
    this.agents.set(agentId, agent);
    this.facingTexture(agent);
    void this.sendToDesk(agent);
    return agent;
  }

  private sendToDesk(agent: OfficeAgent): void {
    const desk = deskFor(agent.role);
    const target = this.reserveStand(agent, desk.stand);
    this.walkTo(agent, target, desk.facing);
  }

  /** Two agents on the same role must not stand on the same tile. */
  private reserveStand(agent: OfficeAgent, preferred: Point): Point {
    const occupied = new Set(
      [...this.agents.values()]
        .filter((other) => other.id !== agent.id && other.path.length === 0)
        .map((other) => `${other.tile.x},${other.tile.y}`),
    );
    if (!occupied.has(`${preferred.x},${preferred.y}`) && isWalkable(preferred.x, preferred.y)) {
      return preferred;
    }
    for (let radius = 1; radius <= 4; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          const x = preferred.x + dx;
          const y = preferred.y + dy;
          if (!isWalkable(x, y)) continue;
          if (occupied.has(`${x},${y}`)) continue;
          return { x, y };
        }
      }
    }
    return nearestWalkable(preferred);
  }

  private walkTo(agent: OfficeAgent, target: Point, facing?: Facing): void {
    const path = simplifyPath(findPath(agent.tile, target));
    if (path.length === 0) {
      agent.tile = target;
      agent.root.position.set(target.x * TILE + TILE / 2, target.y * TILE + TILE - 2);
      if (facing) {
        agent.facing = facing;
        this.facingTexture(agent);
      }
      return;
    }
    if (this.reducedMotion) {
      agent.tile = target;
      agent.path = [];
      agent.root.position.set(target.x * TILE + TILE / 2, target.y * TILE + TILE - 2);
      if (facing) {
        agent.facing = facing;
        this.facingTexture(agent);
      }
      return;
    }
    agent.path = path;
    agent.state = "walking";
    agent.pose = "walk";
    agent.status.text = "";
  }

  private setState(agent: OfficeAgent, state: AgentState, tool?: string): void {
    if (state === "walking") {
      agent.state = "walking";
      return;
    }
    agent.state = state;
    agent.tool = tool ?? agent.tool;
    agent.status.text = "";
    agent.status.style.fill = 0xffffff;

    switch (state) {
      case "thinking":
        agent.pose = "idle";
        agent.status.text = "…";
        agent.status.style.fill = 0x9fb3c8;
        break;
      case "working":
        agent.pose = "type";
        if (agent.tool === "run_command") {
          agent.status.text = ">_";
          agent.status.style.fill = 0x6fd7a0;
        } else if (agent.tool === "write_file" || agent.tool === "edit_file") {
          agent.status.text = "⌨";
          agent.status.style.fill = 0xffd75e;
        } else {
          agent.status.text = "•";
          agent.status.style.fill = 0x9fb3c8;
        }
        break;
      case "blocked":
        agent.pose = "idle";
        agent.status.text = "!";
        agent.status.style.fill = 0xffab6b;
        break;
      case "done":
        agent.pose = "idle";
        agent.status.text = "✓";
        agent.status.style.fill = 0x6fd7a0;
        agent.idleAfter = 2.5;
        break;
      case "error":
        agent.pose = "idle";
        agent.status.text = "✖";
        agent.status.style.fill = 0xff6b6b;
        agent.idleAfter = 3;
        break;
      default:
        agent.pose = "sit";
        break;
    }
    this.facingTexture(agent);
    this.updateDeskScreen(agent.role);
  }

  private updateDeskScreen(role: string): void {
    const screen = this.deskScreens.get(role);
    if (!screen) return;
    const active = [...this.agents.values()].some(
      (agent) => agent.role === role && (agent.state === "working" || agent.state === "thinking"),
    );
    const accent = ROLE_COLORS[role] ?? 0xffffff;
    screen
      .clear()
      .rect(0, 0, 14, 9)
      .fill(active ? accent : 0x1a2630)
      .rect(1, 1, 12, 7)
      .fill(active ? 0x0d161d : 0x0f1a22);
  }

  private say(agent: OfficeAgent, raw: string, seconds: number): void {
    const text = raw.length > 90 ? `${raw.slice(0, 87)}…` : raw;
    if (agent.bubble) {
      agent.root.removeChild(agent.bubble);
      agent.bubble.destroy({ children: true });
    }
    const bubble = new Container();
    const label = new Text({
      text,
      style: {
        fontFamily: "ui-monospace, monospace",
        fontSize: 8,
        fill: 0x0b0f14,
        wordWrap: true,
        wordWrapWidth: 140,
        lineHeight: 10,
      },
    });
    label.position.set(6, 5);
    const box = new Graphics();
    const width = Math.min(154, Math.max(30, label.width + 12));
    const height = label.height + 10;
    box.roundRect(0, 0, width, height, 4).fill(0xf0f4f8).stroke({ color: 0x0b0f14, width: 1 });
    box
      .moveTo(10, height)
      .lineTo(16, height)
      .lineTo(13, height + 5)
      .fill(0xf0f4f8);
    bubble.addChild(box, label);
    bubble.position.set(-width / 2, -70 - height);
    agent.root.addChild(bubble);
    agent.bubble = bubble;
    agent.bubbleTimer = seconds;
  }

  private facingTexture(agent: OfficeAgent): void {
    const pose: Pose = agent.pose === "walk" ? "walk" : agent.pose;
    agent.sprite.texture = frameTexture(agent.role, agent.facing, pose, agent.frame);
  }

  // --- loop -----------------------------------------------------------------

  private updateDepth(agent: OfficeAgent): void {
    // Seated agents tuck behind their desk; walking agents sort by their feet.
    const seated = agent.path.length === 0 && agent.pose !== "walk";
    const feet = agent.root.y;
    agent.root.zIndex = seated ? feet - TILE * 1.4 : feet;
  }

  private update(delta: number): void {
    if (this.destroyed) return;
    for (const agent of this.agents.values()) {
      agent.clock += delta;

      if (agent.idleAfter > 0) {
        agent.idleAfter -= delta;
        if (agent.idleAfter <= 0) {
          agent.idleAfter = 0;
          this.setState(agent, "idle");
        }
      }

      if (agent.path.length > 0) {
        this.step(agent, delta);
      } else if (agent.state === "walking") {
        agent.state = "thinking";
        agent.pose = "sit";
        this.facingTexture(agent);
      }

      if (agent.state === "walking") {
        agent.frame = Math.floor(agent.clock * 8) % 4;
        agent.pose = "walk";
      } else if (agent.pose === "type") {
        agent.frame = Math.floor(agent.clock * 6) % 2;
      } else {
        agent.frame = 0;
      }
      this.facingTexture(agent);
      this.updateDepth(agent);

      if (agent.bubbleTimer > 0) {
        agent.bubbleTimer -= delta;
        if (agent.bubbleTimer <= 0 && agent.bubble) {
          agent.root.removeChild(agent.bubble);
          agent.bubble.destroy({ children: true });
          agent.bubble = null;
        }
      }
    }
  }

  private step(agent: OfficeAgent, delta: number): void {
    const next = agent.path[0];
    if (!next) return;
    const targetX = next.x * TILE + TILE / 2;
    const targetY = next.y * TILE + TILE - 2;
    const dx = targetX - agent.root.x;
    const dy = targetY - agent.root.y;
    const distance = Math.hypot(dx, dy);
    const travel = WALK_SPEED * delta;

    if (distance <= travel) {
      agent.root.position.set(targetX, targetY);
      agent.tile = next;
      agent.path.shift();
      if (agent.path.length === 0) {
        const desk = deskFor(agent.role);
        agent.facing = desk.facing;
        agent.state = "thinking";
        agent.pose = "sit";
        agent.status.text = "…";
        agent.status.style.fill = 0x9fb3c8;
        this.facingTexture(agent);
        this.updateDeskScreen(agent.role);
      }
      return;
    }

    agent.root.x += (dx / distance) * travel;
    agent.root.y += (dy / distance) * travel;
    if (Math.abs(dx) > Math.abs(dy)) {
      agent.facing = dx > 0 ? "right" : "left";
    } else {
      agent.facing = dy > 0 ? "down" : "up";
    }
  }

  // --- static art -----------------------------------------------------------

  private drawStatic(): void {
    const stage = this.app.stage;
    const floor = new Graphics();
    stage.addChild(floor);

    floor.rect(0, 0, WORLD_WIDTH, WORLD_HEIGHT).fill(0x0b0f14);

    for (let y = 1; y < ROWS - 1; y++) {
      for (let x = 1; x < COLS - 1; x++) {
        const zone = zoneAt(x, y);
        if (!zone) continue;
        const checker = (x + y) % 2 === 0;
        floor
          .rect(x * TILE, y * TILE, TILE, TILE)
          .fill(checker ? zone.floor : zone.floorAlt)
          .rect(x * TILE, y * TILE, TILE, 1)
          .fill({ color: 0xffffff, alpha: 0.02 });
      }
    }

    // Walls.
    const walls = new Graphics();
    stage.addChild(walls);
    walls.rect(0, 0, WORLD_WIDTH, TILE).fill(0x11161d);
    walls.rect(0, WORLD_HEIGHT - TILE, WORLD_WIDTH, TILE).fill(0x11161d);
    walls.rect(0, 0, TILE, WORLD_HEIGHT).fill(0x11161d);
    walls.rect(WORLD_WIDTH - TILE, 0, TILE, WORLD_HEIGHT).fill(0x11161d);
    for (let x = 0; x < COLS; x++) {
      walls.rect(x * TILE, TILE - 4, TILE, 2).fill(0x2a3542);
      walls.rect(x * TILE, WORLD_HEIGHT - TILE, TILE, 2).fill(0x2a3542);
    }

    // Zone labels.
    for (const zone of ZONES) {
      const label = new Text({
        text: zone.label,
        style: {
          fontFamily: "ui-monospace, monospace",
          fontSize: 9,
          fill: 0x5b6b7a,
          letterSpacing: 1.5,
        },
      });
      label.position.set(zone.x * TILE + 6, zone.y * TILE + 5);
      stage.addChild(label);
    }

    this.drawProps(stage);
    this.drawDesks(stage);

    // Entrance mat.
    const mat = new Graphics();
    mat
      .roundRect(ENTRANCE.x * TILE + 2, ENTRANCE.y * TILE + 8, TILE - 4, TILE - 12, 3)
      .fill(0x24313d)
      .stroke({ color: 0x33475a, width: 1 });
    stage.addChild(mat);
  }

  private drawDesks(stage: Container): void {
    for (const desk of DESKS) {
      const x = desk.tile.x * TILE;
      const y = desk.tile.y * TILE;
      const accent = ROLE_COLORS[desk.role] ?? 0xffffff;
      const deskArt = new Graphics();
      deskArt
        .rect(x + 2, y + 12, 28, 12)
        .fill(0x3a2c22)
        .rect(x + 2, y + 12, 28, 2)
        .fill(0x5a4434)
        .rect(x + 4, y + 24, 3, 6)
        .fill(0x241a14)
        .rect(x + 25, y + 24, 3, 6)
        .fill(0x241a14)
        .rect(x + 8, y + 7, 16, 10)
        .fill(0x1a222c)
        .rect(x + 9, y + 8, 14, 8)
        .fill(0x0d161d)
        .rect(x + 13, y + 17, 6, 2)
        .fill(0x2a3542)
        .rect(x + 20, y + 18, 6, 3)
        .fill(0x2a3542);
      deskArt.zIndex = y + TILE * 0.9;
      stage.addChild(deskArt);

      const screen = new Graphics();
      screen.position.set(x + 9, y + 8);
      screen.rect(0, 0, 14, 9).fill(accent);
      screen.rect(1, 1, 12, 7).fill(0x0d161d);
      screen.zIndex = y + TILE * 0.9 + 1;
      stage.addChild(screen);
      this.deskScreens.set(desk.role, screen);

      // A tiny plant is cheaper than a chair and reads better at this scale.
      const chair = new Graphics();
      chair
        .roundRect(x + 10, y + 27, 12, 5, 2)
        .fill(0x2a3542)
        .rect(x + 15, y + 32, 2, 4)
        .fill(0x1c252e);
      chair.zIndex = y + TILE * 0.95;
      stage.addChild(chair);
    }
  }

  private drawProps(stage: Container): void {
    for (const prop of PROPS) {
      const x = prop.x * TILE;
      const y = prop.y * TILE;
      const art = new Graphics();
      switch (prop.kind) {
        case "table":
          art
            .rect(x + 4, y + 20, (prop.w ?? 1) * TILE - 8, TILE - 24)
            .fill(0x4a382c)
            .rect(x + 4, y + 20, (prop.w ?? 1) * TILE - 8, 3)
            .fill(0x6a5140)
            .rect(x + 10, y + 12, 10, 8)
            .fill(0xe8e2d4)
            .rect(x + 24, y + 12, 8, 8)
            .fill(0xcfc8b8);
          break;
        case "coffee":
          art
            .rect(x + 4, y + 12, 24, 16)
            .fill(0x3a3a40)
            .rect(x + 6, y + 14, 8, 6)
            .fill(0x1c1c22)
            .rect(x + 18, y + 20, 4, 5)
            .fill(0xd05a4a)
            .rect(x + 22, y + 20, 2, 2)
            .fill(0xd05a4a);
          break;
        case "rack":
          art
            .rect(x + 6, y + 6, 20, 24)
            .fill(0x222a33)
            .rect(x + 8, y + 8, 16, 2)
            .fill(0x3a4652)
            .rect(x + 8, y + 13, 4, 2)
            .fill(0x6fd7a0)
            .rect(x + 8, y + 18, 4, 2)
            .fill(0xffd75e)
            .rect(x + 8, y + 23, 4, 2)
            .fill(0x7fb2ff);
          break;
        case "plant":
          art
            .rect(x + 11, y + 22, 10, 8)
            .fill(0x5a3a28)
            .rect(x + 8, y + 10, 16, 14)
            .fill(0x2f6b45)
            .rect(x + 12, y + 6, 8, 10)
            .fill(0x3f8a5a);
          break;
        case "couch":
          art
            .rect(x + 2, y + 14, (prop.w ?? 1) * TILE - 4, 14)
            .fill(0x36414d)
            .rect(x + 4, y + 10, (prop.w ?? 1) * TILE - 8, 8)
            .fill(0x44525f);
          break;
      }
      art.zIndex = y + TILE * 0.9;
      stage.addChild(art);
    }
  }
}

function roleFromAgentId(agentId: string): string {
  const prefix = agentId.split("_")[0];
  return prefix && prefix.length > 0 ? prefix : "backend";
}

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

export function walkableTileCount(): number {
  let count = 0;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) if (isWalkable(x, y)) count += 1;
  }
  return count;
}

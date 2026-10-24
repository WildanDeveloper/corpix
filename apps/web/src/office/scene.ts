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
  MEETING_SPOTS,
  SMOKE_SPOT,
  WATER_SPOT,
  WHITEBOARD_SPOT,
  WINDOW_SPOT,
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
import {
  applyActivity,
  destinationFor,
  driftNeeds,
  hashString,
  moodColor,
  moodWord,
  mulberry32,
  planIdle,
  seededNeeds,
  type IdleActivity,
  type NeedState,
} from "./behavior";
import { frameTexture, type Facing, type Pose } from "./sprites";

type WalkPurpose =
  | "desk"
  | "home"
  | "coffee"
  | "water"
  | "smoke"
  | "whiteboard"
  | "window"
  | "meeting"
  | "wander"
  | "chat";

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
  toolDetail?: string;
  idleAfter: number;
  /** Where the agent belongs when nothing is assigned. */
  home: Point;
  /** Why the current path exists, so arrival does the right thing. */
  purpose: WalkPurpose;
  /** Current line shown above the head. */
  activity: string;
  idleFor: number;
  idleRound: number;
  lastIdle: IdleActivity | null;
  behaviour: IdleActivity | null;
  behaviourTimer: number;
  needs: NeedState;
  recentActivities: IdleActivity[];
  chatPartner: string | null;
  chatNextAt: number;
  smokeTimer: number;
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
  /** Real agent ids that map onto a canonical body (the Boss has two ids). */
  private readonly aliases = new Map<string, string>();
  private readonly deskScreens = new Map<string, Graphics>();
  private readonly roleNames = new Map<string, string>();
  private readonly puffs: Array<{ gfx: Graphics; life: number; max: number; vy: number }> = [];
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
  applyEvent(event: SceneEvent, options: { instant?: boolean } = {}): void {
    if (!this.ready || this.destroyed) return;
    const instant = options.instant ?? false;
    const payload = event.payload as Record<string, unknown>;
    switch (event.type) {
      case "run.started":
        this.reset();
        break;
      case "plan.created": {
        // The Boss never gets a task assignment, so give it a body here.
        const boss = this.ensure("boss", "boss");
        if (boss) this.sendToDesk(boss, instant);
        break;
      }
      case "task.assigned":
      case "task.started": {
        const agent = this.ensure(
          String(payload.agentId ?? ""),
          String(payload.role ?? "backend"),
        );
        if (!agent) break;
        this.sendToDesk(agent, instant);
        if (typeof payload.title === "string") this.say(agent, payload.title, 2.2);
        break;
      }
      case "agent.state_changed": {
        const agent = this.ensure(
          String(payload.agentId ?? ""),
          roleFromAgentId(String(payload.agentId ?? "")),
          instant,
        );
        if (!agent) break;
        this.setState(agent, payload.to as AgentState, payload.tool as string | undefined);
        break;
      }
      case "tool.called": {
        const agent = this.agents.get(String(payload.agentId ?? ""));
        if (!agent) break;
        agent.tool = String(payload.tool ?? "");
        agent.toolDetail = describeTool(agent.tool, payload.input);
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
          this.sendToDesk(qa, instant);
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
    this.aliases.clear();
    for (const screen of this.deskScreens.values()) {
      screen.clear().rect(0, 0, 14, 8).fill(0x1a2630);
    }
  }

  /** Snapshot for `?debug=1` and for screenshot tests. */
  debugAgents(): Array<{
    id: string;
    role: string;
    state: AgentState;
    activity: string;
    mood: string;
    tile: Point;
    path: number;
    needs: NeedState;
  }> {
    return [...this.agents.entries()].map(([id, agent]) => ({
      id,
      role: agent.role,
      state: agent.state,
      activity: agent.activity,
      mood: moodWord(agent.needs),
      tile: { ...agent.tile },
      path: agent.path.length,
      needs: { ...agent.needs },
    }));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.app.destroy(true, { children: true });
    this.host.replaceChildren();
  }

  // --- agents ---------------------------------------------------------------

  private ensure(agentId: string, role: string, instant = false): OfficeAgent | null {
    if (!agentId) return null;
    // There can be several Boss agent ids (planning, retries); they all map to
    // one body so the office never shows two CEOs.
    const canonical = role === "boss" ? "boss" : (this.aliases.get(agentId) ?? agentId);
    const existing = this.agents.get(canonical);
    if (existing) {
      if (agentId !== canonical) this.aliases.set(agentId, canonical);
      return existing;
    }

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
    label.position.set(0, -46);
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
    status.position.set(0, -58);
    root.addChild(status);

    const start = nearestWalkable(ENTRANCE);
    root.position.set(start.x * TILE + TILE / 2, start.y * TILE + TILE - 2);
    root.zIndex = root.position.y;
    this.app.stage.addChild(root);

    const desk = deskFor(role);
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
      home: desk.stand,
      purpose: "desk",
      activity: "waiting for a task",
      idleFor: 0,
      idleRound: 0,
      lastIdle: null,
      behaviour: null,
      behaviourTimer: 0,
      needs: seededNeeds(canonical),
      recentActivities: [],
      chatPartner: null,
      chatNextAt: 0,
      smokeTimer: 0,
    };
    this.agents.set(canonical, agent);
    this.activity(agent, "waiting for a task", 0x9fb3c8);
    this.facingTexture(agent);
    this.sendToDesk(agent, instant);
    return agent;
  }

  private sendToDesk(agent: OfficeAgent, instant = false): void {
    const desk = deskFor(agent.role);
    const target = this.reserveStand(agent, desk.stand);
    agent.home = target;
    agent.behaviour = null;
    agent.behaviourTimer = 0;
    this.walkTo(agent, target, desk.facing, instant, "desk");
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

  private walkTo(
    agent: OfficeAgent,
    target: Point,
    facing?: Facing,
    instant = false,
    purpose: WalkPurpose = "desk",
  ): void {
    agent.purpose = purpose;
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
    if (this.reducedMotion || instant) {
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
    agent.behaviour = null;
    agent.behaviourTimer = 0;
    agent.idleFor = 0;

    switch (state) {
      case "thinking":
        agent.pose = "idle";
        this.activity(agent, "thinking…", 0x9fb3c8);
        break;
      case "working":
        agent.pose = "type";
        this.activity(agent, describeWork(agent), 0xffd75e);
        break;
      case "blocked":
        agent.pose = "idle";
        this.activity(agent, "needs approval", 0xffab6b);
        break;
      case "done":
        agent.pose = "idle";
        this.activity(agent, "done", 0x6fd7a0);
        agent.idleAfter = 2.5;
        break;
      case "error":
        agent.pose = "idle";
        this.activity(agent, "that went wrong", 0xff6b6b);
        agent.idleAfter = 3;
        break;
      default:
        agent.pose = "sit";
        this.activity(agent, "waiting for a task", 0x9fb3c8);
        break;
    }
    agent.label.style.fill = moodColor(state);
    this.facingTexture(agent);
    this.updateDeskScreen(agent.role);
  }

  /**
   * Set the persistent "what am I doing" line above the agent's head, plus the
   * colour that reads at a glance.
   */
  private activity(agent: OfficeAgent, text: string, color: number): void {
    agent.activity = text;
    agent.status.text = text.length > 34 ? `${text.slice(0, 31)}…` : text;
    agent.status.style.fill = color;
  }

  /**
   * Idle behaviour: when an agent has no task it still has a life. Every few
   * seconds it picks a small activity, occasionally walks to the coffee machine
   * or wanders, and says something short. Deterministic per agent so screenshots
   * stay reproducible.
   */
  private driveIdle(agent: OfficeAgent, delta: number): void {
    // Needs always drift; work raises stress and drains focus.
    const working = agent.state === "working" || agent.state === "thinking";
    agent.needs = driftNeeds(agent.needs, delta, working);

    if (agent.state !== "idle" || agent.path.length > 0) return;

    agent.idleFor += delta;

    // Smoking is a timed state: stand outside, puff, come back.
    if (agent.smokeTimer > 0) {
      agent.smokeTimer -= delta;
      if (agent.smokeTimer <= 0) {
        agent.smokeTimer = 0;
        this.walkTo(agent, agent.home, undefined, false, "home");
        this.activity(agent, "heading back", 0x9fb3c8);
      }
      return;
    }

    // A paired conversation: both agents stay put and trade a line or two.
    if (agent.chatPartner) {
      if (agent.behaviourTimer > 0) {
        agent.behaviourTimer -= delta;
        if (agent.behaviourTimer <= 0) this.endPairChat(agent);
        return;
      }
    }

    if (agent.behaviourTimer > 0) {
      agent.behaviourTimer -= delta;
      if (agent.behaviourTimer <= 0) {
        const finished = agent.behaviour;
        agent.behaviour = null;
        if (finished) {
          agent.needs = applyActivity(agent.needs, finished);
          this.rememberActivity(agent, finished);
        }
        if (agent.purpose === "home" || agent.purpose === "desk") {
          agent.pose = "sit";
          this.facingTexture(agent);
          this.activity(agent, "at the desk", 0x9fb3c8);
        } else {
          this.walkTo(agent, agent.home, undefined, false, "home");
          this.activity(agent, "heading back", 0x9fb3c8);
        }
      }
      return;
    }

    // Wait a moment after arriving so movement reads clearly.
    if (agent.idleFor < 2.5) return;

    agent.idleRound += 1;
    const round = agent.idleRound;
    const plan = planIdle(agent.id, agent.needs, round, agent.recentActivities, {
      allowSocial: this.socialAvailable(agent),
    });
    agent.behaviour = plan.activity;
    agent.behaviourTimer = plan.duration;
    agent.idleFor = 0;

    const random = mulberry32(hashString(`${agent.id}:${round}:dest`));

    // Paired chat: find a colleague who is also free and close enough.
    if (plan.activity === "pair-chat" || plan.activity === "chat") {
      const partner = this.findChatPartner(agent);
      if (partner) {
        this.startPairChat(agent, partner);
        return;
      }
    }

    const destination = destinationFor(
      plan.place,
      agent.home,
      {
        coffee: BREAK_SPOT,
        water: WATER_SPOT,
        smoke: SMOKE_SPOT,
        whiteboard: WHITEBOARD_SPOT,
        window: WINDOW_SPOT,
        meeting: MEETING_SPOTS,
      },
      random,
    );

    if (destination && isWalkable(destination.x, destination.y)) {
      const purpose: WalkPurpose =
        plan.place === "meeting"
          ? "meeting"
          : plan.place === "wander"
            ? "wander"
            : (plan.place as WalkPurpose);
      this.walkTo(agent, destination, undefined, false, purpose);
      this.activity(agent, plan.label, 0x9fb3c8);
      if (plan.line) this.say(agent, plan.line, plan.duration);
      return;
    }

    // Act in place: face a sensible direction and show the label.
    agent.pose = plan.activity === "desk-tidy" || plan.activity === "fidget" ? "idle" : "sit";
    this.facingTexture(agent);
    this.activity(agent, plan.label, 0x9fb3c8);
    if (plan.line) this.say(agent, plan.line, plan.duration);
  }

  private rememberActivity(agent: OfficeAgent, activity: IdleActivity): void {
    agent.recentActivities = [activity, ...agent.recentActivities].slice(0, 3);
  }

  /** Social activities need at least one other idle agent. */
  private socialAvailable(agent: OfficeAgent): boolean {
    return [...this.agents.values()].some(
      (other) => other.id !== agent.id && other.state === "idle" && other.path.length === 0 && !other.chatPartner,
    );
  }

  private findChatPartner(agent: OfficeAgent): OfficeAgent | null {
    const candidates = [...this.agents.values()].filter(
      (other) =>
        other.id !== agent.id &&
        other.state === "idle" &&
        other.path.length === 0 &&
        !other.chatPartner &&
        Math.abs(other.tile.x - agent.tile.x) + Math.abs(other.tile.y - agent.tile.y) <= 9,
    );
    if (candidates.length === 0) return null;
    const random = mulberry32(hashString(`${agent.id}:${agent.idleRound}:partner`));
    return candidates[Math.floor(random() * candidates.length)] ?? null;
  }

  /**
   * Two agents turn towards each other and trade lines. The pair shares one
   * timer, so both stop together and both get the social benefit.
   */
  private startPairChat(agent: OfficeAgent, partner: OfficeAgent): void {
    const duration = 5 + Math.random() * 3;
    agent.chatPartner = partner.id;
    partner.chatPartner = agent.id;
    agent.behaviour = "pair-chat";
    partner.behaviour = "pair-chat";
    agent.behaviourTimer = duration;
    partner.behaviourTimer = duration;

    agent.facing = partner.tile.x >= agent.tile.x ? "right" : "left";
    partner.facing = agent.tile.x >= partner.tile.x ? "right" : "left";
    agent.pose = "idle";
    partner.pose = "idle";
    this.facingTexture(agent);
    this.facingTexture(partner);

    this.activity(agent, `talking to ${partner.name}`, 0x9fb3c8);
    this.activity(partner, `talking to ${agent.name}`, 0x9fb3c8);

    const lines = [
      "did you see the diff?",
      "how do you mock that?",
      "nice, that works",
      "want a second pair of eyes?",
      "coffee later?",
    ];
    const random = mulberry32(hashString(`${agent.id}:${partner.id}:chat`));
    this.say(agent, lines[Math.floor(random() * lines.length)] ?? "hey", duration);
    this.say(partner, lines[Math.floor(random() * lines.length)] ?? "sure", duration);
  }

  private endPairChat(agent: OfficeAgent): void {
    const partnerId = agent.chatPartner;
    agent.chatPartner = null;
    agent.behaviour = null;
    agent.behaviourTimer = 0;
    agent.needs = applyActivity(agent.needs, "pair-chat");
    this.rememberActivity(agent, "pair-chat");
    this.activity(agent, "back to it", 0x9fb3c8);

    const partner = partnerId ? this.agents.get(partnerId) : null;
    if (partner) {
      partner.chatPartner = null;
      partner.behaviour = null;
      partner.behaviourTimer = 0;
      partner.needs = applyActivity(partner.needs, "pair-chat");
      this.rememberActivity(partner, "pair-chat");
      this.activity(partner, "back to it", 0x9fb3c8);
    }
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
    bubble.position.set(-width / 2, -86 - height);
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

    for (let index = this.puffs.length - 1; index >= 0; index--) {
      const puff = this.puffs[index];
      if (!puff) continue;
      puff.life -= delta;
      puff.gfx.y += puff.vy * delta;
      puff.gfx.alpha = Math.max(0, puff.life / puff.max);
      if (puff.life <= 0) {
        this.app.stage.removeChild(puff.gfx);
        puff.gfx.destroy();
        this.puffs.splice(index, 1);
      }
    }

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
        this.onArrive(agent);
      }
      this.driveIdle(agent, delta);
      if (agent.smokeTimer > 0) this.spawnSmoke(agent, delta);

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

  private spawnSmoke(agent: OfficeAgent, delta: number): void {
    agent.smokeTimer = Math.max(0, agent.smokeTimer - delta);
    this.smokeClock += delta;
    if (this.smokeClock < 0.7) return;
    this.smokeClock = 0;
    const puff = new Graphics();
    puff.circle(0, 0, 2 + Math.random() * 1.5).fill({ color: 0xd8d8d8, alpha: 0.7 });
    puff.position.set(agent.root.x + 7, agent.root.y - 36);
    puff.zIndex = 9999;
    this.app.stage.addChild(puff);
    this.puffs.push({ gfx: puff, life: 1.6, max: 1.6, vy: -14 });
  }

  private smokeClock = 0;

  /** Arrival behaviour depends on why the agent was walking. */
  private onArrive(agent: OfficeAgent): void {
    switch (agent.purpose) {
      case "coffee":
        agent.state = "idle";
        agent.pose = "idle";
        this.facingTexture(agent);
        this.activity(agent, "at the coffee machine", 0x9fb3c8);
        return;
      case "chat":
        agent.state = "idle";
        agent.pose = "idle";
        this.facingTexture(agent);
        this.activity(agent, "looking for someone", 0x9fb3c8);
        return;
      case "water":
        agent.state = "idle";
        agent.pose = "idle";
        this.facingTexture(agent);
        this.activity(agent, "at the water cooler", 0x9fb3c8);
        return;
      case "smoke":
        agent.state = "idle";
        agent.pose = "idle";
        agent.facing = "up";
        agent.smokeTimer = 5 + (hashString(agent.id) % 4);
        this.facingTexture(agent);
        this.activity(agent, "on a smoke break", 0x9fb3c8);
        this.say(agent, "back in five", 3);
        return;
      case "whiteboard":
        agent.state = "idle";
        agent.pose = "idle";
        this.facingTexture(agent);
        this.activity(agent, "at the whiteboard", 0x9fb3c8);
        return;
      case "window":
        agent.state = "idle";
        agent.pose = "idle";
        this.facingTexture(agent);
        this.activity(agent, "staring out the window", 0x9fb3c8);
        return;
      case "meeting":
        agent.state = "idle";
        agent.pose = "sit";
        this.facingTexture(agent);
        this.activity(agent, "in the meeting room", 0x9fb3c8);
        return;
      case "chat": {
        agent.state = "idle";
        agent.pose = "idle";
        const partner = agent.chatPartner ? this.agents.get(agent.chatPartner) : null;
        if (partner) {
          agent.facing = partner.tile.x >= agent.tile.x ? "right" : "left";
          this.facingTexture(agent);
          this.activity(agent, `talking to ${partner.name}`, 0x9fb3c8);
        } else {
          this.facingTexture(agent);
        }
        return;
      }
      case "wander":
        agent.state = "idle";
        agent.pose = "idle";
        this.facingTexture(agent);
        this.activity(agent, "taking a lap", 0x9fb3c8);
        return;
      case "home":
        agent.state = "idle";
        agent.pose = "sit";
        this.facingTexture(agent);
        this.activity(agent, "waiting for a task", 0x9fb3c8);
        return;
      default: {
        // Back at the desk: face the monitor. Actual work arrives as events.
        const desk = deskFor(agent.role);
        agent.facing = desk.facing;
        agent.state = "idle";
        agent.pose = "sit";
        this.facingTexture(agent);
        this.activity(agent, "at the desk", 0x9fb3c8);
        this.updateDeskScreen(agent.role);
        return;
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
        this.onArrive(agent);
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
        case "water":
          art
            .rect(x + 10, y + 14, 12, 18)
            .fill(0x2f3d4a)
            .rect(x + 12, y + 16, 8, 8)
            .fill(0x7fc8e8)
            .rect(x + 13, y + 26, 6, 3)
            .fill(0x1c252e)
            .rect(x + 14, y + 8, 4, 6)
            .fill(0x8fd8f0);
          break;
        case "ashtray":
          art
            .rect(x + 8, y + 20, 16, 8)
            .fill(0x3a3a40)
            .rect(x + 10, y + 18, 2, 4)
            .fill(0xe8e2d4)
            .rect(x + 16, y + 17, 2, 5)
            .fill(0xe8e2d4)
            .rect(x + 10, y + 16, 2, 2)
            .fill(0xff8a5c)
            .rect(x + 16, y + 15, 2, 2)
            .fill(0xff8a5c);
          break;
        case "whiteboard":
          art
            .rect(x + 2, y + 8, (prop.w ?? 1) * TILE - 4, 20)
            .fill(0xe8edf2)
            .rect(x + 2, y + 8, (prop.w ?? 1) * TILE - 4, 2)
            .fill(0xb8c4d0)
            .rect(x + 8, y + 14, 26, 1)
            .fill(0x3f7fd0)
            .rect(x + 8, y + 18, 18, 1)
            .fill(0x3f9e6b)
            .rect(x + 8, y + 22, 22, 1)
            .fill(0xd07a3f)
            .rect(x + 30, y + 24, 4, 2)
            .fill(0x9b5fc0);
          break;
        case "window":
          art
            .rect(x + 2, y + 6, (prop.w ?? 1) * TILE - 4, 22)
            .fill(0x1b2b3a)
            .rect(x + 4, y + 8, (prop.w ?? 1) * TILE - 8, 18)
            .fill(0x24405a)
            .rect(x + 4, y + 12, 10, 1)
            .fill(0x2f5573)
            .rect(x + 20, y + 16, 12, 1)
            .fill(0x2f5573)
            .rect(x + 4, y + 20, 8, 1)
            .fill(0x2f5573)
            .circle(x + 26, y + 12, 3)
            .fill(0xffd75e);
          break;
      }
      art.zIndex = y + TILE * 0.9;
      stage.addChild(art);
    }
  }
}

function describeWork(agent: OfficeAgent): string {
  const detail = agent.toolDetail?.trim();
  switch (agent.tool) {
    case "run_command":
      return detail ? `running ${detail}` : "running a command";
    case "write_file":
    case "edit_file":
      return detail ? `writing ${detail}` : "writing code";
    case "read_file":
      return detail ? `reading ${detail}` : "reading";
    case "search_files":
      return detail ? `searching for ${detail}` : "searching";
    case "list_files":
      return "looking around the repo";
    case "message_agent":
      return detail ? `messaging ${detail}` : "messaging the team";
    case "submit_plan":
      return "writing the plan";
    case "submit_report":
      return "writing the report";
    default:
      return agent.tool ? `using ${agent.tool}` : "working";
  }
}

function describeTool(tool: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  const path = typeof value.path === "string" ? value.path : undefined;
  const command = typeof value.command === "string" ? value.command : undefined;
  const to = typeof value.to === "string" ? value.to : undefined;
  const pattern = typeof value.pattern === "string" ? value.pattern : undefined;
  if (tool === "run_command" && command) {
    const args = Array.isArray(value.args) ? value.args.join(" ") : "";
    return `${command} ${args}`.trim().slice(0, 28);
  }
  if ((tool === "write_file" || tool === "edit_file" || tool === "read_file") && path) {
    return path.split("/").slice(-2).join("/");
  }
  if (tool === "search_files" && pattern) return `"${pattern}"`;
  if (tool === "message_agent" && to) return to;
  return undefined;
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

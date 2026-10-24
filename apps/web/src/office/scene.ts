import {
  Application,
  Container,
  Graphics,
  Rectangle,
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
import { SpeechQueue, lineDuration } from "./speech";
import { hashString, moodColor, moodTint, mulberry32 } from "./behavior";
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
  /** What this person is like right now, decided by the model. */
  mind: MindView;
  /** Seconds left before the current decision goes stale. */
  mindTimer: number;
  inConversation: boolean;
  hovered: boolean;
  smokeTimer: number;
}

/** The part of an agent's inner life the office can see. */
export interface MindView {
  mood: { valence: number; arousal: number; label: string };
  thought: string;
  doing: string;
  /** Last thing this person said out loud. */
  said: string;
  memories: string[];
}

interface ActiveConversation {
  id: string;
  participants: string[];
  /** Lines that arrived from the server, in order. */
  lines: Array<{ agentId: string; text: string }>;
  index: number;
  nextAt: number;
  ended: boolean;
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
  private readonly speech = new SpeechQueue(0.6);
  private conversation: ActiveConversation | null = null;
  private conversationCooldown = 0;
  private context: { goal: string; tasks: string[]; files: string[] } = {
    goal: "",
    tasks: [],
    files: [],
  };
  private activeBubbleAgent: string | null = null;
  /** Per-event counters, only used by `?debug=1` to diagnose a silent office. */
  private readonly counts: Record<string, number> = {};
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
    this.counts[event.type] = (this.counts[event.type] ?? 0) + 1;
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
        const agent = this.agentFor(String(payload.agentId ?? ""));
        if (!agent) break;
        agent.tool = String(payload.tool ?? "");
        agent.toolDetail = describeTool(agent.tool, payload.input);
        this.setState(agent, "working", agent.tool);
        break;
      }
      case "message.sent": {
        const agent = this.agentFor(String(payload.from ?? ""));
        if (agent && typeof payload.text === "string") this.say(agent, payload.text, 3.5);
        break;
      }
      case "task.completed": {
        const agent = this.agentFor(String(payload.agentId ?? ""));
        if (!agent) break;
        this.setState(agent, "done");
        if (typeof payload.summary === "string") this.say(agent, payload.summary, 3);
        break;
      }
      case "task.failed": {
        const agent = this.agentFor(String(payload.agentId ?? ""));
        if (agent) this.setState(agent, "error");
        break;
      }
      case "approval.requested": {
        const agent = this.agentFor(String(payload.agentId ?? ""));
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
      case "mind.decided": {
        const agent = this.ensure(
          String(payload.agentId ?? ""),
          String(payload.role ?? "backend"),
          instant,
        );
        if (agent) {
          if (instant) this.sendToDesk(agent, true);
          this.applyDecision(agent, { ...payload, replay: instant });
        }
        break;
      }
      case "mind.said": {
        const agent = this.agentFor(String(payload.agentId ?? ""));
        if (!agent || typeof payload.text !== "string") break;
        agent.mind.said = payload.text;
        // Old chatter must not be replayed as bubbles on page load.
        if (instant) break;
        this.speech.enqueue({
          agentId: agent.id,
          text: payload.text,
          priority: 20,
          duration: lineDuration(payload.text),
        });
        break;
      }
      case "mind.conversation.started":
        // Replaying a finished conversation would trap the pair at the table.
        if (!instant) this.beginConversation(payload);
        break;
      case "mind.conversation.line":
        if (!instant) this.pushConversationLine(payload);
        break;
      case "mind.conversation.ended":
        if (!instant) this.endConversation();
        break;
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

  /** Context used to make conversations refer to the real run. */
  setContext(context: { goal?: string; tasks?: string[]; files?: string[] }): void {
    this.context = {
      goal: context.goal ?? this.context.goal,
      tasks: context.tasks ?? this.context.tasks,
      files: context.files ?? this.context.files,
    };
  }

  reset(): void {
    for (const agent of this.agents.values()) agent.root.destroy({ children: true });
    this.agents.clear();
    this.aliases.clear();
    this.conversation = null;
    this.speech.clear();
    this.activeBubbleAgent = null;
    for (const screen of this.deskScreens.values()) {
      screen.clear().rect(0, 0, 14, 8).fill(0x1a2630);
    }
  }

  /** Snapshot for `?debug=1` and for screenshot tests. */
  debugAgents(): Array<{
    id: string;
    name: string;
    role: string;
    state: AgentState;
    activity: string;
    tile: Point;
    path: number;
    mood: MindView["mood"];
    thought: string;
    doing: string;
    said: string;
    memories: string[];
  }> {
    return [...this.agents.entries()].map(([id, agent]) => ({
      id,
      name: agent.name,
      role: agent.role,
      state: agent.state,
      activity: agent.activity,
      mood: { ...agent.mind.mood },
      thought: agent.mind.thought,
      doing: agent.mind.doing,
      said: agent.mind.said,
      memories: [...agent.mind.memories],
      tile: { ...agent.tile },
      path: agent.path.length,
    }));
  }

  /** Debug snapshot for `?debug=1` and screenshot tests. */
  debugState(): {
    conversation: { id: string; index: number; participants: string[] } | null;
    bubbles: string[];
    pendingSpeech: number;
    counts: Record<string, number>;
  } {
    return {
      conversation: this.conversation
        ? {
            id: this.conversation.id,
            index: this.conversation.index,
            participants: [...this.conversation.participants],
          }
        : null,
      bubbles: [...this.agents.values()].filter((agent) => agent.bubble).map((agent) => agent.id),
      pendingSpeech: this.speech.pending,
      counts: {
        ...this.counts,
        ...Object.fromEntries(Object.entries(this.speech.stats).map(([k, v]) => [`speech.${k}`, v])),
        "speech.clock": Math.round(this.speech.debug.clock * 10) / 10,
        "speech.until": Math.round(this.speech.debug.until * 10) / 10,
      },
    };
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
    // A role has exactly one body. Runtime agents get ids like `backend_3fmfed`
    // while the mind speaks as `backend`; keying by role is what stops one
    // person from appearing twice in the same office.
    const canonical = this.aliases.get(agentId) ?? role;
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
    // Alternate the name height by desk order, not by hash: two adjacent desks
    // must never land on the same parity or their names touch.
    const deskIndex = DESKS.findIndex((desk) => desk.role === role);
    const stagger = (deskIndex >= 0 ? deskIndex : 0) % 2 === 0 ? 0 : 10;
    label.position.set(0, -54 - stagger);
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
    // Alternate the status line height per role, so two people standing next to
    // each other never print their labels on top of one another.
    status.position.set(0, -68 - stagger - 11);
    root.addChild(status);

    const start = nearestWalkable(ENTRANCE);
    root.position.set(start.x * TILE + TILE / 2, start.y * TILE + TILE - 2);
    root.zIndex = root.position.y;
    this.app.stage.addChild(root);

    const desk = deskFor(role);
    const agent: OfficeAgent = {
      id: canonical,
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
      mind: {
        mood: { valence: 0, arousal: 0, label: "neutral" },
        thought: "",
        doing: "",
        said: "",
        memories: [],
      },
      mindTimer: 0,
      inConversation: false,
      hovered: false,
      smokeTimer: 0,
    };
    root.eventMode = "static";
    root.cursor = "pointer";
    root.hitArea = new Rectangle(-19, -50, 38, 50);
    root.on("pointerover", () => {
      agent.hovered = true;
      this.updateStatus(agent);
    });
    root.on("pointerout", () => {
      agent.hovered = false;
      this.updateStatus(agent);
    });

    this.agents.set(canonical, agent);
    this.activity(agent, "waiting for a task", 0x9fb3c8);
    this.facingTexture(agent);
    this.sendToDesk(agent, instant);
    return agent;
  }

  /** Resolve any id (runtime agent id, role id, alias) to the one body. */
  private agentFor(id: string): OfficeAgent | undefined {
    return (
      this.agents.get(id) ??
      this.agents.get(this.aliases.get(id) ?? "") ??
      this.agents.get(roleFromAgentId(id))
    );
  }

  private sendToDesk(agent: OfficeAgent, instant = false): void {
    const desk = deskFor(agent.role);
    const target = this.reserveStand(agent, desk.stand);
    agent.home = target;
    agent.mindTimer = 0;
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
    if (agent.inConversation && state !== "idle") {
      agent.inConversation = false;
      this.finishConversation();
    }
    agent.state = state;
    agent.tool = tool ?? agent.tool;
    agent.status.text = "";
    agent.status.style.fill = 0xffffff;
    agent.mindTimer = 0;

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
    agent.status.style.fill = color;
    this.updateStatus(agent);
  }

  /**
   * Idle agents at their desk show only their name: four identical "waiting for
   * a task" lines overlapping above neighbouring desks reads as noise. The
   * status returns for real work, conversations, and on hover.
   */
  private updateStatus(agent: OfficeAgent): void {
    const generic =
      agent.state === "idle" &&
      (agent.activity === "" || agent.activity === "waiting for a task" || agent.activity === "at the desk");
    const text = agent.activity;
    agent.status.text =
      generic && !agent.hovered ? "" : text.length > 32 ? `${text.slice(0, 29)}…` : text;
  }

  /**
   * Idle life.
   *
   * Nothing here decides what a person does. The server asks each agent's model
   * "what do you want to do now?" and streams back the answer; this method only
   * turns that answer into walking, sitting, smoking and talking. When a
   * decision is missing or stale the agent simply stays where it is, which is
   * also a legitimate thing for a person to do.
   */
  private driveIdle(agent: OfficeAgent, delta: number): void {
    if (agent.state !== "idle") return;
    if (agent.mindTimer > 0) agent.mindTimer -= delta;

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

    // Agents inside a conversation are driven by advanceConversation().
    if (agent.inConversation) return;
    if (agent.path.length > 0) return;

    // The decision expired: the person settles instead of looping a script.
    if (agent.mindTimer <= 0 && agent.mind.doing.length > 0) {
      agent.mind = { ...agent.mind, doing: "" };
      if (agent.purpose !== "desk" && agent.purpose !== "home") {
        this.walkTo(agent, agent.home, undefined, false, "home");
        this.activity(agent, "drifting back to the desk", 0x9fb3c8);
      } else {
        agent.pose = "sit";
        this.facingTexture(agent);
        this.activity(agent, "at the desk", 0x9fb3c8);
      }
    }
  }

  /** Apply one decision from an agent's own model. */
  private applyDecision(
    agent: OfficeAgent,
    decision: {
      /** True while replaying history: restore the mind, do not re-walk. */
      replay?: boolean;
      action?: unknown;
      place?: unknown;
      label?: unknown;
      say?: unknown;
      seconds?: unknown;
      thought?: unknown;
      mood?: unknown;
    },
  ): void {
    const action = typeof decision.action === "string" ? decision.action : "sit";
    const place = typeof decision.place === "string" ? decision.place : "desk";
    const label = typeof decision.label === "string" ? decision.label : action;
    const seconds =
      typeof decision.seconds === "number" && Number.isFinite(decision.seconds)
        ? Math.min(120, Math.max(3, decision.seconds))
        : 14;

    if (typeof decision.thought === "string") agent.mind.thought = decision.thought;
    if (decision.mood && typeof decision.mood === "object") {
      const mood = decision.mood as { valence?: unknown; arousal?: unknown; label?: unknown };
      agent.mind.mood = {
        valence: typeof mood.valence === "number" ? mood.valence : agent.mind.mood.valence,
        arousal: typeof mood.arousal === "number" ? mood.arousal : agent.mind.mood.arousal,
        label: typeof mood.label === "string" ? mood.label : agent.mind.mood.label,
      };
      agent.label.style.fill = moodTint(agent.mind.mood);
    }
    agent.mind.doing = label;
    agent.mindTimer = seconds;

    // Replaying a long history would send everyone to wherever they were hours
    // ago. On replay only the inner life is restored; bodies keep their desks.
    if (decision.replay === true) return;

    // A real task always wins over an idle decision.
    if (agent.state !== "idle") return;
    if (agent.inConversation) return;

    // "talk" is started by the server, which owns the other side's model too.
    // Do not walk anywhere yet: `mind.conversation.started` decides the table.
    // Sending every would-be talker to the meeting room is what piled six people
    // into one corner and printed their labels on top of each other.
    if (action === "talk" || action === "chat") {
      this.activity(agent, "", 0x9fb3c8);
      return;
    }

    const destination = this.placeFor(place, agent);
    if (destination) {
      this.walkTo(agent, destination.point, undefined, false, destination.purpose);
      this.activity(agent, label, 0x9fb3c8);
      if (place === "smoke") agent.smokeTimer = seconds;
      return;
    }

    // Stay in place: sit, type, stare, stretch.
    agent.pose = action === "stretch" || action === "pace" || action === "tidy" ? "idle" : "sit";
    this.facingTexture(agent);
    this.activity(agent, label, 0x9fb3c8);
  }

  /** Map a place name from the model onto a walkable tile. */
  private placeFor(
    place: string,
    agent: OfficeAgent,
  ): { point: Point; purpose: WalkPurpose } | null {
    const random = mulberry32(hashString(`${agent.id}:${place}:${Math.floor(agent.root.x)}`));
    const anchors: Record<string, Point> = {
      coffee: BREAK_SPOT,
      water: WATER_SPOT,
      smoke: SMOKE_SPOT,
      whiteboard: WHITEBOARD_SPOT,
      window: WINDOW_SPOT,
    };
    const fixed = anchors[place];
    if (fixed) {
      return {
        point: this.claimTile(fixed, agent),
        purpose:
          place === "coffee" || place === "water" || place === "smoke" || place === "whiteboard" || place === "window"
            ? (place as WalkPurpose)
            : "wander",
      };
    }
    if (place === "meeting") {
      // The room has a fixed number of seats. If they are taken, stay at the
      // desk instead of standing on somebody's head.
      const taken = new Set(
        [...this.agents.values()]
          .filter((other) => other.id !== agent.id)
          .map((other) => (other.path.length > 0 ? other.path[other.path.length - 1] : other.tile))
          .map((tile) => `${tile?.x},${tile?.y}`),
      );
      const free = MEETING_SPOTS.filter((spot) => !taken.has(`${spot.x},${spot.y}`));
      if (free.length === 0) return null;
      const spot = free[Math.floor(random() * free.length)];
      return spot ? { point: this.claimTile(spot, agent), purpose: "meeting" } : null;
    }
    if (place === "wander" || place === "server-room" || place === "break-room") {
      const angle = random() * Math.PI * 2;
      const radius = 2 + Math.floor(random() * 3);
      const point = {
        x: agent.home.x + Math.round(Math.cos(angle) * radius),
        y: agent.home.y + Math.round(Math.sin(angle) * radius),
      };
      return isWalkable(point.x, point.y) ? { point, purpose: "wander" } : null;
    }
    return null;
  }

  /**
   * Two people cannot stand on the same tile. If the spot is taken, take the
   * nearest free neighbour so a coffee break looks like a coffee break.
   */
  private claimTile(preferred: Point, agent: OfficeAgent): Point {
    const taken = new Set(
      [...this.agents.values()]
        .filter((other) => other.id !== agent.id)
        .map((other) => (other.path.length > 0 ? other.path[other.path.length - 1] : other.tile))
        .map((tile) => `${tile?.x},${tile?.y}`),
    );
    if (isWalkable(preferred.x, preferred.y) && !taken.has(`${preferred.x},${preferred.y}`)) {
      return preferred;
    }
    // Nearest free neighbour, closest first, so a queue at the coffee machine
    // forms a short line instead of a pile.
    const candidates: Array<{ point: Point; distance: number }> = [];
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dy === 0) continue;
        const point = { x: preferred.x + dx, y: preferred.y + dy };
        if (!isWalkable(point.x, point.y) || taken.has(`${point.x},${point.y}`)) continue;
        candidates.push({ point, distance: Math.abs(dx) + Math.abs(dy) });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    return candidates[0]?.point ?? nearestWalkable(preferred);
  }

  /** A conversation is started by the server, which generates both sides. */
  private beginConversation(payload: {
    conversationId?: unknown;
    participants?: unknown;
  }): void {
    const resolved = Array.isArray(payload.participants)
      ? payload.participants
          .map((entry) => {
            const row = entry as { agentId?: unknown; role?: unknown };
            const role = typeof row.role === "string" ? row.role : null;
            if (role) return this.ensure(role, role);
            if (typeof row.agentId === "string") {
              return this.agentFor(row.agentId) ?? this.ensure(row.agentId, roleFromAgentId(row.agentId));
            }
            return null;
          })
          .filter((agent): agent is OfficeAgent => Boolean(agent))
      : [];
    // One body per role, so a pair can never be the same person twice.
    const participants = [...new Map(resolved.map((agent) => [agent.id, agent])).values()];
    if (participants.length < 2) return;

    this.conversation = {
      id: typeof payload.conversationId === "string" ? payload.conversationId : `chat-${Date.now()}`,
      participants: participants.map((agent) => agent.id),
      lines: [],
      index: 0,
      nextAt: 0,
      ended: false,
    };
    // Conversations take priority, but queued chatter is not thrown away: the
    // scheduler simply serves the higher priority first. Erasing the queue here
    // is what made the office look mute while agents were constantly talking.

    const base = hashString(participants.map((agent) => agent.id).join(":")) % MEETING_SPOTS.length;
    participants.forEach((participant, index) => {
      const spot = MEETING_SPOTS[(base + index * 2) % MEETING_SPOTS.length];
      if (spot) this.walkTo(participant, spot, undefined, false, "chat");
      participant.inConversation = true;
      participant.mindTimer = 999;
      participant.pose = "idle";
      this.facingTexture(participant);
      this.activity(participant, "", 0x9fb3c8);
    });
  }

  /** A line arrived from the speaker's own model. Queue it, do not show it yet. */
  private pushConversationLine(payload: { agentId?: unknown; text?: unknown; name?: unknown }): void {
    const conversation = this.conversation;
    if (!conversation) return;
    if (typeof payload.agentId !== "string" || typeof payload.text !== "string") return;
    conversation.lines.push({ agentId: payload.agentId, text: payload.text });
  }

  private endConversation(): void {
    const conversation = this.conversation;
    if (!conversation) return;
    conversation.ended = true;
  }

  /** Advance the active conversation: queue the next line, then finish. */
  private advanceConversation(delta: number): void {
    const conversation = this.conversation;
    if (!conversation) return;

    const participants = conversation.participants
      .map((id) => this.agentFor(id))
      .filter((agent): agent is OfficeAgent => Boolean(agent));
    // Wait until the whole group is seated; a line while walking looks wrong.
    if (participants.length < 2 || participants.some((agent) => agent.path.length > 0)) return;

    conversation.nextAt -= delta;
    if (conversation.nextAt > 0) return;

    const line = conversation.lines[conversation.index];
    if (!line) {
      if (conversation.ended) this.finishConversation();
      else conversation.nextAt = 0.5;
      return;
    }
    const speaker = this.agentFor(line.agentId);
    if (!speaker) {
      conversation.index += 1;
      return;
    }

    this.speech.enqueue({
      agentId: speaker.id,
      text: line.text,
      priority: 60,
      duration: lineDuration(line.text),
      tag: "conversation",
    });
    speaker.mind.said = line.text;

    // Exactly one status line per conversation: the person speaking. Listeners
    // show nothing, so labels never overlap and the turn is obvious.
    for (const participant of participants) {
      this.activity(participant, participant.id === speaker.id ? "talking" : "", 0xffd75e);
    }

    conversation.index += 1;
    conversation.nextAt = lineDuration(line.text) + 0.6;
  }

  private finishConversation(): void {
    const conversation = this.conversation;
    this.conversation = null;
    if (!conversation) return;
    for (const id of conversation.participants) {
      const agent = this.agentFor(id);
      if (!agent) continue;
      agent.inConversation = false;
      agent.mindTimer = 0;
      this.activity(agent, "heading back", 0x9fb3c8);
      this.walkTo(agent, agent.home, undefined, false, "home");
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

  /** Queue a line; the global speech channel decides when it is shown. */
  private say(agent: OfficeAgent, raw: string, seconds: number, priority = 10): void {
    // While a conversation is on, the group owns the channel; solo chatter waits.
    if (this.conversation && priority < 50) return;
    this.speech.enqueue({
      agentId: agent.id,
      text: raw,
      priority,
      duration: Math.max(2.4, seconds),
    });
  }

  /** Draw the bubble immediately. Only the speech scheduler calls this. */
  private showBubble(agent: OfficeAgent, raw: string, seconds: number): void {
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
    // Just above the head: -96 put it a whole sprite above, which read as a
    // floating card rather than a speech bubble.
    // Above the name and status lines, never on top of them.
    const lift = DESKS.findIndex((desk) => desk.role === agent.role) % 2 === 0 ? 0 : 12;
    bubble.position.set(-width / 2, -78 - height - lift);
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

    this.conversationCooldown = Math.max(0, this.conversationCooldown - delta);
    this.advanceConversation(delta);

    // One speaker at a time: drop queued lines from agents that moved on, then
    // let the scheduler grant the next bubble.
    this.speech.dropStale((entry) => {
      const agent = this.agentFor(entry.agentId);
      // A line from an agent that no longer exists is stale. Conversation lines
      // stay queued even after the group disperses, so the last sentence is
      // still read instead of vanishing mid-air.
      return Boolean(agent);
    });
    const granted = this.speech.tick(delta);
    if (granted) {
      const speaker = this.agentFor(granted.agentId);
      if (speaker) {
        if (this.activeBubbleAgent && this.activeBubbleAgent !== granted.agentId) {
          this.clearBubble(this.activeBubbleAgent);
        }
        this.showBubble(speaker, granted.text, granted.duration);
        this.counts["speech.shown"] = (this.counts["speech.shown"] ?? 0) + 1;
        this.activeBubbleAgent = granted.agentId;
      }
    }

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

  private clearBubble(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent?.bubble) return;
    agent.root.removeChild(agent.bubble);
    agent.bubble.destroy({ children: true });
    agent.bubble = null;
    agent.bubbleTimer = 0;
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
        agent.pose = "sit";
        const group = this.conversation?.participants
          .map((id) => this.agents.get(id))
          .filter((member): member is OfficeAgent => Boolean(member)) ?? [];
        const others = group.filter((member) => member.id !== agent.id);
        const target = others[0] ?? agent;
        const dx = target.tile.x - agent.tile.x;
        const dy = target.tile.y - agent.tile.y;
        agent.facing =
          Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
        this.facingTexture(agent);
        this.activity(agent, "waiting to talk", 0x9fb3c8);
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
        case "whiteboard": {
          // A frame, a slightly cool board, and readable scribbles: a plain white
          // rectangle reads as a rendering bug at this zoom level.
          const width = (prop.w ?? 1) * TILE - 6;
          art
            .rect(x + 3, y + 7, width, 22)
            .fill(0x8f9aa6)
            .rect(x + 4, y + 8, width - 2, 20)
            .fill(0xdfe7ee)
            .rect(x + 4, y + 26, width - 2, 2)
            .fill(0xa9b4c0)
            // Scribbles: a heading, two bullet lines and a small diagram.
            .rect(x + 7, y + 11, 22, 2)
            .fill(0x2f4a63)
            .rect(x + 7, y + 16, 30, 1)
            .fill(0x3f7fd0)
            .rect(x + 7, y + 19, 24, 1)
            .fill(0x3f9e6b)
            .rect(x + 7, y + 22, 27, 1)
            .fill(0xd07a3f)
            .rect(x + 44, y + 15, 10, 1)
            .fill(0x9b5fc0)
            .rect(x + 48, y + 12, 2, 7)
            .fill(0x9b5fc0)
            // Tray with two markers.
            .rect(x + 8, y + 28, 12, 2)
            .fill(0x6d7885)
            .rect(x + 10, y + 27, 5, 1)
            .fill(0x3f7fd0)
            .rect(x + 17, y + 27, 4, 1)
            .fill(0xd07a3f);
          break;
        }
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

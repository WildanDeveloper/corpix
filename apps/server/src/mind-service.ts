import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  MindEngine,
  MindRunner,
  agentsFromTeam,
  applyRoleOverrides,
  envForRoles,
  loadTeam,
  type LLMProvider,
  type MindAgent,
  type SettingsService,
} from "@corpix/agents";
import type { Env, MindSettings } from "@corpix/shared";
import type { SqliteStore } from "@corpix/server/db";

export interface MindServiceOptions {
  store: SqliteStore;
  settings: SettingsService;
  configDir: string;
  env: Env;
  dataDir: string;
  /** Built from current settings on every call, so the UI can switch models. */
  provider: () => LLMProvider;
  /** Appends the event to the latest run and pushes it to every subscriber. */
  emit: (type: string, payload: Record<string, unknown>) => void;
  log?: (line: string) => void;
  /** True while a real task is running; minds pause so they do not compete. */
  busy?: () => boolean;
}

/**
 * Owns the office's inner life for the whole server process.
 *
 * The mind is not tied to a browser tab: agents keep thinking, remembering and
 * talking while nobody is watching, and the UI simply attaches to the stream.
 */
export class MindService {
  private readonly runner: MindRunner;
  private roster: MindAgent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private rosterAt = 0;
  private saveAt = 0;
  private readonly stateFile: string;

  constructor(private readonly options: MindServiceOptions) {
    this.stateFile = path.join(options.dataDir, "minds.json");
    this.runner = new MindRunner({
      agents: () => this.roster,
      engine: new MindEngine({
        provider: options.provider,
        settings: () => this.settings(),
        defaultModel: () => options.settings.load().settings.models.cheap,
        log: options.log,
      }),
      settings: () => this.settings(),
      context: () => this.latestContext(),
      company: () => options.settings.load().settings.team.company,
      emit: (type, payload) => {
        options.emit(type, payload);
        this.persistSoon();
      },
      log: options.log,
      busy: options.busy,
    });
  }

  start(): void {
    this.restore();
    void this.refreshRoster();
    this.timer = setInterval(() => {
      void this.heartbeat();
    }, 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.persist();
  }

  minds(): ReturnType<MindRunner["minds"]> {
    return this.runner.minds();
  }

  /** Roster changes (a rename, a new role) take effect on the next heartbeat. */
  invalidateRoster(): void {
    this.rosterAt = 0;
  }

  async say(agentId: string, text: string): Promise<{ name: string; say: string } | null> {
    const reply = await this.runner.speakTo(agentId, text);
    this.persistSoon();
    return reply;
  }

  private async heartbeat(): Promise<void> {
    if (Date.now() - this.rosterAt > 15_000) await this.refreshRoster();
    if (this.roster.length === 0) return;
    this.runner.tick();
    this.persistSoon();
  }

  private settings(): MindSettings {
    return this.options.settings.load().settings.mind;
  }

  private async refreshRoster(): Promise<void> {
    try {
      const runtime = this.options.settings.load();
      const team = applyRoleOverrides(
        await loadTeam(this.options.configDir, "team.default.yaml", envForRoles(this.options.env)),
        runtime.settings.models,
        runtime.settings.team.names,
      );
      this.roster = agentsFromTeam(team);
      this.rosterAt = Date.now();
    } catch (error) {
      this.options.log?.(`mind roster: ${(error as Error).message}`);
    }
  }

  private latestContext(): { goal: string; tasks: string[]; files: string[] } {
    const run = this.options.store.listRuns()[0];
    if (!run) return { goal: "", tasks: [], files: [] };
    const tasks = this.options.store
      .listTasks(run.id)
      .map((task) => task.title)
      .slice(-6);
    const files: string[] = [];
    for (const event of this.options.store.listEvents(run.id).slice(-400)) {
      if (event.type !== "tool.called") continue;
      const payload = event.payload as { tool?: unknown; input?: { path?: unknown } };
      if (payload.tool === "write_file" && typeof payload.input?.path === "string") {
        files.push(payload.input.path);
      }
    }
    return { goal: run.goal, tasks, files: files.slice(-6) };
  }

  private restore(): void {
    if (!existsSync(this.stateFile)) return;
    try {
      this.runner.restore(JSON.parse(readFileSync(this.stateFile, "utf8")) as unknown);
    } catch {
      // A corrupt memory file must never stop the office.
    }
  }

  private persistSoon(): void {
    const now = Date.now();
    if (now - this.saveAt < 4000) return;
    this.saveAt = now;
    this.persist();
  }

  private persist(): void {
    const temp = `${this.stateFile}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(this.runner.snapshot(), null, 2), { mode: 0o600 });
      renameSync(temp, this.stateFile);
    } catch {
      // Best effort: memory is nice to keep, never required to run.
    }
  }
}

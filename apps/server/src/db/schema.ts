import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  repo_path  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  goal         TEXT NOT NULL,
  status       TEXT NOT NULL,
  plan_json    TEXT,
  budget_usd   REAL NOT NULL DEFAULT 0,
  spent_usd    REAL NOT NULL DEFAULT 0,
  summary      TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  parent_id           TEXT,
  role                TEXT NOT NULL,
  title               TEXT NOT NULL,
  instructions        TEXT NOT NULL,
  status              TEXT NOT NULL,
  depends_on_json     TEXT NOT NULL DEFAULT '[]',
  acceptance_json     TEXT NOT NULL DEFAULT '[]',
  branch              TEXT,
  report_json         TEXT,
  started_at          TEXT,
  finished_at         TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);

CREATE TABLE IF NOT EXISTS agents (
  id     TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  role   TEXT NOT NULL,
  name   TEXT NOT NULL,
  model  TEXT NOT NULL,
  state  TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agents_run ON agents(run_id);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  idx          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  content_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, idx);

CREATE TABLE IF NOT EXISTS events (
  run_id       TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  ts           TEXT NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);

CREATE TABLE IF NOT EXISTS usage (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id              TEXT NOT NULL,
  task_id             TEXT NOT NULL,
  agent_id            TEXT NOT NULL,
  model               TEXT NOT NULL,
  input_tokens        INTEGER NOT NULL,
  output_tokens       INTEGER NOT NULL,
  cached_input_tokens INTEGER,
  cost_usd            REAL NOT NULL,
  ts                  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_run ON usage(run_id);

CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  tool        TEXT NOT NULL,
  input_json  TEXT NOT NULL,
  risk        TEXT NOT NULL,
  status      TEXT NOT NULL,
  summary     TEXT NOT NULL,
  decided_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_run ON approvals(run_id, status);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * SQLite with the pragmas the README's single-user workload needs: WAL so
 * readers are never blocked by the writer, and a busy timeout so a concurrent
 * run waits instead of failing with SQLITE_BUSY.
 */
export function openDatabase(file: string): Db {
  if (file !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

export function migrate(db: Db): void {
  db.exec(SCHEMA);
}

export function openMigrated(file: string): Db {
  const db = openDatabase(file);
  migrate(db);
  return db;
}

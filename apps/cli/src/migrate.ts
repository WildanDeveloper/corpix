import path from "node:path";
import { findRepoRoot, parseEnv, resolveDataDir } from "@corpix/shared";
import { openMigrated } from "@corpix/server/db";
import { config as loadDotenv } from "dotenv";

const repoRoot = findRepoRoot();
loadDotenv({ path: path.join(repoRoot, ".env") });

const env = parseEnv(process.env);
const file = path.join(resolveDataDir(env.DATA_DIR, repoRoot), "corpix.sqlite");
const db = openMigrated(file);
db.close();
process.stdout.write(`Database ready: ${path.resolve(file)}\n`);

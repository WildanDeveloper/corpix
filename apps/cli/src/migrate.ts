import path from "node:path";
import { parseEnv } from "@corpix/shared";
import { openMigrated } from "@corpix/server/db";
import "dotenv/config";

const env = parseEnv(process.env);
const file = path.join(env.DATA_DIR, "corpix.sqlite");
const db = openMigrated(file);
db.close();
process.stdout.write(`Database ready: ${path.resolve(file)}\n`);

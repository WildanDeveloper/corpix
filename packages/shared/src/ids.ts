import { randomUUID } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Short, URL-safe, sortable-enough id with a readable prefix. */
export function newId(prefix: string, length = 8): string {
  const bytes = randomUUID().replace(/-/g, "");
  let out = "";
  for (let i = 0; i < length; i++) {
    const hex = Number.parseInt(bytes.slice(i * 2, i * 2 + 2), 16);
    out += ALPHABET[hex % ALPHABET.length];
  }
  return `${prefix}_${out}`;
}

export const newRunId = (): string => newId("run");
export const newTaskId = (): string => newId("t");
export const newAgentId = (prefix: string): string => newId(prefix, 6);
export const newApprovalId = (): string => newId("ap");
export const newProjectId = (): string => newId("prj");

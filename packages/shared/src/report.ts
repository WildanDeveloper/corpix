import { z } from "zod";

export const CommandRunSchema = z.object({
  command: z.string(),
  exitCode: z.number().int(),
});
export type CommandRun = z.infer<typeof CommandRunSchema>;

export const ReportSchema = z.object({
  status: z.enum(["done", "blocked", "failed"]),
  summary: z.string(),
  filesChanged: z.array(z.string()),
  commandsRun: z.array(CommandRunSchema),
  openIssues: z.array(z.string()),
});
export type Report = z.infer<typeof ReportSchema>;

export function emptyReport(summary: string): Report {
  return {
    status: "done",
    summary,
    filesChanged: [],
    commandsRun: [],
    openIssues: [],
  };
}

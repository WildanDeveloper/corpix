/**
 * Conversations between agents.
 *
 * A conversation is a scripted, turn-based exchange: one speaker at a time, a
 * topic chosen from the roles present, and lines that reference the actual run
 * (changed files, task titles, the goal). The office renders it; this module only
 * decides who says what, in which order.
 */

export interface Participant {
  id: string;
  role: string;
  name: string;
}

export interface ConversationContext {
  goal?: string;
  tasks?: readonly string[];
  files?: readonly string[];
}

export interface ConversationLine {
  speakerId: string;
  speakerName: string;
  text: string;
}

export interface ConversationScript {
  topic: string;
  lines: ConversationLine[];
}

type Topic =
  | "api"
  | "tests"
  | "deploy"
  | "docs"
  | "planning"
  | "review"
  | "coffee"
  | "debug"
  | "design";

interface Template {
  /** Preferred role for this line; falls back to rotation. */
  role?: string;
  text: string;
}

const TOPICS: Record<Topic, Template[]> = {
  api: [
    { role: "frontend", text: "Does the endpoint from {file} match the contract in SPEC?" },
    { role: "backend", text: "Yes. {task} is merged; it returns the shape we agreed on." },
    { role: "frontend", text: "Good. I'll wire the client to it and stop mocking the response." },
    { role: "backend", text: "If the types drift, ping me before you patch around it." },
    { role: "frontend", text: "Will do. Want me to add an integration test on the client side?" },
    { role: "backend", text: "Please do. I'd rather catch it now than in review." },
  ],
  tests: [
    { role: "qa", text: "I ran the tests against {file}. One edge case is still open." },
    { role: "backend", text: "Which one? The empty input or the timeout?" },
    { role: "qa", text: "The empty input. It throws instead of returning a 400." },
    { role: "backend", text: "Fair. I'll guard it and add a case to the suite." },
    { role: "qa", text: "Ping me when it's in; I'll re-run the whole thing." },
    { role: "backend", text: "Will do. Thanks for catching it." },
  ],
  deploy: [
    { role: "devops", text: "The image builds, but the healthcheck fails on the first boot." },
    { role: "backend", text: "Because the database is not migrated yet?" },
    { role: "devops", text: "Exactly. Can the server run migrations on startup?" },
    { role: "backend", text: "It can. I'll make `db:migrate` idempotent and call it before listen." },
    { role: "devops", text: "Then I'll bump the start period in the compose file." },
    { role: "backend", text: "Good. That should stop the healthcheck from flapping." },
  ],
  docs: [
    { role: "docs", text: "I documented {file}, but I'm not sure about the setup steps." },
    { role: "backend", text: "The env vars are in `.env.example`; the key one is the base URL." },
    { role: "docs", text: "And the API key? Is it required for a local model?" },
    { role: "backend", text: "No. Any non-empty value works; local servers ignore it." },
    { role: "docs", text: "Perfect, I'll add that note and a one-line example." },
    { role: "backend", text: "Thanks. Keep the example runnable, please." },
  ],
  planning: [
    { role: "boss", text: "We have {task} in flight. Is anything blocked?" },
    { role: "backend", text: "No blockers, but the scope is bigger than the plan says." },
    { role: "boss", text: "Then split it: ship the contract first, the rest next round." },
    { role: "frontend", text: "That works for me; I can build against the contract." },
    { role: "boss", text: "Do that. I'll review the diff before we merge anything." },
    { role: "backend", text: "Understood." },
  ],
  review: [
    { role: "qa", text: "I reviewed {file}. The happy path is fine." },
    { role: "frontend", text: "What about the error state?" },
    { role: "qa", text: "It renders, but the copy is wrong: it says 'loading' while failing." },
    { role: "frontend", text: "Good catch. I'll fix the copy and add a test." },
    { role: "qa", text: "Then I'll approve it. Nothing else is blocking." },
  ],
  coffee: [
    { text: "How is your task going?" },
    { text: "Slow. The tests keep timing out on CI." },
    { text: "Want a second pair of eyes?" },
    { text: "Maybe after this coffee." },
    { text: "Deal. I'll be at my desk." },
  ],
  debug: [
    { role: "frontend", text: "The page is blank and the console is quiet. Weird." },
    { role: "backend", text: "Quiet usually means the request never left." },
    { role: "frontend", text: "The base URL is empty in the build." },
    { role: "backend", text: "There it is. It reads the env var at build time, not runtime." },
    { role: "frontend", text: "I'll pass it through the config instead." },
    { role: "backend", text: "That should do it." },
  ],
  design: [
    { role: "frontend", text: "The spacing feels tight around the task board." },
    { text: "Eight pixels everywhere, or only between cards?" },
    { role: "frontend", text: "Only between cards; the header is fine." },
    { text: "Use the token, not a magic number." },
    { role: "frontend", text: "Agreed. I'll fix it in the stylesheet." },
  ],
};

/** Topics in priority order, then a fallback. */
export function pickTopic(roles: readonly string[]): Topic {
  const has = (role: string): boolean => roles.includes(role);
  if (has("qa") && (has("backend") || has("frontend"))) return "tests";
  if (has("devops") && (has("backend") || has("frontend"))) return "deploy";
  if (has("docs")) return "docs";
  if (has("boss")) return "planning";
  if (has("frontend") && has("backend")) return "api";
  if (has("qa")) return "review";
  if (has("frontend")) return "design";
  if (has("backend")) return "debug";
  return "coffee";
}

function fileName(context: ConversationContext): string {
  const file = context.files?.[0];
  if (!file) return "the last change";
  return file.split("/").slice(-2).join("/");
}

function taskName(context: ConversationContext): string {
  const task = context.tasks?.[0];
  if (!task) return "the current task";
  return task.length > 42 ? `${task.slice(0, 39)}…` : task;
}

function fill(text: string, context: ConversationContext): string {
  return text
    .replaceAll("{file}", fileName(context))
    .replaceAll("{task}", taskName(context))
    .replaceAll("{goal}", context.goal ? `“${context.goal.slice(0, 48)}”` : "this goal");
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

/**
 * Build a turn-based script. Consecutive lines always come from different
 * speakers, so the office never shows two people talking at once.
 */
export function buildConversation(
  participants: readonly Participant[],
  context: ConversationContext = {},
  seed = 0,
): ConversationScript {
  if (participants.length < 2) {
    return { topic: "coffee", lines: [] };
  }
  const roles = participants.map((participant) => participant.role);
  const topic = pickTopic(roles);
  const templates = TOPICS[topic];
  const rotation = [...participants].sort(
    (a, b) => (hash(`${a.id}:${seed}`) % 97) - (hash(`${b.id}:${seed}`) % 97),
  );

  const lines: ConversationLine[] = [];
  let previous: string | null = null;
  for (let index = 0; index < templates.length; index++) {
    const template = templates[index] as Template;
    const preferred = template.role
      ? rotation.find((participant) => participant.role === template.role)
      : undefined;
    let speaker = preferred;
    if (!speaker || speaker.id === previous) {
      const candidate = rotation.find((participant) => participant.id !== previous);
      speaker = candidate ?? rotation[index % rotation.length];
    }
    if (!speaker) continue;
    // Never two lines from the same person in a row.
    if (speaker.id === previous) {
      const alternative = rotation.find((participant) => participant.id !== previous);
      if (alternative) speaker = alternative;
    }
    lines.push({
      speakerId: speaker.id,
      speakerName: speaker.name,
      text: fill(template.text, context),
    });
    previous = speaker.id;
  }
  return { topic, lines };
}

/** How long a line should stay on screen: longer text needs more time. */
export function lineDuration(text: string): number {
  return Math.min(6.5, Math.max(2.6, 1.6 + text.length * 0.045));
}

export function conversationCooldown(seed: number): number {
  return 9 + (seed % 7);
}

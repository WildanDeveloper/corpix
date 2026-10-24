/**
 * Global speech scheduler.
 *
 * Only one agent may speak at a time. Bubbles are queued with a priority and a
 * minimum gap, so the office reads like a conversation instead of a wall of
 * simultaneous text. This is the piece that stops "three people talking at once".
 */

export interface SpeechRequest {
  agentId: string;
  text: string;
  /** Higher wins when several requests arrive together. */
  priority: number;
  /** Seconds the bubble stays up. */
  duration: number;
  /** Keep the request only if the agent is still doing this activity. */
  tag?: string;
}

interface QueueEntry extends SpeechRequest {
  /** Ordering within the same priority. */
  seq: number;
}

export interface SpeechGrant {
  agentId: string;
  text: string;
  duration: number;
  tag?: string;
}

export class SpeechQueue {
  private queue: QueueEntry[] = [];
  private seq = 0;
  private speakingUntil = 0;
  private clock = 0;
  private lastSpeaker: string | null = null;

  constructor(
    /** Minimum silence between two bubbles. */
    private readonly gap = 0.35,
    /** How long a bubble occupies the channel after it appears. */
    private readonly hold = 0,
  ) {}

  get current(): { agentId: string; until: number } | null {
    if (this.clock >= this.speakingUntil) return null;
    return { agentId: this.lastSpeaker ?? "", until: this.speakingUntil };
  }

  get pending(): number {
    return this.queue.length;
  }

  enqueue(request: SpeechRequest): void {
    if (request.text.trim().length === 0) return;
    // Replace a queued line from the same agent: a person cannot talk twice.
    this.queue = this.queue.filter((entry) => entry.agentId !== request.agentId);
    this.queue.push({ ...request, seq: this.seq++ });
    this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  }

  /** Drop low-priority chatter, e.g. when a conversation takes the channel. */
  dropBelow(priority: number): void {
    this.queue = this.queue.filter((entry) => entry.priority >= priority);
  }

  /** Drop queued lines that no longer make sense (the agent moved on). */
  dropStale(isValid: (entry: { agentId: string; tag?: string }) => boolean): void {
    this.queue = this.queue.filter((entry) => isValid(entry));
  }

  clear(): void {
    this.queue = [];
    this.speakingUntil = 0;
    this.lastSpeaker = null;
  }

  /** Advance the clock and return the next bubble that may appear, if any. */
  tick(delta: number): SpeechGrant | null {
    this.clock += delta;
    // The very first bubble may appear immediately; afterwards the channel has
    // to be free for `gap` seconds so bubbles do not stack.
    if (this.speakingUntil > 0 && this.clock < this.speakingUntil + this.gap) return null;
    const next = this.queue.shift();
    if (!next) return null;
    this.lastSpeaker = next.agentId;
    this.speakingUntil = this.clock + Math.max(this.hold, next.duration);
    return {
      agentId: next.agentId,
      text: next.text,
      duration: next.duration,
      tag: next.tag,
    };
  }
}

/**
 * How long a line stays readable. Roughly 14 characters per second, with a
 * floor so "ok" is not gone before the eye lands on it and a ceiling so a
 * monologue does not lock the whole office.
 */
export function lineDuration(text: string): number {
  const characters = Math.max(2, text.trim().length);
  return Math.min(6.5, Math.max(2.6, 1.1 + characters / 14));
}

/** Stagger: a conversation should not fire every line at once. */
export function nextLineDelay(index: number, base = 2.4): number {
  return base + index * 0.9;
}

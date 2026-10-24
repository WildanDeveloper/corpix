/**
 * Global speech scheduler.
 *
 * Only one agent may speak at a time. Bubbles are queued with a priority and a
 * minimum gap, so the office reads like a conversation instead of a wall of
 * simultaneous text. This is the piece that stops "three people talking at once".
 *
 * The hard part is not showing one bubble — it is showing *enough* of them. A
 * queue that is emptied by every new conversation, or a bubble that is held for
 * seven seconds, produces an office that looks mute even though the agents are
 * talking constantly. So: short holds, a short gap, and conversation lines that
 * jump the queue instead of erasing it.
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
  /** Counters for `?debug=1`: where do lines go? */
  readonly stats = { enqueued: 0, granted: 0, dropped: 0, replaced: 0, preempted: 0 };
  private queue: QueueEntry[] = [];
  private seq = 0;
  private speakingUntil = 0;
  private clock = 0;
  private lastSpeaker: string | null = null;
  private currentPriority = 0;
  private currentStartedAt = 0;

  constructor(
    /** Minimum silence between two bubbles. */
    private readonly gap = 0.45,
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

  /** Debug view of the scheduler clock. */
  get debug(): { clock: number; until: number; queue: number; priority: number } {
    return {
      clock: this.clock,
      until: this.speakingUntil,
      queue: this.queue.length,
      priority: this.currentPriority,
    };
  }

  enqueue(request: SpeechRequest): void {
    if (request.text.trim().length === 0) return;
    // Replace a queued line from the same agent: a person cannot talk twice.
    const before = this.queue.length;
    this.queue = this.queue.filter((entry) => entry.agentId !== request.agentId);
    if (this.queue.length < before) this.stats.replaced += before - this.queue.length;
    this.stats.enqueued += 1;
    this.queue.push({ ...request, seq: this.seq++ });
    this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  }

  /**
   * A higher-priority speaker takes over. Queued chatter below `priority` is
   * discarded (it is stale by now), and a bubble that just appeared is cut
   * short rather than blocking the more important line for six seconds.
   */
  preempt(priority: number): void {
    const before = this.queue.length;
    this.queue = this.queue.filter((entry) => entry.priority >= priority);
    this.stats.preempted += before - this.queue.length;
    const age = this.clock - this.currentStartedAt;
    if (this.clock < this.speakingUntil && this.currentPriority < priority && age > 1.2) {
      this.speakingUntil = this.clock;
    }
  }

  /** Drop queued lines that no longer make sense (the agent moved on). */
  dropStale(isValid: (entry: { agentId: string; tag?: string }) => boolean): void {
    const before = this.queue.length;
    this.queue = this.queue.filter((entry) => isValid(entry));
    this.stats.dropped += before - this.queue.length;
  }

  clear(): void {
    this.queue = [];
    this.speakingUntil = 0;
    this.lastSpeaker = null;
    this.currentPriority = 0;
    this.currentStartedAt = 0;
  }

  /** Advance the clock and return the next bubble that may appear, if any. */
  tick(delta: number): SpeechGrant | null {
    this.clock += delta;
    // The very first bubble may appear immediately; afterwards the channel has
    // to be free for `gap` seconds so bubbles do not stack.
    if (this.speakingUntil > 0 && this.clock < this.speakingUntil + this.gap) return null;
    const next = this.queue.shift();
    if (!next) return null;
    this.stats.granted += 1;
    this.lastSpeaker = next.agentId;
    this.currentPriority = next.priority;
    this.currentStartedAt = this.clock;
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
  return Math.min(5.2, Math.max(2.4, 1 + characters / 16));
}

/** Stagger: a conversation should not fire every line at once. */
export function nextLineDelay(index: number, base = 2.4): number {
  return base + index * 0.9;
}

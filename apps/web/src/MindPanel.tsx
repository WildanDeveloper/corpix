import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { api } from "./api";
import type { MindSnapshot } from "./types";

/**
 * The inner life of the office, as the agents themselves describe it.
 *
 * Nothing on this panel is written by Corpix: the thoughts, moods, opinions and
 * memories are whatever each agent's model produced on its last turn. The
 * operator can talk to any of them and get an answer in character.
 */
export function MindPanel(): ReactElement {
  const [minds, setMinds] = useState<MindSnapshot[]>([]);
  const [error, setError] = useState("");
  const [talking, setTalking] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<{ name: string; say: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ minds: MindSnapshot[] }>("/api/mind");
      setMinds(data.minds);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    timer.current = setInterval(() => void load(), 4000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [load]);

  const send = async (agentId: string): Promise<void> => {
    const text = message.trim();
    if (text.length === 0) return;
    setBusy(true);
    setReply(null);
    try {
      const answer = await api<{ name: string; say: string }>("/api/mind/say", {
        method: "POST",
        body: JSON.stringify({ agentId, text }),
      });
      setReply(answer);
      setMessage("");
      setTalking(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel mind-panel">
      <h2>Minds</h2>
      <p className="muted">
        Every agent runs on its own model turn: it decides what to do, what it thinks, and how it
        feels. Nothing here is scripted by Corpix. Talk to one and it answers in character.
      </p>
      {error && <p className="error">{error}</p>}

      {reply && (
        <div className="mind-reply">
          <strong>{reply.name}</strong>
          <p>{reply.say}</p>
        </div>
      )}

      <div className="mind-grid">
        {minds.map((mind) => {
          const expanded = open === mind.agentId;
          return (
            <article key={mind.agentId} className={`mind-card ${expanded ? "open" : ""}`}>
              <header>
                <div>
                  <strong>{mind.name}</strong>
                  <span className="muted"> {mind.role}</span>
                </div>
                <span
                  className="mind-mood"
                  style={{ background: moodBackground(mind.mood.valence) }}
                  title={`valence ${mind.mood.valence.toFixed(2)}, energy ${mind.mood.arousal.toFixed(2)}`}
                >
                  {mind.mood.label}
                </span>
              </header>

              <p className="mind-thought">
                {mind.thought ? `“${mind.thought}”` : <span className="muted">not thinking yet</span>}
              </p>
              {mind.doing && <p className="muted small">doing: {mind.doing}</p>}

              <div className="mind-actions">
                <button
                  className="inline"
                  onClick={() => setOpen(expanded ? null : mind.agentId)}
                >
                  {expanded ? "Hide details" : "Details"}
                </button>
                <button
                  className="inline"
                  onClick={() => setTalking(talking === mind.agentId ? null : mind.agentId)}
                >
                  {talking === mind.agentId ? "Cancel" : "Talk"}
                </button>
              </div>

              {talking === mind.agentId && (
                <form
                  className="mind-talk"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void send(mind.agentId);
                  }}
                >
                  <input
                    autoFocus
                    value={message}
                    maxLength={500}
                    placeholder={`Say something to ${mind.name}…`}
                    onChange={(event) => setMessage(event.target.value)}
                  />
                  <button className="primary" disabled={busy || message.trim().length === 0}>
                    {busy ? "…" : "Send"}
                  </button>
                </form>
              )}

              {expanded && (
                <div className="mind-detail">
                  <h4>Remembers</h4>
                  {mind.memories.length === 0 ? (
                    <p className="muted small">Nothing yet.</p>
                  ) : (
                    <ul>
                      {mind.memories.map((memory, index) => (
                        <li key={`${memory.at}-${index}`}>{memory.text}</li>
                      ))}
                    </ul>
                  )}
                  <h4>Thinks of the others</h4>
                  {Object.keys(mind.relationships).length === 0 ? (
                    <p className="muted small">No opinions formed yet.</p>
                  ) : (
                    <ul>
                      {Object.entries(mind.relationships).map(([id, relation]) => (
                        <li key={id}>
                          <strong>{id}</strong>{" "}
                          <span className={relation.sentiment >= 0 ? "good" : "bad"}>
                            {relation.sentiment >= 0 ? "+" : ""}
                            {relation.sentiment.toFixed(2)}
                          </span>
                          {relation.note ? ` — ${relation.note}` : ""}
                          <span className="muted"> ({relation.talks} talks)</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function moodBackground(valence: number): string {
  if (valence > 0.35) return "rgba(111, 215, 160, 0.18)";
  if (valence < -0.35) return "rgba(255, 107, 107, 0.18)";
  return "rgba(159, 179, 200, 0.14)";
}

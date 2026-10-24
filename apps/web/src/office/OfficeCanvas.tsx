import { useEffect, useRef, type ReactElement } from "react";
import type { RunEvent } from "../types";
import { OfficeScene } from "./scene";

interface OfficeCanvasProps {
  runId: string | null;
  events: RunEvent[];
  roleNames: Record<string, string>;
  /** Real run context so conversations mention the actual work. */
  context?: { goal?: string; tasks?: string[]; files?: string[] };
}

/**
 * Mounts the Pixi scene once and feeds it the event stream. Events that arrive
 * before Pixi finishes initialising are replayed, so nothing is lost.
 */
export function OfficeCanvas({ runId, events, roleNames, context }: OfficeCanvasProps): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const lastSeq = useRef(0);
  const previousRunId = useRef<string | null>(null);
  const eventsRef = useRef(events);
  const roleNamesRef = useRef(roleNames);
  const contextRef = useRef(context);
  eventsRef.current = events;
  roleNamesRef.current = roleNames;
  contextRef.current = context;

  useEffect(() => {
    let cancelled = false;
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const host = hostRef.current;
    if (!host) return;

    void OfficeScene.create(host, { reducedMotion: reduced }).then((scene) => {
      if (cancelled) {
        scene.destroy();
        return;
      }
      sceneRef.current = scene;
      // `?debug=1` exposes the scene for the debug overlay and tests.
      if (new URLSearchParams(window.location.search).has("debug")) {
        (window as unknown as { __corpixOffice?: OfficeScene }).__corpixOffice = scene;
      }
      scene.setRoleNames(roleNamesRef.current);
      if (contextRef.current) scene.setContext(contextRef.current);
      // Replaying history places agents instantly; only live events animate.
      for (const event of eventsRef.current) scene.applyEvent(event, { instant: true });
      lastSeq.current = eventsRef.current.at(-1)?.seq ?? 0;
    });

    return () => {
      cancelled = true;
      sceneRef.current?.destroy();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setRoleNames(roleNames);
  }, [roleNames]);

  useEffect(() => {
    if (context) sceneRef.current?.setContext(context);
  }, [context]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    for (const event of events) {
      if (event.seq <= lastSeq.current) continue;
      scene.applyEvent(event);
      lastSeq.current = event.seq;
    }
  }, [events]);

  useEffect(() => {
    if (previousRunId.current === runId) return;
    previousRunId.current = runId;
    const scene = sceneRef.current;
    if (!scene) return;
    // A different run means a different office: clear it and replay whatever
    // history we already have for the new run.
    scene.reset();
    lastSeq.current = 0;
    for (const event of eventsRef.current) {
      if (runId && event.runId !== runId) continue;
      scene.applyEvent(event, { instant: true });
      lastSeq.current = event.seq;
    }
  }, [runId]);

  return (
    <div className="office-canvas-wrap">
      <div className="office-canvas" ref={hostRef} />
      {events.length === 0 && (
        <div className="office-empty">
          <span>Dispatch a goal to wake the office</span>
        </div>
      )}
      <p className="muted office-hint">
        The office is a renderer for the event stream. Hover an agent to read its
        name; every animation is backed by a real event.
      </p>
    </div>
  );
}

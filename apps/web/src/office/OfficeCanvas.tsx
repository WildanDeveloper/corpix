import { useEffect, useRef, type ReactElement } from "react";
import type { RunEvent } from "../types";
import { OfficeScene } from "./scene";

interface OfficeCanvasProps {
  runId: string | null;
  events: RunEvent[];
  roleNames: Record<string, string>;
}

/**
 * Mounts the Pixi scene once and feeds it the event stream. Events that arrive
 * before Pixi finishes initialising are replayed, so nothing is lost.
 */
export function OfficeCanvas({ runId, events, roleNames }: OfficeCanvasProps): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const lastSeq = useRef(0);
  const eventsRef = useRef(events);
  const roleNamesRef = useRef(roleNames);
  eventsRef.current = events;
  roleNamesRef.current = roleNames;

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
      scene.setRoleNames(roleNamesRef.current);
      for (const event of eventsRef.current) scene.applyEvent(event);
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
    const scene = sceneRef.current;
    if (!scene) return;
    for (const event of events) {
      if (event.seq <= lastSeq.current) continue;
      scene.applyEvent(event);
      lastSeq.current = event.seq;
    }
  }, [events]);

  useEffect(() => {
    lastSeq.current = 0;
    sceneRef.current?.reset();
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

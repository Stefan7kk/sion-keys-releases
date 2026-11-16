import { useEffect, useRef } from "react";

type Point = { x: number; y: number; edge: number };

function edgePoint(avoid?: { x: number; y: number }): Point {
  const w = Math.max(window.innerWidth, 1);
  const h = Math.max(window.innerHeight, 1);
  const minTravel = Math.min(w, h) * 0.34;
  const outside = Math.min(140, Math.min(w, h) * 0.12);
  for (let attempt = 0; attempt < 8; attempt++) {
    const edge = Math.floor(Math.random() * 4);
    const along = Math.random();
    const next = edge === 0 ? { x: along * w, y: -outside, edge }
      : edge === 1 ? { x: w + outside, y: along * h, edge }
      : edge === 2 ? { x: along * w, y: h + outside, edge }
      : { x: -outside, y: along * h, edge };
    if (!avoid) return next;
    const dx = next.x - avoid.x;
    const dy = next.y - avoid.y;
    if (dx * dx + dy * dy > minTravel * minTravel) return next;
  }
  return { x: Math.random() * w, y: -outside, edge: 0 };
}

function place(el: HTMLElement, point: Point, seconds: number) {
  const turn = point.edge % 2 === 1 ? 90 : 0;
  el.style.transition = seconds > 0 ? `transform ${seconds}s cubic-bezier(0.45, 0.05, 0.55, 0.95)` : "none";
  el.style.transform = `translate(${point.x}px, ${point.y}px) rotate(${turn}deg)`;
  el.dataset.glowX = String(point.x);
  el.dataset.glowY = String(point.y);
}

/** One faint patch. It breathes on a single edge, then drifts to another random edge point. */
export function PresenceGlow({ enabled }: { enabled: boolean }) {
  const patch = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!enabled) return;
    const el = patch.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    place(el, edgePoint(), 0);
    if (reduced) return;

    const step = () => {
      const from = { x: Number(el.dataset.glowX) || 0, y: Number(el.dataset.glowY) || 0 };
      place(el, edgePoint(from), 20 + Math.random() * 25);
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target !== el || event.propertyName !== "transform") return;
      step();
    };
    el.addEventListener("transitionend", onEnd);
    const kick = window.setTimeout(step, 400 + Math.random() * 800);
    return () => {
      window.clearTimeout(kick);
      el.removeEventListener("transitionend", onEnd);
    };
  }, [enabled]);

  if (!enabled) return null;
  return (
    <div className="hk-glow" aria-hidden="true">
      <div className="hk-glow-patch" ref={patch} />
    </div>
  );
}

import { useLayoutEffect, useRef, useState } from "react";

/** Per-character pace, capped so long text still finishes quickly. Tune here. */
const CHAR_MS = 20;
const MAX_MS = 1500;

/** Ids already typed this session, so a remount (show all, view switch) never replays. */
const typed = new Set<string>();

export const typingDuration = (text: string) => Math.min(Array.from(text).length * CHAR_MS, MAX_MS);

const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * Text that types out left to right the first time `active` is true for this `id`. The untyped
 * remainder is rendered hidden, so the final line wrapping and height are reserved from the start
 * and nothing below shifts. Screen readers get the full text at once.
 */
export function Typewriter({ id, text, active, delay = 0 }: { id: string; text: string; active: boolean; delay?: number }) {
  // null = never animated in this instance: plain text.
  const [shown, setShown] = useState<number | null>(null);
  const chars = Array.from(text);

  useLayoutEffect(() => {
    if (!active || typed.has(id) || !chars.length || prefersReducedMotion()) return;
    typed.add(id);
    const duration = typingDuration(text);
    const begin = performance.now() + delay;
    let finished = false;
    let frame = 0;
    const tick = (now: number) => {
      const count = Math.max(0, Math.floor(((now - begin) / duration) * chars.length));
      if (count >= chars.length) { finished = true; setShown(chars.length); return; }
      setShown(count);
      frame = requestAnimationFrame(tick);
    };
    setShown(0);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      // Interrupted (unmount, or StrictMode's dev re-run): let it type again next time.
      if (!finished) typed.delete(id);
    };
    // Starts once per id; later text or delay changes don't restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, id]);

  if (shown === null) return <>{text}</>;
  return (
    <span className="typewriter">
      <span className="sr-only typewriter-reader">{text}</span>
      <span aria-hidden="true">{chars.slice(0, shown).join("")}<span className="typewriter-rest">{chars.slice(shown).join("")}</span></span>
    </span>
  );
}

/**
 * True when `key` differs from the value it had once data first arrived (`ready`), i.e. it
 * changed during this session rather than being there on load.
 */
export function useChangedSinceLoad(key: string | null, ready: boolean): boolean {
  const baseline = useRef<{ key: string | null } | null>(null);
  if (ready && !baseline.current) baseline.current = { key };
  return Boolean(baseline.current && key !== null && key !== baseline.current.key);
}

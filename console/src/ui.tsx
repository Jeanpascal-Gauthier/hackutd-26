import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PulseIcon } from "./Icons";

/** Ids that appeared after the first snapshot, for the one-time arrival highlight. */
export function useFreshIds(ids: string[] | null): Set<string> {
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const signature = ids?.join("\n");
  useLayoutEffect(() => {
    if (!ids) return;
    if (!known.current) { known.current = new Set(ids); return; }
    if (!ids.length) { known.current.clear(); setFresh(new Set()); return; }
    const added = ids.filter((id) => !known.current!.has(id));
    if (!added.length) return;
    known.current = new Set(ids);
    setFresh((previous) => new Set([...previous, ...added].filter((id) => known.current!.has(id))));
    // The signature tracks the identifiers without rerunning for unchanged snapshots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return fresh;
}

export function formatAgo(elapsedMs: number) {
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
}

/** Relative time that keeps itself current. */
export function Ago({ value }: { value: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return <time dateTime={new Date(value).toISOString()} title={new Date(value).toLocaleString()}>{formatAgo(now - value)}</time>;
}

/** Only display recorded counts; inferred occupancy is unavailable in the console. */
export function PeopleCount({ count, estimated = false, unit = "people" }: { count: number; estimated?: boolean; unit?: string }) {
  if (estimated) return <span aria-label="People count unavailable">—</span>;
  return <>{unit ? `${count} ${unit}` : `${count}`}</>;
}

export const formatTime = (value: number) =>
  new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function Timestamp({ value }: { value: number }) {
  return <time dateTime={new Date(value).toISOString()} title={new Date(value).toLocaleString()}>{formatTime(value)}</time>;
}

export function PanelHeading({ label, title, id, count, aside }: { label?: string; title: string; id?: string; count?: number; aside?: ReactNode }) {
  return (
    <div className="panel-heading">
      <div>{label && <span className="eyebrow">{label}</span>}<h2 id={id}>{title}</h2></div>
      {(count !== undefined || aside) && <div className="panel-heading-aside">{count !== undefined && <span className="count-badge">{count.toString().padStart(2, "0")}</span>}{aside}</div>}
    </div>
  );
}

export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-state">
      <span className="empty-symbol" aria-hidden="true"><PulseIcon size={22} /></span>
      <strong>{title}</strong><p>{text}</p>
    </div>
  );
}

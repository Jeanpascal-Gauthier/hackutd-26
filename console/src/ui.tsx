import building from "@firewatch/shared/building.json";
import type { ReactNode } from "react";
import { PulseIcon } from "./Icons";

export const roomName = (id?: string) =>
  building.rooms.find((room) => room.id === id)?.name ?? id ?? "Location pending";

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

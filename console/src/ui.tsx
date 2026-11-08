import building from "@firewatch/shared/building.json";

export const roomName = (id?: string) =>
  building.rooms.find((room) => room.id === id)?.name ?? id ?? "Location pending";

export const formatTime = (value: number) =>
  new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function Timestamp({ value }: { value: number }) {
  return <time dateTime={new Date(value).toISOString()} title={new Date(value).toLocaleString()}>{formatTime(value)}</time>;
}

export function PanelHeading({ label, title, id, count }: { label: string; title: string; id?: string; count?: number }) {
  return (
    <div className="panel-heading">
      <div><span className="eyebrow">{label}</span><h2 id={id}>{title}</h2></div>
      {count !== undefined && <span className="count-badge">{count.toString().padStart(2, "0")}</span>}
    </div>
  );
}

export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-state">
      <span className="empty-symbol" aria-hidden="true">⌁</span>
      <strong>{title}</strong><p>{text}</p>
    </div>
  );
}

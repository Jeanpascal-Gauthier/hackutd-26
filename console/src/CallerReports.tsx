// Caller reports for the selected incident. A report tied to a map incident shows that incident's place;
// a building-pipeline report keeps its room link and location confidence.
import { useState } from "react";
import type { Report } from "@firewatch/shared/types";
import { useBuilding } from "./activeBuilding";
import { PinIcon } from "./Icons";
import { Empty, PanelHeading, formatTime as time } from "./ui";

const channels: Record<NonNullable<Report["channel"]>, string> = { voice: "Voice", sms: "SMS", form: "Form", console: "Console" };

function ReportCard({ report, place, fresh }: { report: Report; place: string | null; fresh: boolean }) {
  const { roomName } = useBuilding();
  const uncertain = !report.roomId || report.confidence === undefined || report.confidence < 0.7;
  return (
    <article className={`report-card${fresh ? " is-new" : ""}`}>
      <div className="report-meta"><strong>{report.caller}</strong><time dateTime={new Date(report.time).toISOString()}>{time(report.time)}</time></div>
      <p>{report.text}</p>
      {report.reply && <div className="caller-reply report-reply"><span className="eyebrow">Caller was told</span><p>{report.reply}</p></div>}
      <div className="report-location">
        {report.incidentId
          ? place && <span className="report-place"><PinIcon size={16} />{place}</span>
          : <><span className="report-place"><PinIcon size={16} />{roomName(report.roomId)}</span>{uncertain && <span className="pill warn">Location uncertain</span>}</>}
        {report.channel && <span className="pill">{channels[report.channel]}</span>}
      </div>
    </article>
  );
}

export function CallerReports({ reports, place, freshIds }: {
  reports: Report[];
  /** The selected incident's place, shown on reports tied to it. */
  place: string | null;
  freshIds: ReadonlySet<string>;
}) {
  const [showAll, setShowAll] = useState(false);
  const newest = [...reports].sort((a, b) => b.time - a.time);
  const visible = showAll ? newest : newest.slice(0, 3);
  return (
    <section className="panel reports-panel" aria-labelledby="reports-heading">
      <PanelHeading title="Caller reports" id="reports-heading" count={reports.length} />
      <div id="report-list" className="report-list" role="log" aria-label="Caller reports" aria-live="polite" aria-relevant="additions">
        {visible.length ? visible.map((report) => <ReportCard key={report.id} report={report} place={place} fresh={freshIds.has(report.id)} />) : <Empty title="No reports for this incident" text="Caller reports tied to this incident will appear here." />}
      </div>
      {reports.length > 3 && <button className="show-reports" aria-expanded={showAll} aria-controls="report-list" onClick={() => setShowAll(!showAll)}>{showAll ? "Show latest 3" : `Show all ${reports.length} reports`}</button>}
    </section>
  );
}

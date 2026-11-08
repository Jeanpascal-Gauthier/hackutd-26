import type { TrailStep } from "@firewatch/shared/types";
import { Empty, PanelHeading } from "./ui";
import { SparkIcon } from "./Icons";

function formatValue(value: unknown) {
  return JSON.stringify(value, null, 2) ?? "No value supplied";
}

function hasError(output: unknown): boolean {
  return typeof output === "object" && output !== null && "error" in output && Boolean(output.error);
}

const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;

/** Building tools get a readable one-line summary instead of the generic status; other tools keep it. */
function summary(step: TrailStep): { tag: string; text: string } | null {
  const input = record(step.input), output = record(step.output);
  if (step.tool === "find_building") {
    // find_building returns `match` as the formatted address string; accept the object form too.
    const match = text(output.match) ?? text(record(output.match).formatted);
    const candidates = Array.isArray(output.candidates) ? output.candidates.length : typeof output.candidates === "number" ? output.candidates : null;
    const query = text(input.address) ?? text(input.query);
    const parts = [query && `“${query}”`, match && `matched ${match}`, candidates !== null && `${candidates} outline${candidates === 1 ? "" : "s"} nearby`].filter(Boolean);
    return { tag: "Building lookup", text: parts.length ? parts.join(" · ") : "Address lookup recorded" };
  }
  return null;
}

export function AgentTrail({ steps = [], demo = false }: { steps?: readonly TrailStep[]; demo?: boolean }) {
  const visibleSteps = steps.filter((step) => step.tool !== "estimate_occupancy");
  return (
    <section className="panel" aria-labelledby="agent-heading">
      <PanelHeading label="Server tool activity" title="Tool-call trail" id="agent-heading" count={visibleSteps.length} aside={<span className="agent-icon" aria-hidden="true"><SparkIcon size={18} /></span>} />
      <p className="panel-note trail-note">
        {demo ? "Scripted scenario: tool entries and timings may be illustrative." : "Recorded tool calls in execution order, with the server's input, output, and duration."}
      </p>
      {visibleSteps.length ? (
        <ol className="tool-trail">
          {visibleSteps.map((step, index) => {
            const about = summary(step);
            return (
            <li key={`${index}-${step.tool}`} className={hasError(step.output) ? "failed" : "recorded"}>
              <div><strong>{step.tool}</strong>{about && <span className="tool-tag">{about.tag}</span>}<span>{Math.round(step.ms)} ms</span></div>
              <p className="tool-status">{hasError(step.output) ? "Tool returned an error" : about?.text ?? "Call recorded"}</p>
              <details>
                <summary>Inspect input & output</summary>
                <span className="eyebrow">INPUT</span><pre>{formatValue(step.input)}</pre>
                <span className="eyebrow">OUTPUT</span><pre>{formatValue(step.output)}</pre>
              </details>
            </li>
            );
          })}
        </ol>
      ) : (
        <Empty title="No tool calls recorded" text="Tool activity will appear when the server records it. Reports can also be processed by the rule-based locator." />
      )}
    </section>
  );
}

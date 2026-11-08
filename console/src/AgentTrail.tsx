import type { TrailStep } from "@firewatch/shared/types";
import { Empty, PanelHeading } from "./ui";

function formatValue(value: unknown) {
  return JSON.stringify(value, null, 2) ?? "No value supplied";
}

function hasError(output: unknown): boolean {
  return typeof output === "object" && output !== null && "error" in output && Boolean(output.error);
}

export function AgentTrail({ steps = [], demo = false }: { steps?: readonly TrailStep[]; demo?: boolean }) {
  return (
    <section className="panel" aria-labelledby="agent-heading">
      <PanelHeading label="SERVER TOOL ACTIVITY" title="Tool-call trail" id="agent-heading" count={steps.length} />
      <p className="panel-note trail-note">
        {demo ? "Scripted scenario: tool entries and timings may be illustrative." : "Recorded tool calls in execution order, with the server's input, output, and duration."}
      </p>
      {steps.length ? (
        <ol className="tool-trail">
          {steps.map((step, index) => (
            <li key={`${index}-${step.tool}`} className={hasError(step.output) ? "failed" : "recorded"}>
              <div><strong>{step.tool}</strong><span>{Math.round(step.ms)} ms</span></div>
              <p className="tool-status">{hasError(step.output) ? "Tool returned an error" : "Call recorded"}</p>
              <details>
                <summary>Inspect input & output</summary>
                <span className="eyebrow">INPUT</span><pre>{formatValue(step.input)}</pre>
                <span className="eyebrow">OUTPUT</span><pre>{formatValue(step.output)}</pre>
              </details>
            </li>
          ))}
        </ol>
      ) : (
        <Empty title="No tool calls recorded" text="Tool activity will appear when the server records it. Reports can also be processed by the rule-based locator." />
      )}
    </section>
  );
}

// Tool-call trail panel. App.tsx maps the server's state.trail (shared TrailStep) into these display steps.
import { SparkIcon } from "./Icons";
export interface AgentStep {
  id: string;
  tool: string;
  summary: string;
  status: "running" | "completed" | "failed";
  time?: number;
}

export function AgentTrail({ steps = [] }: { steps?: readonly AgentStep[] }) {
  return (
    <section className="panel" aria-labelledby="agent-heading">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">AGENT ACTIVITY</span>
          <h2 id="agent-heading">Tool-call trail</h2>
        </div>
        <span className="agent-icon" aria-hidden="true"><SparkIcon size={20} /></span>
      </div>
      {steps.length ? (
        <ol className="tool-trail">
          {steps.map((step) => (
            <li key={step.id} className={`${step.status} enter`}>
              <div><strong>{step.tool}</strong><span>{step.status}</span></div>
              <p>{step.summary}</p>
              {step.time !== undefined && (
                <time dateTime={new Date(step.time).toISOString()}>
                  {new Date(step.time).toLocaleTimeString()}
                </time>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <div className="agent-empty">
          <span className="pending-label">AWAITING AGENT CONNECTION</span>
          <p>Tool calls will appear here when the agent provides its activity trail.</p>
          <span className="subtle">Current reports and recommendations are shown in their own panels.</span>
        </div>
      )}
    </section>
  );
}

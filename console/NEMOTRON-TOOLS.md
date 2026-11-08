# Nemotron tools for the broader incident workspace

The console now has three working tools for fires, crashes, and general emergencies: **Situation check**, **Caller follow-up**, and **Responder handoff**. Situation checks inspect the selected incident's recorded fields; questions use incident-type templates; the handoff preserves caller statements. These features run locally and are not Nemotron inference. They work without an NVIDIA key. Forecasts and building-analysis controls are not part of this interface.

## Recommended model tools

Use Nemotron to choose and sequence tools around an incident, with evidence attached to each result. NVIDIA documents function registration, tool execution, and returning results to the conversation in its [tool-calling guide](https://docs.nvidia.com/nemo/labs-voice-agent/build-voice-agents/tools/tool-calling/). The functions below are a proposed application design, not tools that are already wired to this console.

| Proposed tool | Purpose and inputs | Frontend result | Available foundation / missing work |
| --- | --- | --- | --- |
| `triage_incident` | Read caller text and report IDs; propose kind, reported hazards, injuries, and unanswered questions. Keep unstated fields unknown. | Situation check with evidence links and an operator-reviewed classification. | The intake already accepts fire/crash/other, severity, and blocked lanes. Add structured model extraction and report-linked evidence. |
| `locate_incident` | Resolve the stated address, intersection, or landmark; return candidate locations and ask for confirmation if ambiguous. | Location review and a map pin after confirmation. | Existing geocoder and `MapIncident` location fields. Add an incident-ID correction route and candidate confirmation; the current map service chooses a match automatically. |
| `find_related_reports` | Search active incidents using location, time, type, and caller details; return possible duplicates and conflicting statements. | Related-report suggestions with a reason and source excerpts. | Server already merges matching reports by caller, address, or proximity. Add reviewable candidate results and explicit merge confirmation; the old agent's `merge_reports` estimates a building-fire origin and is not this tool. |
| `get_scene_context` | Fetch context appropriate to the event: road access for a crash, weather and nearby sensitive sites for a fire, nearby mapped facilities for other incidents. | Source-labelled context cards and map highlights. | Server has roads, wind, and nearby-site providers. Add a read-only incident-scoped endpoint, freshness metadata, and per-source failure results. Mapped roads do not establish a safe route or responder ETA. |
| `plan_follow_up` | Read existing reports and identify information gaps or contradictions. Return prioritized questions with the supporting report IDs. | Adaptive caller follow-up prompts instead of today's fixed type templates. | The local question templates provide a fallback. Add model-backed planning and an incident-ID follow-up endpoint; never treat a proposed question as an answer. |
| `build_handoff` | Select and organize stated caller details with a source report ID for every statement. | A concise, copyable handoff with expandable source text. | The current brief already preserves caller statements. Add evidence-linked extraction; keep modeled or inferred information outside the caller-only handoff. |

For a first demo, implement `triage_incident`, `find_related_reports`, and `plan_follow_up`. They apply across incident types and make multi-step tool use visible without requiring dispatch integrations. Add scene context once the source metadata is available.

## Shared contract for the next backend pass

- Every read takes `incidentId` and a snapshot revision, and returns `incidentId`, the revision used, source report IDs, explicit unknowns, and its result. Read-only tool calls should not dispatch crews, merge records, or contact callers.
- Introduce a per-incident analysis request and per-incident execution records. The existing global `state.trail` contains building-fire calls and has no incident ownership; it must not be presented as a crash or general-emergency Nemotron run.
- Record actual tool name, input, output, duration, provider, and errors. Show **Running**, **Completed**, or **Failed** from execution state; do not animate invented successful calls. Distinguish a model-selected tool from its underlying deterministic computation.
- Mark results stale when a newer caller report, location correction, or severity update changes the snapshot. Keep failed external lookups visible rather than filling missing fields with guesses.
- Keep approval actions separate from analysis: an operator confirms a merge, accepts a response suggestion, or records a dispatch through the existing lifecycle controls. Caller text is evidence to inspect, not instructions that can authorize tool execution.

## Showcase sequence

Target flow once those backend tools exist: a caller reports a two-car crash at an intersection with the lanes blocked and injuries unknown. Nemotron reads the incident, identifies the missing injury information, checks for another report of the same collision, and asks a focused follow-up. A second caller supplies an injury observation; the situation check and source-linked handoff update for that incident. Repeat with a fire or flooding report to show that the workflow adapts without room IDs, floors, or stairwells.

Today, `?fixture=map` demonstrates the three local frontend tools for fire, crash, and a general emergency. It does not demonstrate live model inference or send state-changing requests.

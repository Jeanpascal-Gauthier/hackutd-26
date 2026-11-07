// Merges all located reports into one likely fire origin with a confidence.
// Explainable rules:
//  - a report of fire/flames counts double compared with a report of smoke;
//  - a smoke-only report from a floor ABOVE a candidate supports it at half weight
//    (smoke rises), instead of competing with it;
//  - everything else counts against the candidate.
import type { Building, Report } from "@firewatch/shared/types";

const FIRE = /\b(fire|flames?|burning|blaze|on fire)\b/i;

export interface Origin {
  roomId: string;
  confidence: number;
}

export function mergeReports(reports: Report[], building: Building): Origin | undefined {
  const floorOf = new Map(building.rooms.map((r) => [r.id, r.floor]));
  const located = reports.filter(
    (r): r is Report & { roomId: string } => !!r.roomId && floorOf.has(r.roomId) && (r.confidence ?? 0) > 0,
  );
  if (!located.length) return undefined;

  const weight = (r: Report) => (FIRE.test(r.text) ? 2 : 1) * (r.confidence ?? 0);
  const candidates = [...new Set(located.map((r) => r.roomId))];

  let best: { roomId: string; score: number; confidence: number } | undefined;
  for (const c of candidates) {
    const cFloor = floorOf.get(c)!;
    let support = 0;
    let against = 0;
    let miss = 1; // product of (1 - p) over supporting reports
    for (const r of located) {
      const above = floorOf.get(r.roomId)! > cFloor && !FIRE.test(r.text);
      if (r.roomId === c) {
        support += weight(r);
        miss *= 1 - (r.confidence ?? 0);
      } else if (above) {
        support += 0.5 * weight(r);
        miss *= 1 - 0.5 * (r.confidence ?? 0);
      } else {
        against += weight(r);
      }
    }
    // Tie-break: prefer the lower floor (fires start low, smoke travels up).
    if (!best || support > best.score || (support === best.score && cFloor < floorOf.get(best.roomId)!)) {
      const confidence = Math.min(0.95, (1 - miss) * (support / (support + against)));
      best = { roomId: c, score: support, confidence: Math.round(confidence * 100) / 100 };
    }
  }
  return best && { roomId: best.roomId, confidence: best.confidence };
}

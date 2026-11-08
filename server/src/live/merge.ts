// Merges located reports into fire origins with a confidence.
// mergeFires (used by the live incident): every fire the reports point to, see its rules below.
// mergeReports: one most likely origin. Explainable rules:
//  - a report of fire/flames counts double compared with a report of smoke;
//  - a smoke-only report from a floor ABOVE a candidate supports it at half weight
//    (smoke rises), instead of competing with it;
//  - everything else counts against the candidate.
import type { Building, Report } from "@firewatch/shared/types";

const FIRE = /\b(fire|flames?|burning|blaze|on fire)\b/i;
/** "fire alarm", "fire exit"... name equipment or people, not a fire someone can see. */
const NOT_A_FIRE = /\bfire[\s-]*(alarms?|drills?|exits?|doors?|escapes?|extinguishers?|department|trucks?|fighters?|marshals?|hoses?|hydrants?)\b/gi;

/** True when the caller says they see fire (not just smoke, an alarm or a fire exit). */
export const isFireReport = (text: string) => FIRE.test(text.replace(NOT_A_FIRE, ""));

type Located = Report & { roomId: string; confidence: number };
const round2 = (v: number) => Math.round(v * 100) / 100;

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

  const weight = (r: Report) => (isFireReport(r.text) ? 2 : 1) * (r.confidence ?? 0);
  const candidates = [...new Set(located.map((r) => r.roomId))];

  let best: { roomId: string; score: number; confidence: number } | undefined;
  for (const c of candidates) {
    const cFloor = floorOf.get(c)!;
    let support = 0;
    let against = 0;
    let miss = 1; // product of (1 - p) over supporting reports
    for (const r of located) {
      const above = floorOf.get(r.roomId)! > cFloor && !isFireReport(r.text);
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

/** Halls and shafts: a fire on a floor is placed in a real room when one was reported. */
const isCommonArea = (id: string) => /-(hall|stair-[a-z]+|elev-\d+)$/.test(id);

/**
 * Every fire the reports point to, most confident first (ties: lower floor). The first one is
 * the incident's primary origin. Rules:
 *  - reports of fire on different floors are separate fires; on one floor they are one fire,
 *    in the room with the most report confidence (a real room before a hall or shaft);
 *  - a smoke-only report supports the nearest fire on its floor or below it (smoke rises);
 *  - smoke-only reports that no fire explains (below every fire, or no fire reported at all)
 *    are merged by mergeReports into one more fire. With no fire reports this is exactly
 *    mergeReports, so smoke-only incidents behave as before.
 * Confidence: 1 - product of (1 - p) over supporting reports, at full weight for reports in the
 * fire's room and half weight for other rooms; capped at 0.95.
 */
export function mergeFires(reports: Report[], building: Building): Origin[] {
  const floorOf = new Map(building.rooms.map((r) => [r.id, r.floor]));
  const located = reports.filter(
    (r): r is Located => !!r.roomId && floorOf.has(r.roomId) && (r.confidence ?? 0) > 0,
  );

  const fireByFloor = new Map<number, Located[]>();
  for (const r of located)
    if (isFireReport(r.text)) {
      const f = floorOf.get(r.roomId)!;
      fireByFloor.set(f, [...(fireByFloor.get(f) ?? []), r]);
    }

  const fires: { roomId: string; floor: number; miss: number }[] = [];
  for (const [floor, reps] of fireByFloor) {
    const score = new Map<string, number>(); // insertion order = earliest report first (stable sort)
    for (const r of reps) score.set(r.roomId, (score.get(r.roomId) ?? 0) + r.confidence);
    const [roomId] = [...score].sort(
      (a, b) => Number(isCommonArea(a[0])) - Number(isCommonArea(b[0])) || b[1] - a[1],
    )[0];
    let miss = 1;
    for (const r of reps) miss *= 1 - (r.roomId === roomId ? 1 : 0.5) * r.confidence;
    fires.push({ roomId, floor, miss });
  }

  const unexplained: Located[] = [];
  for (const r of located) {
    if (isFireReport(r.text)) continue;
    const f = floorOf.get(r.roomId)!;
    const fire = fires.filter((x) => x.floor <= f).sort((a, b) => b.floor - a.floor)[0];
    if (!fire) unexplained.push(r);
    else fire.miss *= 1 - (r.roomId === fire.roomId ? 1 : 0.5) * r.confidence;
  }

  const out: Origin[] = fires.map((x) => ({ roomId: x.roomId, confidence: round2(Math.min(0.95, 1 - x.miss)) }));
  const fromSmoke = mergeReports(unexplained, building);
  if (fromSmoke) out.push(fromSmoke);
  return out.sort((a, b) => b.confidence - a.confidence || floorOf.get(a.roomId)! - floorOf.get(b.roomId)!);
}

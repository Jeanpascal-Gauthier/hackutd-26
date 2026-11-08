// Address comparison for repeat lookups. Copied from agent/core/tools/findBuilding.ts
// (addressTokens), not imported: different package. Keep the two in step.

/** Words that are spelled many ways in addresses -> one spelling. */
const ABBREV: Record<string, string> = {
  street: "st",
  avenue: "ave",
  av: "ave",
  road: "rd",
  boulevard: "blvd",
  drive: "dr",
  lane: "ln",
  court: "ct",
  place: "pl",
  parkway: "pkwy",
  highway: "hwy",
  suite: "ste",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
};
const FILLER = new Set(["the", "a", "an", "at", "in", "on", "of", "building", "bldg", "usa", "us", "united", "states"]);

/** "1313 Broadway Street, Tacoma, WA" -> ["1313", "broadway", "st", "tacoma", "wa"]. */
export function addressTokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t && !FILLER.has(t))
    .map((t) => ABBREV[t] ?? t);
}

/**
 * True when `address` says nothing that `known` doesn't: equal after normalising, or the start
 * of it ("800 W Campbell Rd" vs "800 West Campbell Road, Richardson, TX 75080"). One-way on
 * purpose: an address that adds detail ("100 Main St, Plano" after "100 Main St") is new.
 */
export function coveredBy(address: string, known: string | undefined | null): boolean {
  if (!known) return false;
  const x = addressTokens(address).join(" ");
  const y = addressTokens(known).join(" ");
  if (!x || !y) return false;
  return x === y || y.startsWith(`${x} `);
}

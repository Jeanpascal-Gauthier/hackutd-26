// Stub: basic sanity checks on shared/building.json.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Building } from "@firewatch/shared/types";

const IN = fileURLToPath(new URL("../shared/building.json", import.meta.url));
const building = JSON.parse(readFileSync(IN, "utf8")) as Building;

const errors: string[] = [];
const ids = new Set<string>();

for (const r of building.rooms) {
  if (ids.has(r.id)) errors.push(`duplicate room id: ${r.id}`);
  ids.add(r.id);
}
for (const l of building.links) {
  if (!ids.has(l.a)) errors.push(`link references unknown room: ${l.a}`);
  if (!ids.has(l.b)) errors.push(`link references unknown room: ${l.b}`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(
  `ok: ${building.rooms.length} rooms, ${building.links.length} links, ${building.verticals.length} verticals`,
);

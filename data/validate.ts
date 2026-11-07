// Validates a generated building. Defaults to data/out/; pass a directory to check another.
//   npm run validate -w data [-- <dir containing building.json + building.meta.json>]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Building } from "@firewatch/shared/types";
import { validate } from "./check.ts";
import type { BuildingMeta } from "./model.ts";

const dir = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL("./out", import.meta.url));
const building = JSON.parse(readFileSync(`${dir}/building.json`, "utf8")) as Building;
const meta = JSON.parse(readFileSync(`${dir}/building.meta.json`, "utf8")) as BuildingMeta;

const errors = validate(building, meta);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`ok: ${building.rooms.length} rooms, ${building.links.length} links, ${building.verticals.length} verticals`);

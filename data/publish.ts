// Publishes the generated building to the shared contract.
//   npm run publish:shared -w data  -> shared/building.json (meta stays in data/out/)
// Run `npm run generate -w data` too, so data/out/ (read by the server) stays in sync.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./check.ts";
import { generate } from "./model.ts";

const { building, meta } = generate();
const errs = validate(building, meta);
if (errs.length) {
  console.error(errs.join("\n"));
  process.exit(1);
}

const target = fileURLToPath(new URL("../shared/building.json", import.meta.url));
writeFileSync(target, JSON.stringify(building, null, 2) + "\n");
console.log(`wrote ${target} (${building.rooms.length} rooms, ${building.links.length} links, ${building.verticals.length} verticals)`);

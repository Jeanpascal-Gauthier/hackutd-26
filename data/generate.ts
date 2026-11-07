// Generates the synthetic building and writes it for review.
//   npm run generate -w data                 -> data/out/building.json + building.meta.json
//   npm run generate -w data -- --out <dir>  -> custom directory
// Never writes shared/building.json (not yet coordinated with the team).
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { validate } from "./check.ts";
import { generate } from "./model.ts";

const i = process.argv.indexOf("--out");
const outDir = i > 0 ? resolve(process.argv[i + 1]) : fileURLToPath(new URL("./out", import.meta.url));
if (resolve(outDir) === resolve(fileURLToPath(new URL("../shared", import.meta.url)))) {
  console.error("refusing to write into shared/ — coordinate the schema first");
  process.exit(1);
}

const { building, meta } = generate();
const errs = validate(building, meta);
if (errs.length) {
  console.error(errs.join("\n"));
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/building.json`, JSON.stringify(building, null, 2) + "\n");
writeFileSync(`${outDir}/building.meta.json`, JSON.stringify(meta, null, 2) + "\n");
console.log(`wrote ${outDir}/building.json (${building.rooms.length} rooms, ${building.links.length} links, ${building.verticals.length} verticals)`);
console.log(`wrote ${outDir}/building.meta.json`);

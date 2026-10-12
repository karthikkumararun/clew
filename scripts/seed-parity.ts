// Compare row counts and sampled checksums across the running databases and SQLite.
import { checkParity } from "../e2e/helpers/parity";

const r = await checkParity();
console.log(
  `compared: ${r.compared.join(", ")}${r.skipped.length ? `; not running: ${r.skipped.join(", ")}` : ""}`,
);
for (const d of r.differences) console.error(`DIFF ${d}`);
process.exit(r.differences.length === 0 ? 0 : 1);

// `pnpm icons`: render every platform icon from design/icons/*.svg.
//   pnpm icons                  write src-tauri/icons/**, src/components/ClewMark.tsx
//   pnpm icons --update-golden  also refresh design/icons/golden/*.png (review before committing)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  GOLDEN_DIR,
  ICON_DIR,
  MARK_COMPONENT,
  checkSources,
  generateAssets,
  loadSources,
  renderGolden,
} from "./icons-lib";

function write(path: string, data: Buffer | string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

const src = loadSources();
const problems = checkSources(src);
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

const { icons, mark } = await generateAssets(src);
for (const [name, data] of icons) write(join(ICON_DIR, name), data);
write(MARK_COMPONENT, mark);
console.log(`wrote ${icons.size} icon files and ${MARK_COMPONENT}`);

if (process.argv.includes("--update-golden")) {
  for (const [size, png] of renderGolden(src)) write(join(GOLDEN_DIR, `${size}.png`), png);
  console.log(`updated goldens in ${GOLDEN_DIR}`);
}

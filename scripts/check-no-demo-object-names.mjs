import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const checkedRoots = ["src"];
const skippedDirs = new Set(["node_modules", "dist", ".git", "src/generated"]);
const pattern = /\b(?:the_dubspace|the_taskspace|the_chatroom|slot_[1-4]|channel_1|filter_1|delay_1|drum_1|default_scene)\b/g;
const hits = [];

function walk(path) {
  const rel = relative(root, path);
  if (skippedDirs.has(rel)) return;
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) walk(join(path, entry));
    return;
  }
  if (!/\.(ts|tsx|js|mjs|css|html)$/.test(path)) return;
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    pattern.lastIndex = 0;
    if (pattern.test(line)) hits.push(`${rel}:${index + 1}: ${line.trim()}`);
  }
}

for (const dir of checkedRoots) walk(join(root, dir));

if (hits.length > 0) {
  console.error("Demo object names must live in catalogs/specs/tests, not implementation source:");
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}

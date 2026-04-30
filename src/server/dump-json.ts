import { dumpSerializedObjectsToJsonFolder, dumpSerializedWorldToJsonFolder } from "./json-folder-repository";
import { LocalSQLiteRepository } from "./sqlite-repository";

const args = parseArgs(process.argv.slice(2));
const db = args.db ?? ".woo/dev.sqlite";
const out = args.out ?? ".woo/json-dump";
const objects = args.object ?? [];

const repo = new LocalSQLiteRepository(db);
try {
  const world = repo.load();
  if (!world) {
    console.error(`No Woo world found in ${db}`);
    process.exit(1);
  }
  const manifest = objects.length > 0 ? dumpSerializedObjectsToJsonFolder(world, out, objects) : dumpSerializedWorldToJsonFolder(world, out);
  console.log(JSON.stringify({ out, partial: manifest.partial, objects: manifest.objects.length, logs: manifest.logs.length, snapshots: manifest.snapshots.length }, null, 2));
} finally {
  repo.close();
}

function parseArgs(argv: string[]): { db?: string; out?: string; object?: string[] } {
  const parsed: { db?: string; out?: string; object?: string[] } = { object: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") parsed.db = argv[++i];
    else if (arg === "--out") parsed.out = argv[++i];
    else if (arg === "--object") parsed.object!.push(argv[++i]);
    else if (arg === "--objects") parsed.object!.push(...argv[++i].split(",").map((item) => item.trim()).filter(Boolean));
    else if (arg === "--help") usage(0);
    else usage(1, `unknown argument: ${arg}`);
  }
  return parsed;
}

function usage(code: number, message?: string): never {
  if (message) console.error(message);
  console.error("usage: npm run dump:json -- [--db .woo/dev.sqlite] [--out .woo/json-dump] [--object delay_1] [--objects delay_1,drum_1]");
  process.exit(code);
}


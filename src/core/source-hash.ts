import { createHash } from "node:crypto";

export function hashSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

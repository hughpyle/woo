import { hashSource } from "./bootstrap";
import type { CompileResult, InstallResult, ObjRef, TinyBytecode, WooValue } from "./types";
import { wooError } from "./types";
import type { WooWorld } from "./world";

type AuthoringOptions = {
  format?: "t0-source" | "t0-json-bytecode";
};

export function compileVerb(source: string, options: AuthoringOptions = {}): CompileResult {
  const format = options.format ?? inferFormat(source);
  if (format === "t0-json-bytecode") {
    try {
      const bytecode = JSON.parse(source) as TinyBytecode;
      verifyBytecode(bytecode);
      return { ok: true, diagnostics: [], bytecode, source_hash: hashSource(source) };
    } catch (err) {
      return {
        ok: false,
        diagnostics: [{ severity: "error", code: "E_COMPILE", message: err instanceof Error ? err.message : String(err) }]
      };
    }
  }
  return compileT0Source(source);
}

export function installVerb(world: WooWorld, obj: ObjRef, name: string, source: string, expectedVersion: number | null, options: AuthoringOptions = {}): InstallResult {
  const target = world.object(obj);
  const current = target.verbs.get(name);
  if ((current?.version ?? null) !== expectedVersion) {
    throw wooError("E_VERSION", "verb version conflict", { expected: expectedVersion, actual: current?.version ?? null });
  }
  const compiled = compileVerb(source, options);
  if (!compiled.ok || !compiled.bytecode) return { ok: false, version: current?.version ?? 0, diagnostics: compiled.diagnostics };
  const version = (current?.version ?? 0) + 1;
  world.addVerb(obj, {
    kind: "bytecode",
    name,
    aliases: [],
    owner: target.owner,
    perms: "rxd",
    arg_spec: {},
    source,
    source_hash: compiled.source_hash ?? hashSource(source),
    bytecode: { ...compiled.bytecode, version },
    version,
    line_map: {}
  });
  return { ok: true, version };
}

export function definePropertyVersioned(world: WooWorld, obj: ObjRef, name: string, defaultValue: WooValue, perms: string, expectedVersion: number | null, typeHint?: string) {
  const target = world.object(obj);
  const current = target.propertyDefs.get(name);
  if ((current?.version ?? null) !== expectedVersion) {
    throw wooError("E_VERSION", "property definition version conflict", { expected: expectedVersion, actual: current?.version ?? null });
  }
  return world.defineProperty(obj, {
    name,
    defaultValue,
    perms,
    owner: target.owner,
    typeHint,
    version: (current?.version ?? 0) + 1
  });
}

function inferFormat(source: string): "t0-source" | "t0-json-bytecode" {
  return source.trim().startsWith("{") ? "t0-json-bytecode" : "t0-source";
}

function verifyBytecode(bytecode: TinyBytecode): void {
  if (!bytecode || !Array.isArray(bytecode.ops) || !Array.isArray(bytecode.literals)) {
    throw new Error("invalid TinyBytecode shape");
  }
  for (const [op] of bytecode.ops) {
    if (!VALID_OPS.has(op)) throw new Error(`unknown opcode ${op}`);
  }
}

function compileT0Source(source: string): CompileResult {
  // First-light parser: intentionally matches the demo verb pattern
  // (simple this.prop assignments, one observe map, one return).
  // The full T0 source parser belongs with the next compiler milestone.
  try {
    const header = source.match(/verb\s+:?([A-Za-z_][\w]*)\s*\(([^)]*)\)/);
    if (!header) throw new Error("expected `verb :name(args) { ... }` header");
    const args = header[2].split(",").map((arg) => arg.trim()).filter(Boolean);
    const ops: TinyBytecode["ops"] = [];
    const literals: WooValue[] = [];
    const lit = (value: WooValue) => {
      const idx = literals.findIndex((item) => JSON.stringify(item) === JSON.stringify(value));
      if (idx >= 0) return idx;
      literals.push(value);
      return literals.length - 1;
    };
    const pushExpr = (expr: string) => {
      const trimmed = expr.trim();
      const argIndex = args.indexOf(trimmed);
      if (argIndex >= 0) ops.push(["PUSH_ARG", argIndex]);
      else if (trimmed === "this") ops.push(["PUSH_THIS"]);
      else if (trimmed === "actor") ops.push(["PUSH_ACTOR"]);
      else if (trimmed === "space") ops.push(["PUSH_SPACE"]);
      else if (trimmed === "seq") ops.push(["PUSH_SEQ"]);
      else if (trimmed === "message") ops.push(["PUSH_MESSAGE"]);
      else if (/^".*"$/.test(trimmed)) ops.push(["PUSH_LIT", lit(JSON.parse(trimmed))]);
      else if (/^-?\d+(\.\d+)?$/.test(trimmed)) ops.push(["PUSH_LIT", lit(Number(trimmed))]);
      else if (trimmed === "true" || trimmed === "false") ops.push(["PUSH_LIT", lit(trimmed === "true")]);
      else if (trimmed === "null") ops.push(["PUSH_LIT", lit(null)]);
      else throw new Error(`unsupported expression: ${trimmed}`);
    };

    const assignmentRe = /this\.([A-Za-z_][\w]*)\s*=\s*([^;]+);/g;
    for (const match of source.matchAll(assignmentRe)) {
      ops.push(["PUSH_THIS"], ["PUSH_LIT", lit(match[1])]);
      pushExpr(match[2]);
      ops.push(["SET_PROP"]);
    }

    const observe = source.match(/observe\s*\(\s*\{([\s\S]*?)\}\s*\)\s*;/);
    if (observe) {
      const pairs = observe[1]
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => part.match(/^"([^"]+)"\s*:\s*(.+)$/))
        .filter((match): match is RegExpMatchArray => Boolean(match));
      for (const pair of pairs) {
        ops.push(["PUSH_LIT", lit(pair[1])]);
        pushExpr(pair[2]);
      }
      ops.push(["MAKE_MAP", pairs.length], ["OBSERVE"]);
    }

    const ret = source.match(/return\s+([^;]+);/);
    if (ret) pushExpr(ret[1]);
    else ops.push(["PUSH_LIT", lit(null)]);
    ops.push(["RETURN"]);

    const bytecode: TinyBytecode = { ops, literals, num_locals: 0, max_stack: 8, version: 1 };
    verifyBytecode(bytecode);
    return { ok: true, diagnostics: [], bytecode, source_hash: hashSource(source) };
  } catch (err) {
    return {
      ok: false,
      diagnostics: [{ severity: "error", code: "E_COMPILE", message: err instanceof Error ? err.message : String(err), span: { line: 1, column: 0 } }]
    };
  }
}

const VALID_OPS = new Set([
  "PUSH_LIT",
  "PUSH_LOCAL",
  "POP_LOCAL",
  "PUSH_THIS",
  "PUSH_ACTOR",
  "PUSH_SPACE",
  "PUSH_SEQ",
  "PUSH_MESSAGE",
  "PUSH_ARG",
  "POP",
  "DUP",
  "MAP_GET",
  "MAKE_MAP",
  "MAKE_LIST",
  "EQ",
  "GET_PROP",
  "SET_PROP",
  "OBSERVE",
  "JUMP",
  "JUMP_IF_FALSE",
  "RETURN",
  "FAIL"
]);

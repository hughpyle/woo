import { compileWooSource } from "./dsl-compiler";
import { hashSource } from "./source-hash";
import type { CompileResult, InstallResult, ObjRef, TinyBytecode, WooValue } from "./types";
import { isErrorValue, wooError } from "./types";
import { normalizeVerbPerms } from "./verb-perms";
import type { WooWorld } from "./world";

type AuthoringOptions = {
  format?: "t0-source" | "woo-source" | "t0-json-bytecode";
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
        diagnostics: [compileDiagnostic(err)]
      };
    }
  }
  const compiled = compileWooSource(source);
  if (!compiled.ok || !compiled.bytecode) return compiled;
  try {
    verifyBytecode(compiled.bytecode);
    return compiled;
  } catch (err) {
    return { ok: false, diagnostics: [compileDiagnostic(err)] };
  }
}

export function installVerb(world: WooWorld, obj: ObjRef, name: string, source: string, expectedVersion: number | null, options: AuthoringOptions = {}): InstallResult {
  const target = world.object(obj);
  return installVerbWithOwner(world, obj, name, source, expectedVersion, target.owner, options);
}

export function installVerbAs(world: WooWorld, actor: ObjRef, obj: ObjRef, name: string, source: string, expectedVersion: number | null, options: AuthoringOptions = {}): InstallResult {
  world.assertCanAuthorObject(actor, obj);
  return installVerbWithOwner(world, obj, name, source, expectedVersion, actor, options);
}

function installVerbWithOwner(world: WooWorld, obj: ObjRef, name: string, source: string, expectedVersion: number | null, owner: ObjRef, options: AuthoringOptions = {}): InstallResult {
  const target = world.object(obj);
  world.object(owner);
  const current = target.verbs.get(name);
  if ((current?.version ?? null) !== expectedVersion) {
    throw wooError("E_VERSION", "verb version conflict", { expected: expectedVersion, actual: current?.version ?? null });
  }
  const compiled = compileVerb(source, options);
  if (!compiled.ok || !compiled.bytecode) return { ok: false, version: current?.version ?? 0, diagnostics: compiled.diagnostics };
  if (compiled.metadata?.name && compiled.metadata.name !== name) {
    return {
      ok: false,
      version: current?.version ?? 0,
      diagnostics: [{ severity: "error", code: "E_COMPILE", message: `verb header names :${compiled.metadata.name}, but install target is :${name}` }]
    };
  }
  const version = (current?.version ?? 0) + 1;
  const parsedPerms = normalizeVerbPerms(
    compiled.metadata?.perms ?? current?.perms ?? "rx",
    compiled.metadata?.perms ? false : current?.direct_callable === true
  );
  world.addVerb(obj, {
    kind: "bytecode",
    name,
    aliases: [],
    owner,
    perms: parsedPerms.perms,
    arg_spec: compiled.metadata?.arg_spec ?? current?.arg_spec ?? {},
    direct_callable: parsedPerms.directCallable,
    source,
    source_hash: compiled.source_hash ?? hashSource(source),
    bytecode: { ...compiled.bytecode, version },
    version,
    line_map: compiled.line_map ?? {}
  });
  return { ok: true, version };
}

export function definePropertyVersioned(world: WooWorld, obj: ObjRef, name: string, defaultValue: WooValue, perms: string, expectedVersion: number | null, typeHint?: string) {
  const target = world.object(obj);
  return definePropertyVersionedWithOwner(world, obj, name, defaultValue, perms, expectedVersion, target.owner, typeHint);
}

export function definePropertyVersionedAs(world: WooWorld, actor: ObjRef, obj: ObjRef, name: string, defaultValue: WooValue, perms: string, expectedVersion: number | null, typeHint?: string) {
  world.assertCanAuthorObject(actor, obj);
  return definePropertyVersionedWithOwner(world, obj, name, defaultValue, perms, expectedVersion, actor, typeHint);
}

function definePropertyVersionedWithOwner(world: WooWorld, obj: ObjRef, name: string, defaultValue: WooValue, perms: string, expectedVersion: number | null, owner: ObjRef, typeHint?: string) {
  const target = world.object(obj);
  const current = target.propertyDefs.get(name);
  if ((current?.version ?? null) !== expectedVersion) {
    throw wooError("E_VERSION", "property definition version conflict", { expected: expectedVersion, actual: current?.version ?? null });
  }
  return world.defineProperty(obj, {
    name,
    defaultValue,
    perms,
    owner,
    typeHint,
    version: (current?.version ?? 0) + 1
  });
}

export function setPropertyValueVersionedAs(world: WooWorld, actor: ObjRef, obj: ObjRef, name: string, value: WooValue, expectedVersion: number | null = null) {
  world.assertCanAuthorObject(actor, obj);
  const current = world.object(obj).propertyVersions.get(name) ?? null;
  if (expectedVersion !== null && current !== expectedVersion) {
    throw wooError("E_VERSION", "property value version conflict", { expected: expectedVersion, actual: current });
  }
  world.setProp(obj, name, value);
  return world.propertyInfo(obj, name);
}

function inferFormat(source: string): "t0-source" | "t0-json-bytecode" {
  return source.trim().startsWith("{") ? "t0-json-bytecode" : "t0-source";
}

function verifyBytecode(bytecode: TinyBytecode): void {
  if (!bytecode || !Array.isArray(bytecode.ops) || !Array.isArray(bytecode.literals)) {
    throw wooError("E_COMPILE", "invalid TinyBytecode shape");
  }
  for (const [op] of bytecode.ops) {
    if (!VALID_OPS.has(op)) throw wooError("E_COMPILE", `unknown opcode ${op}`);
  }
}

function compileDiagnostic(err: unknown): CompileResult["diagnostics"][number] {
  if (isErrorValue(err)) return { severity: "error", code: err.code, message: err.message ?? err.code };
  return { severity: "error", code: "E_COMPILE", message: err instanceof Error ? err.message : String(err) };
}

const VALID_OPS = new Set([
  "PUSH_LIT",
  "PUSH_INT",
  "PUSH_LOCAL",
  "POP_LOCAL",
  "PUSH_THIS",
  "PUSH_ACTOR",
  "PUSH_PLAYER",
  "PUSH_CALLER",
  "PUSH_PROGR",
  "PUSH_VERB",
  "PUSH_ARGS",
  "PUSH_SPACE",
  "PUSH_SEQ",
  "PUSH_MESSAGE",
  "PUSH_ARG",
  "POP",
  "DUP",
  "SWAP",
  "ADD",
  "SUB",
  "MUL",
  "DIV",
  "MOD",
  "NEG",
  "NOT",
  "EQ",
  "NEQ",
  "LT",
  "LE",
  "GT",
  "GE",
  "IN",
  "JUMP",
  "JUMP_IF_TRUE",
  "JUMP_IF_FALSE",
  "JUMP_IF_TRUE_KEEP",
  "JUMP_IF_FALSE_KEEP",
  "FOR_LIST_INIT",
  "FOR_LIST_NEXT",
  "FOR_RANGE_INIT",
  "FOR_RANGE_NEXT",
  "FOR_MAP_INIT",
  "FOR_MAP_NEXT",
  "FOR_END",
  "GET_PROP",
  "SET_PROP",
  "HAS_PROP",
  "DEFINE_PROP",
  "UNDEFINE_PROP",
  "PROP_INFO",
  "SET_PROP_INFO",
  "CALL_VERB",
  "PASS",
  "RETURN",
  "RAISE",
  "BUILTIN",
  "LIST_GET",
  "LIST_SET",
  "LIST_APPEND",
  "MAP_GET",
  "MAP_SET",
  "INDEX_GET",
  "INDEX_SET",
  "MAKE_MAP",
  "MAKE_LIST",
  "STR_CONCAT",
  "STR_INTERP",
  "SPLAT",
  "OBSERVE",
  "EMIT",
  "YIELD",
  "SUSPEND",
  "READ",
  "FORK",
  "TRY_PUSH",
  "TRY_POP",
  "FAIL"
]);

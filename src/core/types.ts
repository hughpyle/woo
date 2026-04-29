export type ObjRef = string;

export type WooValue =
  | null
  | boolean
  | number
  | string
  | ObjRef
  | WooValue[]
  | { [key: string]: WooValue };

export type ErrorValue = {
  code: string;
  message?: string;
  value?: WooValue;
};

export type Message = {
  actor: ObjRef;
  target: ObjRef;
  verb: string;
  args: WooValue[];
  body?: Record<string, WooValue>;
};

export type Observation = Record<string, WooValue> & {
  type: string;
};

export type AppliedFrame = {
  op: "applied";
  id?: string;
  space: ObjRef;
  seq: number;
  message: Message;
  observations: Observation[];
};

export type ErrorFrame = {
  op: "error";
  id?: string;
  error: ErrorValue;
};

export type TinyOp = [string, ...WooValue[]];

export type TinyBytecode = {
  ops: TinyOp[];
  literals: WooValue[];
  num_locals: number;
  max_stack: number;
  version: number;
};

export type VerbDef =
  | {
      kind: "bytecode";
      name: string;
      aliases: string[];
      owner: ObjRef;
      perms: string;
      arg_spec: Record<string, WooValue>;
      source: string;
      source_hash: string;
      bytecode: TinyBytecode;
      version: number;
      line_map: Record<string, WooValue>;
    }
  | {
      kind: "native";
      name: string;
      aliases: string[];
      owner: ObjRef;
      perms: string;
      arg_spec: Record<string, WooValue>;
      source: string;
      source_hash: string;
      version: number;
      line_map: Record<string, WooValue>;
      native: string;
    };

export type PropertyDef = {
  name: string;
  defaultValue: WooValue;
  typeHint?: string;
  owner: ObjRef;
  perms: string;
  version: number;
};

export type WooObject = {
  id: ObjRef;
  name: string;
  parent: ObjRef | null;
  owner: ObjRef;
  location: ObjRef | null;
  anchor: ObjRef | null;
  flags: {
    wizard?: boolean;
    programmer?: boolean;
    fertile?: boolean;
    recyclable?: boolean;
  };
  created: number;
  modified: number;
  propertyDefs: Map<string, PropertyDef>;
  properties: Map<string, WooValue>;
  propertyVersions: Map<string, number>;
  verbs: Map<string, VerbDef>;
  children: Set<ObjRef>;
  contents: Set<ObjRef>;
  eventSchemas: Map<string, Record<string, WooValue>>;
};

export type SequencedMessage = {
  space: ObjRef;
  seq: number;
  message: Message;
};

export type SpaceLogEntry = {
  space: ObjRef;
  seq: number;
  ts: number;
  actor: ObjRef;
  message: Message;
  applied_ok: boolean;
  error?: ErrorValue;
};

export type Session = {
  id: string;
  actor: ObjRef;
  started: number;
  attachedSockets: Set<string>;
};

export type CompileDiagnostic = {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  span?: {
    line: number;
    column: number;
    end_line?: number;
    end_column?: number;
  };
};

export type CompileResult = {
  ok: boolean;
  diagnostics: CompileDiagnostic[];
  bytecode?: TinyBytecode;
  source_hash?: string;
};

export type InstallResult = {
  ok: boolean;
  version: number;
  diagnostics?: CompileDiagnostic[];
};

export function wooError(code: string, message?: string, value?: WooValue): ErrorValue {
  return { code, message, value };
}

export function cloneValue<T extends WooValue>(value: T): T {
  return structuredClone(value);
}

export function valuesEqual(left: WooValue, right: WooValue): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) => key === rightKeys[index] && valuesEqual(left[key], right[key]));
  }
  return false;
}

export function assertString(value: WooValue, code = "E_TYPE"): string {
  if (typeof value !== "string") {
    throw wooError(code, "expected string", value);
  }
  return value;
}

export function assertObj(value: WooValue): ObjRef {
  if (typeof value !== "string") {
    throw wooError("E_TYPE", "expected object reference", value);
  }
  return value;
}

export function assertMap(value: WooValue): Record<string, WooValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw wooError("E_TYPE", "expected map", value);
  }
  return value as Record<string, WooValue>;
}

export function isErrorValue(value: unknown): value is ErrorValue {
  return Boolean(value && typeof value === "object" && "code" in value);
}

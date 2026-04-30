import {
  assertMap,
  assertObj,
  assertString,
  cloneValue,
  isErrorValue,
  type ErrorValue,
  type Message,
  type Observation,
  type ObjRef,
  type TinyBytecode,
  type WooValue,
  valuesEqual,
  wooError
} from "./types";
import type { CallContext } from "./world";

export type VmHandler = {
  targetPc: number;
  errors: string[];
  stackDepth: number;
};

type VmFrame = {
  ctx: CallContext;
  bytecode: TinyBytecode;
  args: WooValue[];
  stack: WooValue[];
  locals: WooValue[];
  handlers: VmHandler[];
  pc: number;
  ticksRemaining: number;
  startedAt: number;
  activeWallMs: number;
  memoryUsed: number;
};

export type SerializedVmContext = {
  space: ObjRef;
  seq: number;
  actor: ObjRef;
  player: ObjRef;
  caller: ObjRef;
  progr: ObjRef;
  thisObj: ObjRef;
  verbName: string;
  definer: ObjRef;
  message: Message;
  observations?: Observation[];
};

export type SerializedVmFrame = {
  ctx: SerializedVmContext;
  bytecode: TinyBytecode;
  args: WooValue[];
  stack: WooValue[];
  locals: WooValue[];
  handlers: VmHandler[];
  pc: number;
  ticksRemaining: number;
  startedAt: number;
  activeWallMs?: number;
  memoryUsed: number;
};

export type SerializedVmTask = {
  version: 1;
  frames: SerializedVmFrame[];
};

export type VmRunResult = {
  result: WooValue;
  observations: Observation[];
};

export class VmSuspendSignal {
  readonly kind = "vm_suspend";

  constructor(
    readonly seconds: number,
    readonly task: SerializedVmTask
  ) {}
}

export class VmReadSignal {
  readonly kind = "vm_read";

  constructor(
    readonly player: ObjRef,
    readonly task: SerializedVmTask
  ) {}
}

export function isVmSuspendSignal(value: unknown): value is VmSuspendSignal {
  return value instanceof VmSuspendSignal;
}

export function isVmReadSignal(value: unknown): value is VmReadSignal {
  return value instanceof VmReadSignal;
}

const DEFAULT_TICKS = 100_000;
const DEFAULT_MEMORY = 4 * 1024 * 1024;
const DEFAULT_WALL_MS = 10_000;
const MAX_VM_FRAMES = 128;
const BUILTIN_NAMES = ["length", "keys", "values", "has", "typeof", "to_string", "min", "max", "floor", "ceil", "round", "abs"];

export function runTinyVm(ctx: CallContext, bytecode: TinyBytecode, args: WooValue[]): WooValue {
  return runVmFrames([makeFrame(ctx, bytecode, args)]).result;
}

export function createSerializedTinyVmTask(ctx: CallContext, bytecode: TinyBytecode, args: WooValue[]): SerializedVmTask {
  return serializeVmFrames([makeFrame(ctx, bytecode, args)]);
}

export function runSerializedTinyVmTask(world: CallContext["world"], task: SerializedVmTask, observations: Observation[] = []): VmRunResult {
  if (task.version !== 1) throw wooError("E_VERSION", "unsupported serialized VM task version", task.version);
  return runVmFrames(task.frames.map((item) => hydrateVmFrame(world, item, observations)));
}

export function runSerializedTinyVmTaskWithInput(
  world: CallContext["world"],
  task: SerializedVmTask,
  input: WooValue,
  observations: Observation[] = []
): VmRunResult {
  const resumed = structuredClone(task);
  const top = resumed.frames[resumed.frames.length - 1];
  if (!top) throw wooError("E_INTERNAL", "serialized VM task has no frames");
  top.stack.push(cloneValue(input));
  return runSerializedTinyVmTask(world, resumed, observations);
}

function runVmFrames(frames: VmFrame[]): VmRunResult {
  const observations = frames[0]?.ctx.observations ?? [];
  let result: WooValue = null;

  const frame = (): VmFrame => {
    const current = frames[frames.length - 1];
    if (!current) throw wooError("E_INTERNAL", "VM has no current frame");
    return current;
  };

  const pop = (): WooValue => {
    const stack = frame().stack;
    if (stack.length === 0) throw wooError("E_RANGE", "stack underflow");
    return stack.pop()!;
  };
  const peek = (): WooValue => {
    const stack = frame().stack;
    if (stack.length === 0) throw wooError("E_RANGE", "stack underflow");
    return stack[stack.length - 1];
  };
  const push = (value: WooValue): void => {
    frame().stack.push(cloneValue(value));
  };
  const jump = (currentPc: number, offset: WooValue): void => {
    frame().pc = currentPc + numeric(offset, "jump offset") + 1;
  };
  const allocate = (value: WooValue): WooValue => {
    const current = frame();
    // Memory accounting is intentionally monotone within a task. Popping a
    // value does not refund budget, matching the VM spec's exhaustion model.
    current.memoryUsed += estimateSize(value);
    if (current.memoryUsed > (current.bytecode.max_memory ?? DEFAULT_MEMORY)) throw wooError("E_MEM", "VM memory budget exceeded");
    return value;
  };
  const raise = (error: ErrorValue): boolean => {
    while (frames.length > 0) {
      const current = frame();
      while (current.handlers.length > 0) {
        const handler = current.handlers.pop()!;
        if (handler.errors.length !== 0 && !handler.errors.includes(error.code)) continue;
        current.stack.length = handler.stackDepth;
        current.stack.push(cloneValue(error as WooValue));
        current.pc = handler.targetPc;
        return true;
      }
      frames.pop();
    }
    return false;
  };
  const pushFrame = (callCtx: CallContext, callBytecode: TinyBytecode, callArgs: WooValue[]): void => {
    if (frames.length >= MAX_VM_FRAMES) throw wooError("E_CALL_DEPTH", "maximum VM frame depth exceeded");
    frames.push(makeFrame(callCtx, callBytecode, callArgs));
  };
  const returnFromFrame = (value: WooValue): void => {
    frames.pop();
    if (frames.length === 0) {
      result = cloneValue(value);
      return;
    }
    push(value);
  };
  const callVerb = (obj: string, name: string, callArgs: WooValue[], startAt?: string | null): void => {
    const caller = frame();
    const { definer, verb } = startAt === undefined ? caller.ctx.world.resolveVerb(obj, name) : caller.ctx.world.resolveVerbFrom(startAt, name);
    const callCtx: CallContext = {
      ...caller.ctx,
      thisObj: obj,
      verbName: name,
      definer,
      progr: verb.owner,
      player: caller.ctx.player ?? caller.ctx.actor,
      caller: caller.ctx.thisObj
    };
    if (verb.kind === "native") {
      const value = caller.ctx.world.dispatch({ ...caller.ctx, caller: caller.ctx.thisObj }, obj, name, callArgs, startAt);
      push(value);
      return;
    }
    pushFrame(callCtx, verb.bytecode, callArgs);
  };

  while (frames.length > 0) {
    const current = frame();
    if (current.pc >= current.bytecode.ops.length) {
      returnFromFrame(null);
      continue;
    }

    const currentPc = current.pc;
    const [op, operand, operand2, operand3] = current.bytecode.ops[current.pc];
    current.pc += 1;
    try {
      current.ticksRemaining -= tickWeight(op);
      if (current.ticksRemaining < 0) throw wooError("E_TICKS", "VM tick budget exceeded");
      if (current.activeWallMs + Date.now() - current.startedAt > (current.bytecode.max_wall_ms ?? DEFAULT_WALL_MS)) {
        throw wooError("E_TIMEOUT", "VM wall-time budget exceeded");
      }

      switch (op) {
        case "PUSH_LIT":
          push(literal(current.bytecode, operand));
          break;
        case "PUSH_INT":
          push(numeric(operand, "inline integer"));
          break;
        case "PUSH_LOCAL":
          push(current.locals[localIndex(operand, current.locals.length)] ?? null);
          break;
        case "POP_LOCAL":
          current.locals[localIndex(operand, current.locals.length)] = pop();
          break;
        case "PUSH_THIS":
          push(current.ctx.thisObj);
          break;
        case "PUSH_ACTOR":
          push(current.ctx.actor);
          break;
        case "PUSH_PLAYER":
          push(current.ctx.player ?? current.ctx.actor);
          break;
        case "PUSH_CALLER":
          push(current.ctx.caller);
          break;
        case "PUSH_PROGR":
          push(current.ctx.progr);
          break;
        case "PUSH_VERB":
          push(current.ctx.verbName);
          break;
        case "PUSH_ARGS":
          push(current.args);
          break;
        case "PUSH_SPACE":
          push(current.ctx.space);
          break;
        case "PUSH_SEQ":
          push(current.ctx.seq);
          break;
        case "PUSH_MESSAGE":
          push(current.ctx.message as unknown as WooValue);
          break;
        case "PUSH_ARG":
          push(current.args[numeric(operand, "arg index")] ?? null);
          break;
        case "POP":
          pop();
          break;
        case "DUP":
          push(peek());
          break;
        case "SWAP": {
          const right = pop();
          const left = pop();
          push(right);
          push(left);
          break;
        }

        case "ADD":
          binaryArithmetic("ADD");
          break;
        case "SUB":
          numericBinary((left, right) => left - right);
          break;
        case "MUL":
          multiply();
          break;
        case "DIV":
          divide();
          break;
        case "MOD":
          numericBinary((left, right) => {
            if (right === 0) throw wooError("E_DIV", "division by zero");
            return left % right;
          });
          break;
        case "NEG":
          push(-numeric(pop(), "operand"));
          break;
        case "NOT":
          push(!truthy(pop()));
          break;
        case "EQ": {
          const right = pop();
          const left = pop();
          push(valuesEqual(left, right));
          break;
        }
        case "NEQ": {
          const right = pop();
          const left = pop();
          push(!valuesEqual(left, right));
          break;
        }
        case "LT":
          compare((left, right) => left < right);
          break;
        case "LE":
          compare((left, right) => left <= right);
          break;
        case "GT":
          compare((left, right) => left > right);
          break;
        case "GE":
          compare((left, right) => left >= right);
          break;
        case "IN":
          membership();
          break;

        case "JUMP":
          jump(currentPc, operand);
          break;
        case "JUMP_IF_TRUE": {
          const value = pop();
          if (truthy(value)) jump(currentPc, operand);
          break;
        }
        case "JUMP_IF_FALSE": {
          const value = pop();
          if (!truthy(value)) jump(currentPc, operand);
          break;
        }
        case "JUMP_IF_TRUE_KEEP":
          if (truthy(peek())) jump(currentPc, operand);
          break;
        case "JUMP_IF_FALSE_KEEP":
          if (!truthy(peek())) jump(currentPc, operand);
          break;

        case "FOR_LIST_INIT": {
          const list = assertList(pop());
          push(list);
          push(0);
          current.locals[localIndex(operand, current.locals.length)] = null;
          break;
        }
        case "FOR_LIST_NEXT": {
          const index = numeric(peek(), "list iterator index");
          const list = assertList(current.stack[current.stack.length - 2]);
          if (index >= list.length) {
            jump(currentPc, operand2);
          } else {
            current.locals[localIndex(operand, current.locals.length)] = cloneValue(list[index]);
            current.stack[current.stack.length - 1] = index + 1;
          }
          break;
        }
        case "FOR_RANGE_INIT": {
          const lo = numeric(pop(), "range low");
          const hi = numeric(pop(), "range high");
          push(hi);
          push(lo);
          current.locals[localIndex(operand, current.locals.length)] = lo;
          break;
        }
        case "FOR_RANGE_NEXT": {
          const next = numeric(peek(), "range iterator value");
          const hi = numeric(current.stack[current.stack.length - 2], "range high");
          if (next > hi) {
            jump(currentPc, operand2);
          } else {
            current.locals[localIndex(operand, current.locals.length)] = next;
            current.stack[current.stack.length - 1] = next + 1;
          }
          break;
        }
        case "FOR_MAP_INIT": {
          const map = assertMap(pop());
          push(map);
          push(0);
          break;
        }
        case "FOR_MAP_NEXT": {
          const index = numeric(peek(), "map iterator index");
          const map = assertMap(current.stack[current.stack.length - 2]);
          const entries = Object.entries(map);
          if (index >= entries.length) {
            jump(currentPc, operand3);
          } else {
            const [key, value] = entries[index];
            current.locals[localIndex(operand, current.locals.length)] = key;
            current.locals[localIndex(operand2, current.locals.length)] = cloneValue(value);
            current.stack[current.stack.length - 1] = index + 1;
          }
          break;
        }
        case "FOR_END":
          pop();
          pop();
          break;

        case "GET_PROP": {
          const name = assertString(pop());
          const obj = assertObj(pop());
          push(current.ctx.world.getProp(obj, name));
          break;
        }
        case "SET_PROP": {
          const value = pop();
          const name = assertString(pop());
          const obj = assertObj(pop());
          current.ctx.world.setProp(obj, name, value);
          break;
        }
        case "HAS_PROP": {
          const name = assertString(pop());
          const obj = assertObj(pop());
          push(current.ctx.world.properties(obj).includes(name));
          break;
        }
        case "DEFINE_PROP": {
          const perms = assertString(pop());
          const defaultValue = pop();
          const name = assertString(pop());
          const obj = assertObj(pop());
          current.ctx.world.defineProperty(obj, { name, defaultValue, perms, owner: current.ctx.progr });
          break;
        }
        case "UNDEFINE_PROP": {
          const name = assertString(pop());
          const obj = current.ctx.world.object(assertObj(pop()));
          obj.propertyDefs.delete(name);
          obj.properties.delete(name);
          obj.propertyVersions.delete(name);
          break;
        }
        case "PROP_INFO": {
          const name = assertString(pop());
          const obj = assertObj(pop());
          push(current.ctx.world.propertyInfo(obj, name) as WooValue);
          break;
        }
        case "SET_PROP_INFO": {
          const info = assertMap(pop());
          const name = assertString(pop());
          const obj = assertObj(pop());
          const currentInfo = assertMap(current.ctx.world.propertyInfo(obj, name) as WooValue);
          const definedOn = assertObj(currentInfo.defined_on);
          const def = current.ctx.world.object(definedOn).propertyDefs.get(name);
          if (!def) throw wooError("E_PROPNF", `property not found: ${name}`, name);
          if (typeof info.owner === "string") def.owner = info.owner;
          if (typeof info.perms === "string") def.perms = info.perms;
          if (typeof info.type_hint === "string") def.typeHint = info.type_hint;
          def.version += 1;
          break;
        }

        case "CALL_VERB": {
          const callArgs = popArgs(numeric(operand, "argc"));
          const name = assertString(pop());
          const obj = assertObj(pop());
          callVerb(obj, name, callArgs);
          break;
        }
        case "PASS": {
          const callArgs = popArgs(numeric(operand, "argc"));
          const parent = current.ctx.world.object(current.ctx.definer).parent;
          if (!parent) throw wooError("E_VERBNF", `no parent verb for ${current.ctx.verbName}`);
          callVerb(current.ctx.thisObj, current.ctx.verbName, callArgs, parent);
          break;
        }
        case "RETURN": {
          const value = pop();
          returnFromFrame(value);
          break;
        }
        case "RAISE":
        case "FAIL": {
          const error = errorFromValue(pop());
          throw error;
        }
        case "BUILTIN": {
          const builtinArgs = popArgs(numeric(operand2, "builtin argc"));
          push(callBuiltin(operand, builtinArgs));
          break;
        }

        case "LIST_GET": {
          const index = oneBasedIndex(pop());
          const list = assertList(pop());
          if (index < 0 || index >= list.length) throw wooError("E_RANGE", "list index out of range", index + 1);
          push(list[index]);
          break;
        }
        case "LIST_SET": {
          const value = pop();
          const index = oneBasedIndex(pop());
          const list = assertList(pop());
          if (index < 0 || index >= list.length) throw wooError("E_RANGE", "list index out of range", index + 1);
          const next = [...list];
          next[index] = value;
          push(allocate(next));
          break;
        }
        case "LIST_APPEND": {
          const value = pop();
          const list = assertList(pop());
          push(allocate([...list, value]));
          break;
        }
        case "MAP_GET": {
          const key = assertString(pop());
          const map = assertMap(pop());
          if (!(key in map)) throw wooError("E_PROPNF", `map key not found: ${key}`);
          push(map[key]);
          break;
        }
        case "MAP_SET": {
          const value = pop();
          const key = assertString(pop());
          const map = assertMap(pop());
          push(allocate({ ...map, [key]: value }));
          break;
        }
        case "INDEX_GET": {
          const key = pop();
          const collection = pop();
          if (Array.isArray(collection)) {
            const index = oneBasedIndex(key);
            if (index < 0 || index >= collection.length) throw wooError("E_RANGE", "list index out of range", index + 1);
            push(collection[index]);
          } else {
            const map = assertMap(collection);
            const mapKey = assertString(key);
            if (!(mapKey in map)) throw wooError("E_PROPNF", `map key not found: ${mapKey}`);
            push(map[mapKey]);
          }
          break;
        }
        case "INDEX_SET": {
          const value = pop();
          const key = pop();
          const collection = pop();
          if (Array.isArray(collection)) {
            const index = oneBasedIndex(key);
            if (index < 0 || index >= collection.length) throw wooError("E_RANGE", "list index out of range", index + 1);
            const next = [...collection];
            next[index] = value;
            push(allocate(next));
          } else {
            const map = assertMap(collection);
            const mapKey = assertString(key);
            push(allocate({ ...map, [mapKey]: value }));
          }
          break;
        }
        case "MAKE_MAP": {
          const count = numeric(operand, "map entry count");
          const entries: [string, WooValue][] = [];
          for (let i = 0; i < count; i++) {
            const value = pop();
            const key = assertString(pop());
            entries.unshift([key, value]);
          }
          push(allocate(Object.fromEntries(entries)));
          break;
        }
        case "MAKE_LIST": {
          const count = numeric(operand, "list count");
          const values: WooValue[] = [];
          for (let i = 0; i < count; i++) values.unshift(pop());
          push(allocate(values));
          break;
        }
        case "STR_CONCAT":
        case "STR_INTERP": {
          const count = numeric(operand, "string count");
          const parts: string[] = [];
          for (let i = 0; i < count; i++) parts.unshift(assertString(pop()));
          push(allocate(parts.join("")));
          break;
        }
        case "SPLAT": {
          const list = assertList(pop());
          for (const value of list) push(value);
          break;
        }

        case "OBSERVE": {
          const event = assertMap(pop());
          const type = assertString(event.type);
          current.ctx.observe({ ...event, type });
          break;
        }
        case "EMIT": {
          const event = assertMap(pop());
          const target = pop();
          const type = assertString(event.type);
          current.ctx.observe({ target, ...event, type });
          break;
        }
        case "YIELD":
          break;
        case "FORK": {
          const forkArgs = popArgs(numeric(operand, "argc"));
          const verbName = assertString(pop());
          const obj = assertObj(pop());
          const seconds = numeric(pop(), "fork delay");
          push(current.ctx.world.scheduleFork(current.ctx, seconds, obj, verbName, forkArgs));
          break;
        }
        case "SUSPEND": {
          const seconds = numeric(pop(), "suspend delay");
          push(0);
          throw new VmSuspendSignal(seconds, serializeVmFrames(frames));
        }
        case "READ": {
          const player = assertObj(pop());
          throw new VmReadSignal(player, serializeVmFrames(frames));
        }

        case "TRY_PUSH": {
          const errorsValue = operand2 === undefined ? [] : literal(current.bytecode, operand2);
          const errors = Array.isArray(errorsValue) ? errorsValue.map((value) => assertString(value)) : [];
          current.handlers.push({ targetPc: currentPc + numeric(operand, "catch offset") + 1, errors, stackDepth: current.stack.length });
          break;
        }
        case "TRY_POP":
          if (!current.handlers.pop()) throw wooError("E_RANGE", "handler stack underflow");
          break;

        default:
          throw wooError("E_INVARG", `unknown VM opcode: ${op}`);
      }
    } catch (err) {
      if (isVmSuspendSignal(err)) throw err;
      if (isVmReadSignal(err)) throw err;
      const error = attachVmTrace(normalizeVmError(err), frames, currentPc);
      if (!raise(error)) throw error;
    }
  }

  return { result, observations };

  function popArgs(count: number): WooValue[] {
    const values: WooValue[] = [];
    for (let i = 0; i < count; i++) values.unshift(pop());
    return values;
  }

  function binaryArithmetic(op: "ADD"): void {
    const right = pop();
    const left = pop();
    if (typeof left === "number" && typeof right === "number") {
      push(left + right);
    } else if (typeof left === "string" && typeof right === "string") {
      push(allocate(left + right));
    } else if (Array.isArray(left) && Array.isArray(right)) {
      push(allocate([...left, ...right]));
    } else {
      throw wooError("E_TYPE", `${op} operands are incompatible`, { left, right });
    }
  }

  function numericBinary(fn: (left: number, right: number) => number): void {
    const right = numeric(pop(), "right operand");
    const left = numeric(pop(), "left operand");
    push(fn(left, right));
  }

  function multiply(): void {
    const right = pop();
    const left = pop();
    if (typeof left === "number" && typeof right === "number") {
      push(left * right);
    } else if (typeof left === "number" && typeof right === "string" && Number.isInteger(left)) {
      push(allocate(right.repeat(Math.max(0, left))));
    } else if (typeof left === "string" && typeof right === "number" && Number.isInteger(right)) {
      push(allocate(left.repeat(Math.max(0, right))));
    } else {
      throw wooError("E_TYPE", "MUL operands are incompatible", { left, right });
    }
  }

  function divide(): void {
    const right = numeric(pop(), "right operand");
    const left = numeric(pop(), "left operand");
    if (right === 0) throw wooError("E_DIV", "division by zero");
    push(Number.isInteger(left) && Number.isInteger(right) ? Math.trunc(left / right) : left / right);
  }

  function compare(fn: (left: number | string, right: number | string) => boolean): void {
    const right = pop();
    const left = pop();
    if (typeof left === "number" && typeof right === "number") push(fn(left, right));
    else if (typeof left === "string" && typeof right === "string") push(fn(left, right));
    else throw wooError("E_TYPE", "comparison operands are incompatible", { left, right });
  }

  function membership(): void {
    const haystack = pop();
    const needle = pop();
    if (Array.isArray(haystack)) {
      push(haystack.some((value) => valuesEqual(value, needle)));
      return;
    }
    if (haystack !== null && typeof haystack === "object" && !Array.isArray(haystack)) {
      push(typeof needle === "string" && needle in haystack);
      return;
    }
    throw wooError("E_TYPE", "IN requires list or map haystack", haystack);
  }

  function callBuiltin(nameOrIndex: WooValue | undefined, builtinArgs: WooValue[]): WooValue {
    const name = typeof nameOrIndex === "number" ? BUILTIN_NAMES[nameOrIndex] : assertString(nameOrIndex ?? "");
    switch (name) {
      case "length": {
        const value = builtinArgs[0];
        if (typeof value === "string" || Array.isArray(value)) return value.length;
        if (value !== null && typeof value === "object") return Object.keys(value).length;
        throw wooError("E_TYPE", "length requires string, list, or map", value);
      }
      case "keys":
        return Object.keys(assertMap(builtinArgs[0]));
      case "values":
        return Object.values(assertMap(builtinArgs[0]));
      case "has": {
        const collection = builtinArgs[0];
        const key = builtinArgs[1];
        if (Array.isArray(collection)) return collection.some((value) => valuesEqual(value, key));
        if (collection !== null && typeof collection === "object") return typeof key === "string" && key in collection;
        return false;
      }
      case "typeof":
        return typeName(builtinArgs[0]);
      case "to_string":
        return typeof builtinArgs[0] === "string" ? builtinArgs[0] : JSON.stringify(builtinArgs[0]);
      case "min":
        return Math.min(...builtinArgs.map((value) => numeric(value, "min argument")));
      case "max":
        return Math.max(...builtinArgs.map((value) => numeric(value, "max argument")));
      case "floor":
        return Math.floor(numeric(builtinArgs[0], "floor argument"));
      case "ceil":
        return Math.ceil(numeric(builtinArgs[0], "ceil argument"));
      case "round":
        return Math.round(numeric(builtinArgs[0], "round argument"));
      case "abs":
        return Math.abs(numeric(builtinArgs[0], "abs argument"));
      default:
        throw wooError("E_INVARG", `unknown builtin: ${name}`);
    }
  }
}

function makeFrame(ctx: CallContext, bytecode: TinyBytecode, args: WooValue[]): VmFrame {
  const locals = new Array<WooValue>(bytecode.num_locals).fill(null);
  for (let i = 0; i < Math.min(args.length, locals.length); i++) locals[i] = cloneValue(args[i]);
  return {
    ctx,
    bytecode,
    args: cloneValue(args as WooValue) as WooValue[],
    stack: [],
    locals,
    handlers: [],
    pc: 0,
    ticksRemaining: bytecode.max_ticks ?? DEFAULT_TICKS,
    startedAt: Date.now(),
    activeWallMs: 0,
    memoryUsed: 0
  };
}

function serializeVmFrames(frames: VmFrame[]): SerializedVmTask {
  return {
    version: 1,
    frames: frames.map(serializeVmFrame)
  };
}

function serializeVmFrame(frame: VmFrame): SerializedVmFrame {
  return {
    ctx: {
      space: frame.ctx.space,
      seq: frame.ctx.seq,
      actor: frame.ctx.actor,
      player: frame.ctx.player,
      caller: frame.ctx.caller,
      progr: frame.ctx.progr,
      thisObj: frame.ctx.thisObj,
      verbName: frame.ctx.verbName,
      definer: frame.ctx.definer,
      message: cloneValue(frame.ctx.message as unknown as WooValue) as unknown as Message,
      observations: cloneValue(frame.ctx.observations as unknown as WooValue) as unknown as Observation[]
    },
    bytecode: cloneValue(frame.bytecode as unknown as WooValue) as unknown as TinyBytecode,
    args: cloneValue(frame.args as WooValue) as WooValue[],
    stack: cloneValue(frame.stack as WooValue) as WooValue[],
    locals: cloneValue(frame.locals as WooValue) as WooValue[],
    handlers: cloneValue(frame.handlers as unknown as WooValue) as unknown as VmHandler[],
    pc: frame.pc,
    ticksRemaining: frame.ticksRemaining,
    startedAt: frame.startedAt,
    activeWallMs: frame.activeWallMs + Math.max(0, Date.now() - frame.startedAt),
    memoryUsed: frame.memoryUsed
  };
}

function hydrateVmFrame(world: CallContext["world"], frame: SerializedVmFrame, observations: Observation[]): VmFrame {
  const ctx: CallContext = {
    world,
    space: frame.ctx.space,
    seq: frame.ctx.seq,
    actor: frame.ctx.actor,
    player: frame.ctx.player,
    caller: frame.ctx.caller,
    progr: frame.ctx.progr,
    thisObj: frame.ctx.thisObj,
    verbName: frame.ctx.verbName,
    definer: frame.ctx.definer,
    message: cloneValue(frame.ctx.message as unknown as WooValue) as unknown as Message,
    observations,
    observe: (event) => {
      observations.push({ ...event, source: event.source ?? frame.ctx.space });
    }
  };
  return {
    ctx,
    bytecode: cloneValue(frame.bytecode as unknown as WooValue) as unknown as TinyBytecode,
    args: cloneValue(frame.args as WooValue) as WooValue[],
    stack: cloneValue(frame.stack as WooValue) as WooValue[],
    locals: cloneValue(frame.locals as WooValue) as WooValue[],
    handlers: cloneValue(frame.handlers as unknown as WooValue) as unknown as VmHandler[],
    pc: frame.pc,
    ticksRemaining: frame.ticksRemaining,
    startedAt: Date.now(),
    activeWallMs: frame.activeWallMs ?? 0,
    memoryUsed: frame.memoryUsed
  };
}

function tickWeight(op: string): number {
  if (op === "GET_PROP" || op === "SET_PROP") return 5;
  if (op === "CALL_VERB" || op === "PASS" || op === "EMIT") return 10;
  if (op === "MAKE_LIST" || op === "MAKE_MAP" || op === "LIST_APPEND" || op === "MAP_SET" || op === "INDEX_SET" || op === "STR_CONCAT" || op === "STR_INTERP") return 5;
  return 1;
}

function literal(bytecode: TinyBytecode, operand: WooValue | undefined): WooValue {
  const index = numeric(operand, "literal index");
  if (index < 0 || index >= bytecode.literals.length) throw wooError("E_RANGE", "literal index out of range", index);
  return bytecode.literals[index];
}

function localIndex(value: WooValue | undefined, length: number): number {
  const index = numeric(value, "local index");
  if (!Number.isInteger(index) || index < 0 || index >= length) throw wooError("E_RANGE", "local index out of range", index);
  return index;
}

function numeric(value: WooValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw wooError("E_TYPE", `${label} must be numeric`, value);
  return value;
}

function oneBasedIndex(value: WooValue): number {
  const index = numeric(value, "list index");
  if (!Number.isInteger(index)) throw wooError("E_TYPE", "list index must be integer", value);
  return index - 1;
}

function assertList(value: WooValue): WooValue[] {
  if (!Array.isArray(value)) throw wooError("E_TYPE", "expected list", value);
  return value;
}

function truthy(value: WooValue): boolean {
  return !(value === null || value === false || value === 0 || value === "");
}

function errorFromValue(value: WooValue): ErrorValue {
  if (isErrorValue(value) && typeof value.code === "string") return value;
  if (typeof value === "string") return wooError(value);
  return wooError("E_ERROR", "raised non-error value", value);
}

function normalizeVmError(err: unknown): ErrorValue {
  if (isErrorValue(err) && typeof err.code === "string") return err;
  if (err instanceof Error) return wooError("E_INTERNAL", err.message);
  return wooError("E_INTERNAL", "unknown VM error", String(err));
}

function attachVmTrace(error: ErrorValue, frames: VmFrame[], currentPc: number): ErrorValue {
  if (error.trace && error.trace.length > 0) return error;
  const trace = frames
    .map((frame, index) => vmTraceFrame(frame, index === frames.length - 1 ? currentPc : Math.max(0, frame.pc - 1)))
    .reverse();
  return { ...error, trace };
}

function vmTraceFrame(frame: VmFrame, pc: number): WooValue {
  const item: Record<string, WooValue> = {
    obj: frame.ctx.thisObj,
    verb: frame.ctx.verbName,
    definer: frame.ctx.definer,
    progr: frame.ctx.progr,
    pc
  };
  try {
    const verb = frame.ctx.world.object(frame.ctx.definer).verbs.get(frame.ctx.verbName);
    if (verb) {
      item.version = verb.version;
      const mapped = verb.line_map[String(pc)];
      if (mapped && typeof mapped === "object" && !Array.isArray(mapped)) {
        const map = mapped as Record<string, WooValue>;
        if (typeof map.line === "number") item.line = map.line;
        if (typeof map.column === "number") item.column = map.column;
        if (typeof map.end_line === "number") item.end_line = map.end_line;
        if (typeof map.end_column === "number") item.end_column = map.end_column;
      }
    }
  } catch {
    // Trace construction is diagnostic-only and must not mask the real error.
  }
  return item;
}

function typeName(value: WooValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  if (typeof value === "object") return "map";
  return typeof value;
}

function estimateSize(value: WooValue): number {
  if (value === null || typeof value === "boolean") return 8;
  if (typeof value === "number") return 8;
  if (typeof value === "string") return value.length * 2;
  if (Array.isArray(value)) return 16 + value.reduce<number>((sum, item) => sum + estimateSize(item), 0);
  return 16 + Object.entries(value as Record<string, WooValue>).reduce<number>((sum, [key, item]) => sum + key.length * 2 + estimateSize(item), 0);
}

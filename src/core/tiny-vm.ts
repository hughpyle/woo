import { assertMap, assertObj, assertString, type TinyBytecode, type WooValue, valuesEqual, wooError } from "./types";
import type { CallContext } from "./world";

export function runTinyVm(ctx: CallContext, bytecode: TinyBytecode, args: WooValue[]): WooValue {
  const stack: WooValue[] = [];
  const locals = new Array<WooValue>(bytecode.num_locals).fill(null);

  const pop = (): WooValue => {
    if (stack.length === 0) throw wooError("E_RANGE", "stack underflow");
    return stack.pop()!;
  };

  for (let pc = 0; pc < bytecode.ops.length; pc++) {
    const [op, operand] = bytecode.ops[pc];
    switch (op) {
      case "PUSH_LIT":
        stack.push(bytecode.literals[Number(operand)]);
        break;
      case "PUSH_LOCAL":
        stack.push(locals[Number(operand)]);
        break;
      case "POP_LOCAL":
        locals[Number(operand)] = pop();
        break;
      case "PUSH_THIS":
        stack.push(ctx.thisObj);
        break;
      case "PUSH_ACTOR":
        stack.push(ctx.actor);
        break;
      case "PUSH_SPACE":
        stack.push(ctx.space);
        break;
      case "PUSH_SEQ":
        stack.push(ctx.seq);
        break;
      case "PUSH_MESSAGE":
        stack.push(ctx.message as unknown as WooValue);
        break;
      case "PUSH_ARG":
        stack.push(args[Number(operand)] ?? null);
        break;
      case "POP":
        pop();
        break;
      case "DUP": {
        const value = pop();
        stack.push(value, value);
        break;
      }
      case "MAP_GET": {
        const key = assertString(pop());
        const map = assertMap(pop());
        if (!(key in map)) throw wooError("E_PROPNF", `map key not found: ${key}`);
        stack.push(map[key]);
        break;
      }
      case "MAKE_MAP": {
        const count = Number(operand);
        const entries: [string, WooValue][] = [];
        for (let i = 0; i < count; i++) {
          const value = pop();
          const key = assertString(pop());
          entries.unshift([key, value]);
        }
        stack.push(Object.fromEntries(entries));
        break;
      }
      case "MAKE_LIST": {
        const count = Number(operand);
        const values: WooValue[] = [];
        for (let i = 0; i < count; i++) values.unshift(pop());
        stack.push(values);
        break;
      }
      case "EQ": {
        const right = pop();
        const left = pop();
        stack.push(valuesEqual(left, right));
        break;
      }
      case "GET_PROP": {
        const name = assertString(pop());
        const obj = assertObj(pop());
        stack.push(ctx.world.getProp(obj, name));
        break;
      }
      case "SET_PROP": {
        const value = pop();
        const name = assertString(pop());
        const obj = assertObj(pop());
        ctx.world.setProp(obj, name, value);
        break;
      }
      case "OBSERVE": {
        const event = assertMap(pop());
        const type = assertString(event.type);
        ctx.observe({ ...event, type });
        break;
      }
      case "JUMP":
        pc += Number(operand);
        break;
      case "JUMP_IF_FALSE": {
        const value = pop();
        if (!truthy(value)) pc += Number(operand);
        break;
      }
      case "RETURN":
        return pop();
      case "FAIL":
        throw pop();
      default:
        throw wooError("E_INVARG", `unknown T0 opcode: ${op}`);
    }
  }

  return null;
}

function truthy(value: WooValue): boolean {
  return !(value === null || value === false || value === 0 || value === "");
}

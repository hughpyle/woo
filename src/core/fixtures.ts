import type { TinyBytecode } from "./types";

export const setValueBytecode: TinyBytecode = {
  ops: [
    ["PUSH_THIS"],
    ["PUSH_LIT", 0],
    ["PUSH_ARG", 0],
    ["SET_PROP"],
    ["PUSH_LIT", 1],
    ["PUSH_LIT", 2],
    ["PUSH_LIT", 3],
    ["PUSH_THIS"],
    ["PUSH_LIT", 0],
    ["PUSH_ARG", 0],
    ["MAKE_MAP", 3],
    ["OBSERVE"],
    ["PUSH_ARG", 0],
    ["RETURN"]
  ],
  literals: ["value", "type", "value_changed", "source"],
  num_locals: 0,
  max_stack: 4,
  version: 1
};

export const setPropBytecode: TinyBytecode = {
  ops: [
    ["PUSH_THIS"],
    ["PUSH_ARG", 0],
    ["PUSH_ARG", 1],
    ["SET_PROP"],
    ["PUSH_LIT", 0],
    ["PUSH_LIT", 1],
    ["PUSH_LIT", 2],
    ["PUSH_THIS"],
    ["PUSH_LIT", 3],
    ["PUSH_ARG", 0],
    ["PUSH_LIT", 4],
    ["PUSH_ARG", 1],
    ["MAKE_MAP", 4],
    ["OBSERVE"],
    ["PUSH_ARG", 1],
    ["RETURN"]
  ],
  literals: ["type", "property_changed", "source", "name", "value"],
  num_locals: 0,
  max_stack: 5,
  version: 1
};

export const setControlBytecode: TinyBytecode = {
  ops: [
    ["PUSH_ARG", 0],
    ["PUSH_ARG", 1],
    ["PUSH_ARG", 2],
    ["SET_PROP"],
    ["PUSH_LIT", 0],
    ["PUSH_LIT", 1],
    ["PUSH_LIT", 2],
    ["PUSH_THIS"],
    ["PUSH_LIT", 3],
    ["PUSH_ARG", 0],
    ["PUSH_LIT", 4],
    ["PUSH_ARG", 1],
    ["PUSH_LIT", 5],
    ["PUSH_ARG", 2],
    ["MAKE_MAP", 5],
    ["OBSERVE"],
    ["PUSH_ARG", 2],
    ["RETURN"]
  ],
  literals: ["type", "control_changed", "source", "target", "name", "value"],
  num_locals: 0,
  max_stack: 6,
  version: 1
};

export const claimBytecode: TinyBytecode = {
  ops: [
    ["PUSH_THIS"],
    ["PUSH_LIT", 0],
    ["PUSH_ACTOR"],
    ["SET_PROP"],
    ["PUSH_THIS"],
    ["PUSH_LIT", 1],
    ["PUSH_LIT", 2],
    ["SET_PROP"],
    ["PUSH_LIT", 3],
    ["PUSH_LIT", 4],
    ["PUSH_LIT", 5],
    ["PUSH_THIS"],
    ["PUSH_LIT", 6],
    ["PUSH_ACTOR"],
    ["MAKE_MAP", 3],
    ["OBSERVE"],
    ["PUSH_LIT", 7],
    ["RETURN"]
  ],
  literals: ["assignee", "status", "claimed", "type", "task_claimed", "source", "actor", null],
  num_locals: 0,
  max_stack: 4,
  version: 1
};

export const setStatusBytecode: TinyBytecode = {
  ops: [
    ["PUSH_THIS"],
    ["PUSH_LIT", 0],
    ["PUSH_ARG", 0],
    ["SET_PROP"],
    ["PUSH_LIT", 1],
    ["PUSH_LIT", 2],
    ["PUSH_LIT", 3],
    ["PUSH_THIS"],
    ["PUSH_LIT", 0],
    ["PUSH_ARG", 0],
    ["MAKE_MAP", 3],
    ["OBSERVE"],
    ["PUSH_ARG", 0],
    ["RETURN"]
  ],
  literals: ["status", "type", "status_changed", "source"],
  num_locals: 0,
  max_stack: 4,
  version: 1
};

export const fixtureByName = {
  set_value: setValueBytecode,
  set_prop: setPropBytecode,
  set_control: setControlBytecode,
  claim: claimBytecode,
  set_status: setStatusBytecode
};

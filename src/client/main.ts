import "./styles.css";

type AppState = {
  socket?: WebSocket;
  actor?: string;
  session?: string;
  tab: "dubspace" | "taskspace" | "chat" | "ide";
  world?: any;
  audioOn: boolean;
  clockOffset: number;
  liveControls: Record<string, { value: any; actor: string; at: number }>;
  cueSlots: Record<string, boolean>;
  cuePlaying: Record<string, boolean>;
  cueControls: Record<string, any>;
  chatFeed: ChatLine[];
  chatPresent: string[];
  chatDraft: string;
  observations: any[];
  selectedObject: string;
  selectedTask?: string;
  taskExpanded: Record<string, boolean>;
  taskStatusFilter: Record<string, boolean>;
  compileResult?: any;
};

type ChatLine = {
  kind: "said" | "emoted" | "told" | "entered" | "left" | "system" | "error";
  actor?: string;
  from?: string;
  to?: string;
  text?: string;
  ts?: number;
};

const state: AppState = {
  tab: "chat",
  audioOn: false,
  clockOffset: 0,
  liveControls: {},
  cueSlots: {},
  cuePlaying: {},
  cueControls: {},
  chatFeed: [],
  chatPresent: [],
  chatDraft: "",
  observations: [],
  selectedObject: "",
  taskExpanded: {},
  taskStatusFilter: { open: true, claimed: true, in_progress: true, blocked: true, done: false }
};

let audio: DubAudio | undefined;
const sessionKey = "woo.session";
const drumVoices = [
  { id: "kick", label: "Kick" },
  { id: "snare", label: "Snare" },
  { id: "hat", label: "Hat" },
  { id: "tone", label: "Tone" }
] as const;
const taskStatuses = ["open", "claimed", "in_progress", "blocked", "done"] as const;
const directThrottle = new Map<string, number>();
const pendingDirect = new Map<string, (result: any) => void>();
const reconnectBaseDelayMs = 500;
const reconnectMaxDelayMs = 5000;
const heartbeatIntervalMs = 25_000;
let reconnectDelayMs = reconnectBaseDelayMs;
let reconnectTimer: number | undefined;
let heartbeatTimer: number | undefined;
let lastPongAt = 0;

connect();
window.setInterval(pruneLiveControls, 700);

function connect() {
  if (state.socket?.readyState === WebSocket.OPEN || state.socket?.readyState === WebSocket.CONNECTING) return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  state.socket = socket;
  socket.addEventListener("open", () => {
    reconnectDelayMs = reconnectBaseDelayMs;
    lastPongAt = Date.now();
    sendSocket(socket, { op: "auth", token: authToken() });
    startHeartbeat(socket);
  });
  socket.addEventListener("message", async (event) => {
    const frame = JSON.parse(event.data);
    if (frame.op === "pong") {
      lastPongAt = Date.now();
      return;
    }
    if (frame.op === "session") {
      state.actor = frame.actor;
      state.session = frame.session;
      storeSession(frame.session);
      await refresh();
      requestReplay(socket);
    }
    if (frame.op === "applied") {
      forgetLiveControls(frame.observations ?? []);
      rememberTaskObservations(frame.observations ?? []);
      state.observations.unshift({ seq: frame.seq, space: frame.space, observations: frame.observations, message: frame.message });
      state.observations = state.observations.slice(0, 30);
      rememberSeq(frame.space, frame.seq);
      await refresh();
    }
    if (frame.op === "event") {
      receiveLiveEvent(frame.observation);
    }
    if (frame.op === "result") {
      const handler = pendingDirect.get(frame.id);
      if (handler) {
        pendingDirect.delete(frame.id);
        handler(frame.result);
      }
    }
    if (frame.op === "task") {
      state.observations.unshift({ task: frame.task, space: frame.space, observations: frame.observations });
      state.observations = state.observations.slice(0, 30);
      await refresh();
    }
    if (frame.op === "replay") {
      for (const entry of frame.entries ?? []) {
        state.observations.unshift({ seq: entry.seq, space: frame.space, replay: true, message: entry.message, error: entry.error ?? null });
        rememberSeq(frame.space, entry.seq);
      }
      state.observations = state.observations.slice(0, 30);
      await refresh();
    }
    if (frame.op === "error") {
      if (typeof frame.id === "string") pendingDirect.delete(frame.id);
      if (frame.error?.code === "E_NOSESSION") {
        clearSession();
        if (socket.readyState === WebSocket.OPEN) sendSocket(socket, { op: "auth", token: "guest:local" });
        return;
      }
      state.observations.unshift({ error: frame.error });
      render();
    }
  });
  socket.addEventListener("close", () => {
    if (state.socket !== socket) return;
    stopHeartbeat();
    pendingDirect.clear();
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    if (state.socket === socket && socket.readyState !== WebSocket.CLOSED) socket.close();
  });
}

function sendSocket(socket: WebSocket, frame: Record<string, unknown>) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(frame));
  return true;
}

function sendFrame(frame: Record<string, unknown>) {
  const socket = state.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    scheduleReconnect();
    return false;
  }
  return sendSocket(socket, frame);
}

function scheduleReconnect() {
  if (reconnectTimer !== undefined) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, reconnectMaxDelayMs);
}

function startHeartbeat(socket: WebSocket) {
  stopHeartbeat();
  heartbeatTimer = window.setInterval(() => {
    if (state.socket !== socket) {
      stopHeartbeat();
      return;
    }
    if (Date.now() - lastPongAt > heartbeatIntervalMs * 3) {
      socket.close();
      return;
    }
    if (!sendSocket(socket, { op: "ping" })) {
      stopHeartbeat();
      scheduleReconnect();
    }
  }, heartbeatIntervalMs);
}

function stopHeartbeat() {
  if (heartbeatTimer === undefined) return;
  window.clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}

function authToken() {
  const session = readStorage(sessionKey);
  return session ? `session:${session}` : "guest:local";
}

function storeSession(session: string | undefined) {
  if (session) writeStorage(sessionKey, session);
}

function clearSession() {
  try {
    localStorage.removeItem(sessionKey);
  } catch {
    // Ignore storage failures; auth falls back to a fresh guest.
  }
}

function requestReplay(socket: WebSocket) {
  for (const space of Object.keys(state.world?.spaces ?? {})) {
    const from = Number(readStorage(`woo.lastSeq.${space}`) ?? "0") + 1;
    if (from > 1) sendSocket(socket, { op: "replay", id: crypto.randomUUID(), space, from, limit: 100 });
  }
}

function rememberSeq(space: string, seq: number) {
  const key = `woo.lastSeq.${space}`;
  const current = Number(readStorage(key) ?? "0");
  if (seq > current) writeStorage(key, String(seq));
}

function readStorage(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Local storage is an optimization for reconnect continuity.
  }
}

async function refresh() {
  const response = await fetch("/api/state", { headers: authHeaders() });
  if (!response.ok) return;
  state.world = adaptWorld(await response.json());
  if (!state.selectedObject || !state.world.objects?.[state.selectedObject]) state.selectedObject = defaultSelectedObject();
  state.clockOffset = Number(state.world.server_time ?? Date.now()) - Date.now();
  state.chatPresent = Array.isArray(state.world?.chat?.present) ? state.world.chat.present : state.chatPresent;
  syncTaskSelection();
  audio?.sync(effectiveDubspace(), state.clockOffset);
  render();
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return state.session ? { ...extra, authorization: `Session ${state.session}` } : extra;
}

function adaptWorld(raw: any) {
  const world = raw && typeof raw === "object" ? { ...raw } : {};
  world.objects = raw?.objects ?? {};
  world.catalogs = raw?.catalogs ?? { installed: [] };
  world.dubspaceMeta = buildDubspaceMeta(world);
  world.dubspace = projectDubspace(world, world.dubspaceMeta);
  world.taskspaceMeta = buildTaskspaceMeta(world);
  world.taskspace = projectTaskspace(world, world.taskspaceMeta);
  world.chatMeta = buildChatMeta(world);
  world.chat = projectChat(world, world.chatMeta);
  return world;
}

function installedCatalog(world: any, name: string): any | undefined {
  const installed = Array.isArray(world?.catalogs?.installed) ? world.catalogs.installed : [];
  return installed.find((record: any) => record?.alias === name || record?.catalog === name);
}

function catalogClass(catalog: any, localName: string): string | undefined {
  const value = catalog?.objects?.[localName];
  return typeof value === "string" ? value : undefined;
}

function objectsByParent(world: any, parent: string | undefined, anchor?: string | null): string[] {
  if (!parent) return [];
  return Object.entries(world.objects ?? {})
    .filter(([, obj]: [string, any]) => obj?.parent === parent && (anchor === undefined || obj?.anchor === anchor || obj?.location === anchor))
    .map(([id]) => id)
    .sort((a, b) => objectName(world, a).localeCompare(objectName(world, b)) || a.localeCompare(b));
}

function firstObjectByParent(world: any, parent: string | undefined): string | undefined {
  return objectsByParent(world, parent)[0];
}

function objectView(world: any, id: string | undefined) {
  if (!id) return null;
  const obj = world.objects?.[id];
  if (!obj) return null;
  return { id, name: obj.name ?? id, props: obj.props ?? {} };
}

function objectName(world: any, id: string) {
  return String(world.objects?.[id]?.name ?? id);
}

function buildDubspaceMeta(world: any) {
  const catalog = installedCatalog(world, "dubspace");
  const space = firstObjectByParent(world, catalogClass(catalog, "$dubspace"));
  const byClass = (localName: string) => objectsByParent(world, catalogClass(catalog, localName), space);
  return {
    space,
    slots: byClass("$loop_slot"),
    channel: byClass("$channel")[0],
    filter: byClass("$filter")[0],
    delay: byClass("$delay")[0],
    drum: byClass("$drum_loop")[0],
    scene: byClass("$scene")[0]
  };
}

function projectDubspace(world: any, meta: any) {
  const ids = [meta.space, ...(meta.slots ?? []), meta.channel, meta.filter, meta.delay, meta.drum, meta.scene].filter(Boolean);
  return Object.fromEntries(ids.map((id: string) => [id, objectView(world, id)]).filter(([, view]) => view));
}

function buildTaskspaceMeta(world: any) {
  const catalog = installedCatalog(world, "taskspace");
  return {
    space: firstObjectByParent(world, catalogClass(catalog, "$taskspace")),
    taskClass: catalogClass(catalog, "$task")
  };
}

function projectTaskspace(world: any, meta: any) {
  const space = objectView(world, meta.space);
  const taskIds = objectsByParent(world, meta.taskClass);
  return {
    root_tasks: Array.isArray(space?.props?.root_tasks) ? space.props.root_tasks : [],
    tasks: Object.fromEntries(taskIds.map((id) => [id, objectView(world, id)]).filter(([, view]) => view))
  };
}

function buildChatMeta(world: any) {
  const catalog = installedCatalog(world, "chat");
  return { room: firstObjectByParent(world, catalogClass(catalog, "$chatroom")) };
}

function projectChat(world: any, meta: any) {
  const room = objectView(world, meta.room);
  return {
    room: room ? { id: room.id, name: room.name, description: room.props.description ?? "" } : null,
    present: Array.isArray(room?.props?.subscribers) ? room.props.subscribers : []
  };
}

function defaultSelectedObject() {
  return state.world?.dubspaceMeta?.delay ?? Object.keys(state.world?.objects ?? {}).sort()[0] ?? "";
}

function dubspaceSpace() {
  return String(state.world?.dubspaceMeta?.space ?? "");
}

function taskspaceSpace() {
  return String(state.world?.taskspaceMeta?.space ?? "");
}

function chatRoom() {
  return String(state.world?.chatMeta?.room ?? "");
}

function call(space: string, target: string, verb: string, args: any[] = []) {
  const id = crypto.randomUUID();
  sendFrame({ op: "call", id, space, message: { target, verb, args } });
}

function direct(target: string, verb: string, args: any[] = [], onResult?: (result: any) => void) {
  const id = crypto.randomUUID();
  if (onResult) pendingDirect.set(id, onResult);
  if (!sendFrame({ op: "direct", id, target, verb, args })) pendingDirect.delete(id);
  return id;
}

function liveKey(target: string, name: string) {
  return `${target}:${name}`;
}

function effectiveDubspace() {
  const base = state.world?.dubspace ?? {};
  const copy: Record<string, any> = Object.fromEntries(
    Object.entries(base).map(([id, obj]: [string, any]) => [
      id,
      {
        ...obj,
        props: { ...(obj?.props ?? {}) }
      }
    ])
  );
  const now = Date.now();
  for (const [key, item] of Object.entries(state.liveControls)) {
    if (now - item.at > 1600) {
      delete state.liveControls[key];
      continue;
    }
    const [target, name] = key.split(":");
    if (copy[target]) copy[target].props[name] = item.value;
  }
  for (const [slot, cue] of Object.entries(state.cueSlots)) {
    if (cue && copy[slot]) copy[slot].props.playing = state.cuePlaying[slot] === true;
  }
  for (const [key, value] of Object.entries(state.cueControls)) {
    const [target, name] = key.split(":");
    if (state.cueSlots[target] && copy[target]) copy[target].props[name] = value;
  }
  return copy;
}

function sendPreviewControl(target: string, name: string, value: any) {
  const key = liveKey(target, name);
  state.liveControls[key] = { value, actor: state.actor ?? "", at: Date.now() };
  audio?.sync(effectiveDubspace(), state.clockOffset);
  const last = directThrottle.get(key) ?? 0;
  if (Date.now() - last < 35) return;
  directThrottle.set(key, Date.now());
  const space = dubspaceSpace();
  if (space) direct(space, "preview_control", [target, name, value]);
}

function setCueControl(target: string, name: string, value: any) {
  state.cueControls[liveKey(target, name)] = value;
  audio?.sync(effectiveDubspace(), state.clockOffset);
}

function clearCueControls(target: string) {
  for (const key of Object.keys(state.cueControls)) {
    if (key.startsWith(`${target}:`)) delete state.cueControls[key];
  }
}

function clearCueState(target: string) {
  clearCueControls(target);
  delete state.cuePlaying[target];
}

function commitCueControls(target: string) {
  const values = new Map<string, number>();
  document.querySelectorAll<HTMLInputElement>("[data-control]").forEach((input) => {
    const { target: obj, name } = controlBinding(input);
    if (obj !== target) return;
    const value = Number(input.value);
    if (Number.isFinite(value)) values.set(name, value);
  });
  for (const [key, value] of Object.entries(state.cueControls)) {
    const [obj, name] = key.split(":");
    if (obj !== target || values.has(name)) continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) values.set(name, numeric);
  }
  const space = dubspaceSpace();
  for (const [name, value] of values) if (space) call(space, space, "set_control", [target, name, value]);
}

function receiveLiveEvent(observation: any) {
  if (isChatObservation(observation)) {
    receiveChatEvent(observation);
    return;
  }
  if (observation?.type === "gesture_progress") {
    receiveLiveControl(observation);
    return;
  }
  state.observations.unshift({ live: true, observation });
  state.observations = state.observations.slice(0, 30);
  render();
}

function receiveLiveControl(observation: any) {
  const key = liveKey(observation.target, observation.name);
  state.liveControls[key] = { value: observation.value, actor: observation.actor, at: Date.now() };
  const input = findControlInput(String(observation.target), String(observation.name));
  if (input && document.activeElement !== input) input.value = String(observation.value);
  audio?.sync(effectiveDubspace(), state.clockOffset);
}

function findControlInput(target: string, name: string): HTMLInputElement | null {
  for (const input of document.querySelectorAll<HTMLInputElement>("[data-control]")) {
    const binding = controlBinding(input);
    if (binding.target === target && binding.name === name) return input;
  }
  return null;
}

function controlBinding(input: HTMLInputElement): { target: string; name: string } {
  const target = input.dataset.target ?? "";
  const name = input.dataset.name ?? "";
  if (target && name) return { target, name };
  const [legacyTarget = "", legacyName = ""] = (input.dataset.control ?? "").split(":");
  return { target: legacyTarget, name: legacyName };
}

function forgetLiveControls(observations: any[]) {
  for (const obs of observations) {
    if (obs.type === "control_changed" && obs.target && obs.name) delete state.liveControls[liveKey(String(obs.target), String(obs.name))];
  }
}

function rememberTaskObservations(observations: any[]) {
  for (const obs of observations) {
    if (obs?.type === "task_created" && typeof obs.task === "string") {
      state.selectedTask = obs.task;
      state.taskExpanded[obs.task] = true;
      if (typeof obs.parent === "string") state.taskExpanded[obs.parent] = true;
    }
    if (obs?.type === "subtask_added" && typeof obs.parent === "string") state.taskExpanded[obs.parent] = true;
    if (obs?.type === "task_moved" && typeof obs.to_parent === "string") state.taskExpanded[obs.to_parent] = true;
  }
}

function syncTaskSelection() {
  const taskspace = state.world?.taskspace;
  const tasks = taskspace?.tasks ?? {};
  const roots = Array.isArray(taskspace?.root_tasks) ? taskspace.root_tasks : [];
  const active = activeTaskStatuses();
  if (state.selectedTask && tasks[state.selectedTask] && taskMatchesStatus(tasks[state.selectedTask], active)) return;
  state.selectedTask = firstMatchingTask(roots, tasks, active);
}

function pruneLiveControls() {
  const before = Object.keys(state.liveControls).length;
  void effectiveDubspace();
  if (Object.keys(state.liveControls).length === before) return;
  audio?.sync(effectiveDubspace(), state.clockOffset);
  if (state.tab === "dubspace") render();
}

function render() {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.innerHTML = `
    <div class="shell">
      <aside class="nav">
        <div class="brand">Woo</div>
        <div class="actor">${escapeHtml(state.actor ?? "connecting...")}</div>
        ${navButton("chat", "Chat")}
        ${navButton("dubspace", "Dubspace")}
        ${navButton("taskspace", "Taskspace")}
        ${navButton("ide", "IDE")}
      </aside>
      <main class="main">
        ${state.tab === "dubspace" ? renderDubspace() : ""}
        ${state.tab === "taskspace" ? renderTaskspace() : ""}
        ${state.tab === "chat" ? renderChat() : ""}
        ${state.tab === "ide" ? renderIde() : ""}
      </main>
      <aside class="events">
        <h2>Observations</h2>
        <div class="event-list">
          ${state.observations.map((item) => `<pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre>`).join("") || "<p>No observations yet.</p>"}
        </div>
      </aside>
    </div>
  `;

  bindCommon();
  if (state.tab === "dubspace") bindDubspace();
  if (state.tab === "taskspace") bindTaskspace();
  if (state.tab === "chat") bindChat();
  if (state.tab === "ide") bindIde();
  if (state.tab === "chat") focusChatInput();
}

function navButton(tab: AppState["tab"], label: string) {
  return `<button class="nav-button ${state.tab === tab ? "active" : ""}" data-tab="${tab}">${label}</button>`;
}

function bindCommon() {
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tab = button.dataset.tab as AppState["tab"];
      render();
    });
  });
}

function renderDubspace() {
  const dub = effectiveDubspace();
  const meta = state.world?.dubspaceMeta ?? {};
  const slots = Array.isArray(meta.slots) ? meta.slots : [];
  const filter = dub[meta.filter]?.props ?? {};
  const delay = dub[meta.delay]?.props ?? {};
  const drum = dub[meta.drum]?.props ?? {};
  const pattern = normalizePattern(drum.pattern);
  return `
    <section class="toolbar">
      <h1>Dubspace</h1>
      <button class="${state.audioOn ? "active" : ""}" data-audio aria-pressed="${state.audioOn}">Audio ${state.audioOn ? "On" : "Off"}</button>
      <button data-save-scene>Save Scene</button>
      <button data-recall-scene>Recall Scene</button>
    </section>
    <section class="grid">
      <article class="panel loop-console-panel">
        <div class="panel-head"><h2>Loops</h2></div>
        <div class="loop-console">${slots.map((id: string, index: number) => renderLoopStrip(id, index + 1, dub)).join("")}${renderFilterStrip(filter)}</div>
      </article>
      <article class="panel">
        <h2>Delay</h2>
        ${slider(meta.delay, "send", delay.send ?? 0.3)}
        ${slider(meta.delay, "time", delay.time ?? 0.25)}
        ${slider(meta.delay, "feedback", delay.feedback ?? 0.35)}
        ${slider(meta.delay, "wet", delay.wet ?? 0.4)}
      </article>
      <article class="panel sequencer">
        <div class="panel-head">
          <h2>Percussion</h2>
          <button data-transport="${drum.playing ? "stop" : "start"}">${drum.playing ? "Stop" : "Start"}</button>
        </div>
        <label>BPM <input data-tempo type="range" min="60" max="200" step="1" value="${escapeHtml(String(drum.bpm ?? 118))}"><span>${escapeHtml(String(drum.bpm ?? 118))}</span></label>
        <div class="steps">
          ${drumVoices.map((voice) => renderStepRow(voice.id, voice.label, pattern[voice.id])).join("")}
        </div>
      </article>
    </section>
  `;
}

function renderFilterStrip(filter: any) {
  const cutoff = filter.cutoff ?? 1000;
  const target = state.world?.dubspaceMeta?.filter ?? "";
  return `
    <div class="filter-strip">
      <div class="loop-strip-head">
        <strong>F</strong>
        <span>Filter</span>
      </div>
      <input class="vertical-fader" aria-label="Filter cutoff" data-control data-target="${escapeHtml(target)}" data-name="cutoff" type="range" min="80" max="5000" step="1" value="${escapeHtml(String(cutoff))}">
      <span class="fader-readout">${escapeHtml(String(Math.round(Number(cutoff))))} Hz</span>
    </div>
  `;
}

function renderLoopStrip(id: string, index: number, dub: any) {
  const slot = dub[id]?.props ?? {};
  const cue = state.cueSlots[id] === true;
  const serverPlaying = state.world?.dubspace?.[id]?.props?.playing === true;
  const buttonPlaying = cue ? state.cuePlaying[id] === true : serverPlaying;
  const freq = slot.freq ?? defaultLoopFreq(index);
  return `
    <div class="loop-strip ${slot.playing ? "playing" : ""} ${cue ? "cue-active" : ""}">
      <div class="loop-strip-head">
        <strong>${index}</strong>
        <span>${escapeHtml(String(dub[id]?.name ?? id))}</span>
      </div>
      <button data-loop="${escapeHtml(id)}" data-playing="${buttonPlaying ? "true" : "false"}">${buttonPlaying ? "Stop" : "Start"}</button>
      <input class="vertical-fader" aria-label="Loop ${index} gain" data-control data-target="${escapeHtml(id)}" data-name="gain" type="range" min="0" max="1" step="0.01" value="${escapeHtml(String(slot.gain ?? 0.75))}">
      <label class="freq-field">
        <span>Freq</span>
        <input aria-label="Loop ${index} frequency" data-control data-target="${escapeHtml(id)}" data-name="freq" type="number" min="40" max="1200" step="0.01" value="${escapeHtml(String(freq))}">
      </label>
      <button class="cue-button ${cue ? "active" : ""}" data-cue-slot="${escapeHtml(id)}" aria-pressed="${cue}">CUE</button>
    </div>
  `;
}

function slider(obj: string, prop: string, value: number) {
  return `<label>${escapeHtml(prop)} <input data-control data-target="${escapeHtml(obj)}" data-name="${escapeHtml(prop)}" type="range" min="0" max="1" step="0.01" value="${escapeHtml(String(value))}"></label>`;
}

function bindDubspace() {
  document.querySelector<HTMLButtonElement>("[data-audio]")?.addEventListener("click", async () => {
    audio ??= new DubAudio();
    if (state.audioOn) {
      await audio.stop();
      state.audioOn = false;
      render();
      return;
    }
    await audio.start();
    state.audioOn = true;
    audio.sync(effectiveDubspace(), state.clockOffset);
    render();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-loop]").forEach((button) => {
    button.addEventListener("click", () => {
      const slot = button.dataset.loop!;
      const playing = button.dataset.playing === "true";
      if (state.cueSlots[slot]) {
        state.cuePlaying[slot] = !playing;
        audio?.sync(effectiveDubspace(), state.clockOffset);
        render();
        return;
      }
      const space = dubspaceSpace();
      if (space) call(space, space, playing ? "stop_loop" : "start_loop", [slot]);
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-cue-slot]").forEach((button) => {
    button.addEventListener("click", () => {
      const slot = button.dataset.cueSlot!;
      const wasCue = state.cueSlots[slot] === true;
      if (wasCue) {
        commitCueControls(slot);
        state.cueSlots[slot] = false;
        clearCueState(slot);
      } else {
        state.cueSlots[slot] = true;
        state.cuePlaying[slot] = true;
      }
      audio?.sync(effectiveDubspace(), state.clockOffset);
      render();
    });
  });
  document.querySelectorAll<HTMLInputElement>("[data-control]").forEach((input) => {
    input.addEventListener("input", () => {
      const { target, name } = controlBinding(input);
      if (state.cueSlots[target]) {
        setCueControl(target, name, Number(input.value));
        return;
      }
      sendPreviewControl(target, name, Number(input.value));
    });
    input.addEventListener("change", () => {
      const { target, name } = controlBinding(input);
      if (state.cueSlots[target]) {
        setCueControl(target, name, Number(input.value));
        return;
      }
      const space = dubspaceSpace();
      if (space) call(space, space, "set_control", [target, name, Number(input.value)]);
    });
  });
  document.querySelector<HTMLButtonElement>("[data-transport]")?.addEventListener("click", (event) => {
    const mode = (event.currentTarget as HTMLButtonElement).dataset.transport;
    const space = dubspaceSpace();
    if (space) call(space, space, mode === "stop" ? "stop_transport" : "start_transport", []);
  });
  document.querySelector<HTMLInputElement>("[data-tempo]")?.addEventListener("change", (event) => {
    const space = dubspaceSpace();
    if (space) call(space, space, "set_tempo", [Number((event.currentTarget as HTMLInputElement).value)]);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-step]").forEach((button) => {
    button.addEventListener("click", () => {
      const [voice, step] = button.dataset.step!.split(":");
      const space = dubspaceSpace();
      if (space) call(space, space, "set_drum_step", [voice, Number(step), button.dataset.enabled !== "true"]);
    });
  });
  document.querySelector<HTMLButtonElement>("[data-save-scene]")?.addEventListener("click", () => {
    const space = dubspaceSpace();
    if (space) call(space, space, "save_scene", [`Scene ${new Date().toLocaleTimeString()}`]);
  });
  document.querySelector<HTMLButtonElement>("[data-recall-scene]")?.addEventListener("click", () => {
    const space = dubspaceSpace();
    const scene = state.world?.dubspaceMeta?.scene;
    if (space && scene) call(space, space, "recall_scene", [scene]);
  });
}

function normalizePattern(raw: any): Record<string, boolean[]> {
  const out: Record<string, boolean[]> = {};
  for (const voice of drumVoices) {
    const row = Array.isArray(raw?.[voice.id]) ? raw[voice.id] : [];
    out[voice.id] = Array.from({ length: 8 }, (_, index) => Boolean(row[index]));
  }
  return out;
}

function renderStepRow(voice: string, label: string, row: boolean[]) {
  return `
    <div class="step-row">
      <span>${escapeHtml(label)}</span>
      ${row
        .map(
          (enabled, index) =>
            `<button class="step ${enabled ? "active" : ""}" data-step="${escapeHtml(`${voice}:${index}`)}" data-enabled="${enabled ? "true" : "false"}">${index + 1}</button>`
        )
        .join("")}
    </div>
  `;
}

function enterChat() {
  const room = chatRoom();
  if (!room) return;
  direct(room, "enter", [], (result) => {
    setChatPresent(result);
    if (state.tab === "chat") render();
  });
}

function isChatObservation(observation: any) {
  return ["said", "emoted", "told", "entered", "left"].includes(String(observation?.type ?? ""));
}

function receiveChatEvent(observation: any) {
  const kind = String(observation.type) as ChatLine["kind"];
  if (kind === "entered" && typeof observation.actor === "string" && !state.chatPresent.includes(observation.actor)) {
    state.chatPresent = [...state.chatPresent, observation.actor];
  }
  if (kind === "left" && typeof observation.actor === "string") {
    state.chatPresent = state.chatPresent.filter((id) => id !== observation.actor);
  }
  pushChatLine({
    kind,
    actor: typeof observation.actor === "string" ? observation.actor : undefined,
    from: typeof observation.from === "string" ? observation.from : undefined,
    to: typeof observation.to === "string" ? observation.to : undefined,
    text: typeof observation.text === "string" ? observation.text : undefined,
    ts: typeof observation.ts === "number" ? observation.ts : undefined
  });
}

function pushChatLine(line: ChatLine) {
  state.chatFeed = [...state.chatFeed, line].slice(-160);
  if (state.tab === "chat") render();
}

function setChatPresent(result: any) {
  if (Array.isArray(result)) state.chatPresent = result.map(String);
}

function renderChat() {
  const room = state.world?.chat?.room;
  const present = state.chatPresent;
  const inRoom = Boolean(state.actor && present.includes(state.actor));
  if (!inRoom) {
    return `
      <section class="toolbar">
        <h1>${escapeHtml(room?.name ?? "Chat")}</h1>
        <button data-chat-enter>Enter</button>
      </section>
      <section class="chat-layout solo">
        <div class="panel chat-empty-panel">
          <p>${escapeHtml(room?.description ?? "Enter the room to chat.")}</p>
        </div>
      </section>
    `;
  }
  return `
    <section class="toolbar">
      <h1>${escapeHtml(room?.name ?? "Chat")}</h1>
      <button data-chat-leave>Leave</button>
      <button data-chat-look>Look</button>
      <button data-chat-who>Who</button>
    </section>
    <section class="chat-layout">
      <div class="panel chat-panel">
        <div class="chat-feed" aria-live="polite">
          ${state.chatFeed.map(renderChatLine).join("") || `<div class="chat-empty">${escapeHtml(room?.description ?? "No chat events yet.")}</div>`}
        </div>
        <form class="chat-form" data-chat-form>
          <input data-chat-input autocomplete="off" placeholder="Say, /me acts, /tell guest_2 hello" value="${escapeHtml(state.chatDraft)}" />
          <button>Send</button>
        </form>
      </div>
      <aside class="panel chat-presence">
        <h2>Present</h2>
        <div class="presence-list">
          ${present.map((id: string) => `<button data-chat-recipient="${escapeHtml(id)}">${escapeHtml(actorLabel(id))}<span>${escapeHtml(id)}</span></button>`).join("") || "<p>No actors present.</p>"}
        </div>
      </aside>
    </section>
  `;
}

function renderChatLine(line: ChatLine) {
  const time = line.ts ? new Date(line.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  if (line.kind === "said") {
    return `<div class="chat-line said"><span class="chat-time">${escapeHtml(time)}</span><strong>${escapeHtml(actorLabel(line.actor))}</strong><span>${escapeHtml(line.text ?? "")}</span></div>`;
  }
  if (line.kind === "emoted") {
    return `<div class="chat-line emote"><span class="chat-time">${escapeHtml(time)}</span><span>${escapeHtml(actorLabel(line.actor))} ${escapeHtml(line.text ?? "")}</span></div>`;
  }
  if (line.kind === "told") {
    return `<div class="chat-line told"><span class="chat-time">${escapeHtml(time)}</span><strong>${escapeHtml(actorLabel(line.from))} -> ${escapeHtml(actorLabel(line.to))}</strong><span>${escapeHtml(line.text ?? "")}</span></div>`;
  }
  if (line.kind === "entered" || line.kind === "left") {
    return `<div class="chat-line system"><span class="chat-time">${escapeHtml(time)}</span><span>${escapeHtml(actorLabel(line.actor))} ${line.kind === "entered" ? "entered" : "left"}.</span></div>`;
  }
  return `<div class="chat-line system"><span class="chat-time">${escapeHtml(time)}</span><span>${escapeHtml(line.text ?? "")}</span></div>`;
}

function bindChat() {
  document.querySelector<HTMLInputElement>("[data-chat-input]")?.addEventListener("input", (event) => {
    state.chatDraft = (event.currentTarget as HTMLInputElement).value;
  });
  document.querySelector<HTMLFormElement>("[data-chat-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector<HTMLInputElement>("[data-chat-input]");
    const text = input?.value.trim() ?? "";
    if (!text) return;
    state.chatDraft = "";
    sendChatInput(text);
    if (input) {
      input.value = "";
      input.focus();
    }
  });
  document.querySelector<HTMLButtonElement>("[data-chat-enter]")?.addEventListener("click", enterChat);
  document.querySelector<HTMLButtonElement>("[data-chat-leave]")?.addEventListener("click", () => {
    const room = chatRoom();
    if (!room) return;
    direct(room, "leave", [], (result) => {
      setChatPresent(result);
      if (state.tab === "chat") render();
    });
  });
  document.querySelector<HTMLButtonElement>("[data-chat-who]")?.addEventListener("click", refreshChatWho);
  document.querySelector<HTMLButtonElement>("[data-chat-look]")?.addEventListener("click", refreshChatLook);
  document.querySelectorAll<HTMLButtonElement>("[data-chat-recipient]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.querySelector<HTMLInputElement>("[data-chat-input]");
      if (!input) return;
      state.chatDraft = `/tell ${button.dataset.chatRecipient} `;
      input.value = state.chatDraft;
      input.focus();
    });
  });
}

function focusChatInput() {
  window.requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>("[data-chat-input]");
    input?.focus();
    if (input) input.setSelectionRange(input.value.length, input.value.length);
  });
}

function sendChatInput(text: string) {
  if (text === "/who" || text === "who") {
    refreshChatWho();
    return;
  }
  if (text === "/look" || text === "look") {
    refreshChatLook();
    return;
  }
  if (text.startsWith("/me ")) {
    const room = chatRoom();
    if (room) direct(room, "emote", [text.slice(4).trim()]);
    return;
  }
  if (text.startsWith(":")) {
    const room = chatRoom();
    if (room) direct(room, "emote", [text.slice(1).trim()]);
    return;
  }
  if (text.startsWith("/tell ")) {
    const rest = text.slice("/tell ".length).trim();
    const split = rest.indexOf(" ");
    if (split <= 0) {
      pushChatLine({ kind: "error", text: "Tell needs a recipient and text." });
      return;
    }
    const room = chatRoom();
    if (room) direct(room, "tell", [rest.slice(0, split), rest.slice(split + 1).trim()]);
    return;
  }
  const room = chatRoom();
  if (room) direct(room, "say", [text]);
}

function refreshChatWho() {
  const room = chatRoom();
  if (!room) return;
  direct(room, "who", [], (result) => {
    setChatPresent(result);
    const names = state.chatPresent.map(actorLabel).join(", ") || "nobody";
    pushChatLine({ kind: "system", text: `Present: ${names}` });
  });
}

function refreshChatLook() {
  const room = chatRoom();
  if (!room) return;
  direct(room, "look", [], (result) => {
    const present = Array.isArray(result?.present_actors) ? result.present_actors.map(String) : [];
    state.chatPresent = present;
    const names = present.map(actorLabel).join(", ") || "nobody";
    pushChatLine({ kind: "system", text: `${String(result?.description ?? "")} Present: ${names}.` });
  });
}

function actorLabel(id: string | undefined) {
  if (!id) return "unknown";
  return String(state.world?.objects?.[id]?.name ?? id);
}

function renderTaskspace() {
  const taskspace = state.world?.taskspace;
  const tasks = taskspace?.tasks ?? {};
  const roots = Array.isArray(taskspace?.root_tasks) ? taskspace.root_tasks : [];
  const selected = state.selectedTask ? tasks[state.selectedTask] : undefined;
  const allTasks = Object.values(tasks);
  const statusCounts = countTasksByStatus(allTasks);
  const active = activeTaskStatuses();
  const visibleCount = allTasks.filter((task) => taskMatchesStatus(task, active)).length;
  const renderedRoots = roots.map((id: string) => renderTaskNode(id, tasks, 0, active)).join("");
  return `
    <section class="toolbar task-toolbar">
      <h1>Taskspace</h1>
      <div class="task-summary">
        <span>${visibleCount}/${allTasks.length} tasks</span>
        ${taskStatuses.map((status) => renderStatusFilter(status, statusCounts[status] ?? 0)).join("")}
      </div>
    </section>
    <section class="taskspace-layout">
      <div class="panel tree">
        <div class="task-create">
          <input data-new-title placeholder="Root task title" />
          <input data-new-description placeholder="Description" />
          <button data-create-task>Create</button>
        </div>
        <div class="task-tree-list">
          ${renderedRoots || `<div class="empty-state">${allTasks.length > 0 ? "No tasks match the selected statuses." : "No tasks yet."}</div>`}
        </div>
      </div>
      <div class="panel inspector">${selected ? renderTaskInspector(selected, tasks) : `<div class="empty-state">Select a task.</div>`}</div>
    </section>
  `;
}

function renderStatusFilter(status: string, count: number): string {
  const active = state.taskStatusFilter[status] !== false;
  return `
    <button class="status-pill status-filter ${statusClass(status)} ${active ? "active" : ""}" data-task-status="${escapeHtml(status)}" aria-pressed="${active}">
      ${escapeHtml(statusLabel(status))}: ${count}
    </button>
  `;
}

function renderTaskNode(id: string, tasks: any, depth: number, active: Set<string>): string {
  const task = tasks[id];
  if (!task) return "";
  const props = task.props;
  const subtasks = Array.isArray(props.subtasks) ? props.subtasks : [];
  const renderedChildren = subtasks.map((child: string) => renderTaskNode(child, tasks, depth + 1, active)).join("");
  const matches = taskMatchesStatus(task, active);
  if (!matches && !renderedChildren) return "";
  const expanded = state.taskExpanded[id] !== false;
  const reqStats = requirementStats(props.requirements);
  const selected = state.selectedTask === id;
  return `
    <div class="task-node" style="--depth:${depth}">
      <div class="task-row ${selected ? "selected" : ""} ${matches ? "" : "filtered-context"}">
        <button class="task-toggle" data-toggle-task="${escapeHtml(id)}" aria-label="Toggle ${escapeHtml(String(props.title ?? id))}" ${subtasks.length === 0 ? "disabled" : ""}>${subtasks.length === 0 ? "" : expanded ? "-" : "+"}</button>
        <button class="task-select" data-select-task="${escapeHtml(id)}">
          <span class="task-title">${escapeHtml(String(props.title ?? id))}</span>
          <span class="task-meta">
            <span class="status-pill ${statusClass(String(props.status ?? ""))}">${escapeHtml(statusLabel(String(props.status ?? "")))}</span>
            <span>${escapeHtml(String(props.assignee ? actorLabel(String(props.assignee)) : "unassigned"))}</span>
            <span>${reqStats.checked}/${reqStats.total} req</span>
          </span>
        </button>
      </div>
      ${expanded && renderedChildren ? `<div class="children">${renderedChildren}</div>` : ""}
    </div>
  `;
}

function renderTaskInspector(task: any, tasks: any) {
  const props = task.props;
  const requirements = Array.isArray(props.requirements) ? props.requirements : [];
  const messages = Array.isArray(props.messages) ? props.messages : [];
  const artifacts = Array.isArray(props.artifacts) ? props.artifacts : [];
  const subtasks = Array.isArray(props.subtasks) ? props.subtasks : [];
  const reqStats = requirementStats(requirements);
  return `
    <div class="task-inspector-head">
      <div>
        <h2>${escapeHtml(String(props.title ?? task.id ?? ""))}</h2>
        <p>${escapeHtml(String(props.description ?? "No description."))}</p>
      </div>
      <span class="status-pill ${statusClass(String(props.status ?? ""))}">${escapeHtml(statusLabel(String(props.status ?? "")))}</span>
    </div>
    <div class="task-facts">
      <div><strong>ID</strong><span>${escapeHtml(task.id)}</span></div>
      <div><strong>Assignee</strong><span>${escapeHtml(String(props.assignee ? actorLabel(String(props.assignee)) : "none"))}</span></div>
      <div><strong>Requirements</strong><span>${reqStats.checked}/${reqStats.total}</span></div>
      <div><strong>Subtasks</strong><span>${subtasks.length}</span></div>
    </div>
    <div class="button-row task-actions">
      <button data-task-action="claim">Claim</button>
      <button data-task-action="release">Release</button>
      ${["open", "in_progress", "blocked", "done"].map((status) => `<button class="${String(props.status) === status ? "active" : ""}" data-task-action="status:${status}">${escapeHtml(statusLabel(status))}</button>`).join("")}
    </div>
    <section class="task-section">
      <h3>Subtasks</h3>
      <div class="inline-form"><input data-subtask-title placeholder="Subtask title"><input data-subtask-description placeholder="Description"><button data-add-subtask>Add</button></div>
      <div class="related-list">${subtasks.map((id: string) => renderRelatedTask(id, tasks)).join("") || `<div class="empty-state">No subtasks.</div>`}</div>
    </section>
    <section class="task-section">
      <h3>Requirements</h3>
      <div class="inline-form"><input data-requirement placeholder="Requirement"><button data-add-requirement>Add</button></div>
      <ul class="checklist">${requirements
        .map((item: any, index: number) => `<li><label><input data-check-req="${index}" type="checkbox" ${item.checked ? "checked" : ""}> <span>${escapeHtml(String(item.text ?? ""))}</span></label></li>`)
        .join("") || `<li class="empty-state">No requirements.</li>`}</ul>
    </section>
    <section class="task-section">
      <h3>Messages</h3>
      <div class="inline-form"><input data-message placeholder="Message"><button data-add-message>Add</button></div>
      <div class="activity-list">${messages.map(renderTaskMessage).join("") || `<div class="empty-state">No messages.</div>`}</div>
    </section>
    <section class="task-section">
      <h3>Artifacts</h3>
      <div class="inline-form"><input data-artifact placeholder="https://example.com/artifact"><button data-add-artifact>Add</button></div>
      <div class="artifact-list">${artifacts.map(renderArtifact).join("") || `<div class="empty-state">No artifacts.</div>`}</div>
    </section>
  `;
}

function renderRelatedTask(id: string, tasks: any) {
  const task = tasks[id];
  if (!task) return "";
  const props = task.props ?? {};
  return `
    <button class="related-task" data-select-task="${escapeHtml(id)}">
      <span>${escapeHtml(String(props.title ?? id))}</span>
      <span class="status-pill ${statusClass(String(props.status ?? ""))}">${escapeHtml(statusLabel(String(props.status ?? "")))}</span>
    </button>
  `;
}

function renderTaskMessage(item: any) {
  const actor = typeof item?.actor === "string" ? actorLabel(item.actor) : "unknown";
  const ts = typeof item?.ts === "number" ? new Date(item.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  return `
    <div class="activity-item">
      <div><strong>${escapeHtml(actor)}</strong><span>${escapeHtml(ts)}</span></div>
      <p>${escapeHtml(String(item?.body ?? ""))}</p>
    </div>
  `;
}

function renderArtifact(item: any) {
  const ref = String(item?.ref ?? "");
  const kind = String(item?.kind ?? "external");
  const label = ref || "artifact";
  const body = ref.startsWith("http")
    ? `<a href="${escapeHtml(ref)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
    : `<span>${escapeHtml(label)}</span>`;
  return `<div class="artifact-item"><span>${escapeHtml(kind)}</span>${body}</div>`;
}

function requirementStats(requirements: any) {
  const items = Array.isArray(requirements) ? requirements : [];
  return {
    total: items.length,
    checked: items.filter((item) => item?.checked === true).length
  };
}

function countTasksByStatus(tasks: any[]) {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    const status = String((task as any)?.props?.status ?? "open");
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function statusClass(status: string) {
  return `status-${status.replace(/[^a-z0-9_-]/gi, "_") || "unknown"}`;
}

function statusLabel(status: string) {
  if (status === "in_progress") return "in progress";
  return status || "unknown";
}

function activeTaskStatuses() {
  return new Set(taskStatuses.filter((status) => state.taskStatusFilter[status] !== false));
}

function taskStatus(task: any) {
  return String(task?.props?.status ?? "open");
}

function taskMatchesStatus(task: any, active: Set<string>) {
  return active.has(taskStatus(task));
}

function firstMatchingTask(ids: string[], tasks: any, active: Set<string>): string | undefined {
  for (const id of ids) {
    const task = tasks[id];
    if (!task) continue;
    if (taskMatchesStatus(task, active)) return id;
    const subtasks = Array.isArray(task.props?.subtasks) ? task.props.subtasks : [];
    const child = firstMatchingTask(subtasks, tasks, active);
    if (child) return child;
  }
  return undefined;
}

function bindTaskspace() {
  document.querySelectorAll<HTMLButtonElement>("[data-task-status]").forEach((button) => {
    button.addEventListener("click", () => {
      const status = button.dataset.taskStatus!;
      state.taskStatusFilter[status] = state.taskStatusFilter[status] === false;
      syncTaskSelection();
      render();
    });
  });
  document.querySelector<HTMLButtonElement>("[data-create-task]")?.addEventListener("click", () => {
    const titleInput = document.querySelector<HTMLInputElement>("[data-new-title]");
    const descriptionInput = document.querySelector<HTMLInputElement>("[data-new-description]");
    const title = titleInput?.value.trim() || "Untitled";
    const description = descriptionInput?.value.trim() || "";
    const space = taskspaceSpace();
    if (space) call(space, space, "create_task", [title, description]);
    if (titleInput) titleInput.value = "";
    if (descriptionInput) descriptionInput.value = "";
  });
  document.querySelectorAll<HTMLButtonElement>("[data-toggle-task]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.toggleTask!;
      state.taskExpanded[id] = state.taskExpanded[id] === false;
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-select-task]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedTask = button.dataset.selectTask!;
      state.taskExpanded[state.selectedTask] = state.taskExpanded[state.selectedTask] ?? true;
      render();
    });
  });
  const id = state.selectedTask;
  if (!id) return;
  document.querySelectorAll<HTMLButtonElement>("[data-task-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.taskAction!;
      const space = taskspaceSpace();
      if (!space) return;
      if (action === "claim" || action === "release") call(space, id, action, []);
      if (action.startsWith("status:")) call(space, id, "set_status", [action.slice("status:".length)]);
    });
  });
  document.querySelector<HTMLButtonElement>("[data-add-subtask]")?.addEventListener("click", () => {
    const titleInput = document.querySelector<HTMLInputElement>("[data-subtask-title]");
    const descriptionInput = document.querySelector<HTMLInputElement>("[data-subtask-description]");
    const title = titleInput?.value.trim() || "Subtask";
    const description = descriptionInput?.value.trim() || "";
    state.taskExpanded[id] = true;
    const space = taskspaceSpace();
    if (space) call(space, id, "add_subtask", [title, description]);
    if (titleInput) titleInput.value = "";
    if (descriptionInput) descriptionInput.value = "";
  });
  document.querySelector<HTMLButtonElement>("[data-add-requirement]")?.addEventListener("click", () => {
    const input = document.querySelector<HTMLInputElement>("[data-requirement]");
    const text = input?.value.trim() || "Requirement";
    const space = taskspaceSpace();
    if (space) call(space, id, "add_requirement", [text]);
    if (input) input.value = "";
  });
  document.querySelectorAll<HTMLInputElement>("[data-check-req]").forEach((input) => {
    input.addEventListener("change", () => {
      const space = taskspaceSpace();
      if (space) call(space, id, "check_requirement", [Number(input.dataset.checkReq), input.checked]);
    });
  });
  document.querySelector<HTMLButtonElement>("[data-add-message]")?.addEventListener("click", () => {
    const input = document.querySelector<HTMLInputElement>("[data-message]");
    const body = input?.value.trim() || "Update";
    const space = taskspaceSpace();
    if (space) call(space, id, "add_message", [body]);
    if (input) input.value = "";
  });
  document.querySelector<HTMLButtonElement>("[data-add-artifact]")?.addEventListener("click", () => {
    const input = document.querySelector<HTMLInputElement>("[data-artifact]");
    const ref = input?.value.trim() || "https://example.com";
    const space = taskspaceSpace();
    if (space) call(space, id, "add_artifact", [{ kind: ref.startsWith("http") ? "url" : "external", ref }]);
    if (input) input.value = "";
  });
}

function renderIde() {
  const objects = Object.keys(state.world?.objects ?? {}).sort();
  const installTarget = state.selectedObject || defaultSelectedObject();
  return `
    <section class="toolbar">
      <h1>IDE</h1>
      <select data-object-select>${objects.map((id) => `<option value="${escapeHtml(id)}" ${id === state.selectedObject ? "selected" : ""}>${escapeHtml(id)}</option>`).join("")}</select>
      <button data-refresh-object>Inspect</button>
    </section>
    <section class="split">
      <div class="panel"><pre>${escapeHtml(JSON.stringify(state.world?.objects?.[state.selectedObject] ?? {}, null, 2))}</pre></div>
      <div class="panel editor">
        <input data-verb-name value="set_feedback" />
        <textarea data-source>${escapeHtml(defaultSource())}</textarea>
        <div class="button-row">
          <button data-compile>Compile</button>
          <button data-install>Install on ${escapeHtml(installTarget)}</button>
          <button data-test-verb>Test</button>
        </div>
        <pre>${escapeHtml(JSON.stringify(state.compileResult ?? {}, null, 2))}</pre>
      </div>
    </section>
  `;
}

function bindIde() {
  document.querySelector<HTMLSelectElement>("[data-object-select]")?.addEventListener("change", (event) => {
    state.selectedObject = (event.target as HTMLSelectElement).value;
    render();
  });
  document.querySelector<HTMLButtonElement>("[data-compile]")?.addEventListener("click", async () => {
    const source = document.querySelector<HTMLTextAreaElement>("[data-source]")!.value;
    const response = await fetch("/api/compile", { method: "POST", body: JSON.stringify({ source }) });
    state.compileResult = await response.json();
    render();
  });
  document.querySelector<HTMLButtonElement>("[data-install]")?.addEventListener("click", async () => {
    const source = document.querySelector<HTMLTextAreaElement>("[data-source]")!.value;
    const name = document.querySelector<HTMLInputElement>("[data-verb-name]")!.value.trim();
    const object = state.selectedObject;
    const info = await fetch(`/api/object?id=${encodeURIComponent(object)}`, { headers: authHeaders() }).then((response) => response.json());
    const current = info.verbs?.find((verb: any) => verb.name === name);
    const response = await fetch("/api/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ object, name, source, expected_version: current?.version ?? null })
    });
    state.compileResult = await response.json();
    await refresh();
  });
  document.querySelector<HTMLButtonElement>("[data-test-verb]")?.addEventListener("click", () => {
    const name = document.querySelector<HTMLInputElement>("[data-verb-name]")!.value.trim();
    const space = dubspaceSpace();
    if (space) call(space, state.selectedObject, name, [0.62]);
  });
}

function defaultSource() {
  return `verb :set_feedback(value) rx {
  this.feedback = value;
  observe({
    "type": "control_changed",
    "target": this,
    "name": "feedback",
    "value": value,
    "actor": actor,
    "seq": seq
  });
  return value;
}`;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function defaultLoopFreq(index: number) {
  const freqs = [110, 146.83, 196, 261.63];
  return freqs[index - 1] ?? 220;
}

class DubAudio {
  private context = new AudioContext();
  private gains = new Map<string, GainNode>();
  private oscillators = new Map<string, OscillatorNode>();
  private input = this.context.createGain();
  private filter = this.context.createBiquadFilter();
  private channel = this.context.createGain();
  private dry = this.context.createGain();
  private send = this.context.createGain();
  private delay = this.context.createDelay(1.5);
  private feedback = this.context.createGain();
  private wet = this.context.createGain();
  private dubspace: any;
  private clockOffset = 0;
  private sequencer?: number;
  private lastStep = -1;
  private lastStartedAt = 0;

  constructor() {
    this.filter.type = "lowpass";
    this.input.connect(this.filter).connect(this.channel);
    this.channel.connect(this.dry).connect(this.context.destination);
    this.channel.connect(this.send).connect(this.delay);
    this.delay.connect(this.feedback).connect(this.delay);
    this.delay.connect(this.wet).connect(this.context.destination);
    this.dry.gain.value = 1;
    this.send.gain.value = 0.3;
    this.delay.delayTime.value = 0.25;
    this.feedback.gain.value = 0.35;
    this.wet.gain.value = 0.4;
  }

  async start() {
    await this.context.resume();
    this.ensureSequencer();
  }

  async stop() {
    for (const osc of this.oscillators.values()) osc.stop();
    this.oscillators.clear();
    this.gains.clear();
    await this.context.suspend();
  }

  sync(dubspace: any, clockOffset = 0) {
    if (!dubspace) return;
    this.dubspace = dubspace;
    this.clockOffset = clockOffset;
    this.syncEffects(dubspace);
    const slots = Array.isArray(state.world?.dubspaceMeta?.slots) ? state.world.dubspaceMeta.slots : [];
    for (const [index, id] of slots.entries()) {
      const props = dubspace[id]?.props ?? {};
      const freq = clamp(Number(props.freq ?? defaultLoopFreq(index + 1)), 40, 1200);
      if (props.playing && !this.oscillators.has(id)) {
        const osc = this.context.createOscillator();
        const gain = this.context.createGain();
        osc.frequency.value = freq;
        osc.type = "sawtooth";
        gain.gain.value = (props.gain ?? 0.5) * 0.08;
        osc.connect(gain).connect(this.input);
        osc.start();
        this.oscillators.set(id, osc);
        this.gains.set(id, gain);
      }
      if (!props.playing && this.oscillators.has(id)) {
        this.oscillators.get(id)!.stop();
        this.oscillators.delete(id);
        this.gains.delete(id);
      }
      this.oscillators.get(id)?.frequency.setTargetAtTime(freq, this.context.currentTime, 0.02);
      this.gains.get(id)?.gain.setTargetAtTime((props.gain ?? 0.5) * 0.08, this.context.currentTime, 0.02);
    }
    this.ensureSequencer();
  }

  private syncEffects(dubspace: any) {
    const now = this.context.currentTime;
    const meta = state.world?.dubspaceMeta ?? {};
    const delay = dubspace[meta.delay]?.props ?? {};
    const filter = dubspace[meta.filter]?.props ?? {};
    const channel = dubspace[meta.channel]?.props ?? {};
    this.filter.frequency.setTargetAtTime(clamp(Number(filter.cutoff ?? 5000), 80, 5000), now, 0.02);
    this.filter.Q.setTargetAtTime(0.8, now, 0.02);
    this.channel.gain.setTargetAtTime(clamp(Number(channel.gain ?? 0.8), 0, 1.2), now, 0.02);
    this.send.gain.setTargetAtTime(clamp(Number(delay.send ?? 0.3), 0, 1), now, 0.02);
    this.delay.delayTime.setTargetAtTime(clamp(Number(delay.time ?? 0.25), 0.03, 1.2), now, 0.02);
    this.feedback.gain.setTargetAtTime(clamp(Number(delay.feedback ?? 0.35), 0, 0.88), now, 0.02);
    this.wet.gain.setTargetAtTime(clamp(Number(delay.wet ?? 0.4), 0, 0.9), now, 0.02);
  }

  private ensureSequencer() {
    if (this.sequencer) return;
    this.sequencer = window.setInterval(() => this.tickSequencer(), 25);
  }

  private tickSequencer() {
    if (this.context.state !== "running") return;
    const drum = this.dubspace?.[state.world?.dubspaceMeta?.drum]?.props;
    if (!drum?.playing) {
      this.lastStep = -1;
      return;
    }
    const bpm = Number(drum.bpm ?? 118);
    const startedAt = Number(drum.started_at ?? 0);
    if (!startedAt) return;
    if (startedAt !== this.lastStartedAt) {
      this.lastStartedAt = startedAt;
      this.lastStep = -1;
    }
    const stepMs = 30000 / bpm;
    const elapsed = Math.max(0, Date.now() + this.clockOffset - startedAt);
    const step = Math.floor(elapsed / stepMs) % 8;
    if (step === this.lastStep) return;
    this.lastStep = step;
    const pattern = normalizePattern(drum.pattern);
    for (const voice of drumVoices) {
      if (pattern[voice.id][step]) this.triggerVoice(voice.id, step);
    }
  }

  private triggerVoice(voice: string, step: number) {
    if (voice === "kick") this.kick();
    if (voice === "snare") this.noiseHit(0.18, 900, 0.08);
    if (voice === "hat") this.noiseHit(0.05, 7000, 0.035);
    if (voice === "tone") this.tone(330 + (step % 4) * 55);
  }

  private kick() {
    const t = this.context.currentTime;
    const osc = this.context.createOscillator();
    const gain = this.context.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(115, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.16);
    gain.gain.setValueAtTime(0.22, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(gain).connect(this.input);
    osc.start(t);
    osc.stop(t + 0.19);
  }

  private noiseHit(duration: number, cutoff: number, level: number) {
    const t = this.context.currentTime;
    const samples = Math.floor(this.context.sampleRate * duration);
    const buffer = this.context.createBuffer(1, samples, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < samples; i++) data[i] = Math.random() * 2 - 1;
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    source.buffer = buffer;
    filter.type = "highpass";
    filter.frequency.value = cutoff;
    gain.gain.setValueAtTime(level, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    source.connect(filter).connect(gain).connect(this.input);
    source.start(t);
  }

  private tone(freq: number) {
    const t = this.context.currentTime;
    const osc = this.context.createOscillator();
    const gain = this.context.createGain();
    osc.type = "square";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.06, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    osc.connect(gain).connect(this.input);
    osc.start(t);
    osc.stop(t + 0.13);
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]!);
}

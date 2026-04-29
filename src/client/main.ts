import "./styles.css";

type AppState = {
  socket?: WebSocket;
  actor?: string;
  session?: string;
  tab: "dubspace" | "taskspace" | "ide";
  world?: any;
  clockOffset: number;
  liveControls: Record<string, { value: any; actor: string; at: number }>;
  observations: any[];
  selectedObject: string;
  selectedTask?: string;
  compileResult?: any;
};

const state: AppState = {
  tab: "dubspace",
  clockOffset: 0,
  liveControls: {},
  observations: [],
  selectedObject: "delay_1"
};

let audio: DubAudio | undefined;
const sessionKey = "woo.session";
const spaces = ["the_dubspace", "the_taskspace"] as const;
const drumVoices = [
  { id: "kick", label: "Kick" },
  { id: "snare", label: "Snare" },
  { id: "hat", label: "Hat" },
  { id: "tone", label: "Tone" }
] as const;
const directThrottle = new Map<string, number>();

connect();
void refresh();
window.setInterval(pruneLiveControls, 700);

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  state.socket = socket;
  socket.addEventListener("open", () => socket.send(JSON.stringify({ op: "auth", token: authToken() })));
  socket.addEventListener("message", async (event) => {
    const frame = JSON.parse(event.data);
    if (frame.op === "session") {
      state.actor = frame.actor;
      state.session = frame.session;
      storeSession(frame.session);
      requestReplay(socket);
      render();
    }
    if (frame.op === "applied") {
      forgetLiveControls(frame.observations ?? []);
      state.observations.unshift({ seq: frame.seq, space: frame.space, observations: frame.observations, message: frame.message });
      state.observations = state.observations.slice(0, 30);
      rememberSeq(frame.space, frame.seq);
      await refresh();
    }
    if (frame.op === "event") {
      receiveLiveEvent(frame.observation);
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
      if (frame.error?.code === "E_NOSESSION") {
        clearSession();
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: "auth", token: "guest:local" }));
        return;
      }
      state.observations.unshift({ error: frame.error });
      render();
    }
  });
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
  for (const space of spaces) {
    const from = Number(readStorage(`woo.lastSeq.${space}`) ?? "0") + 1;
    if (from > 1) socket.send(JSON.stringify({ op: "replay", id: crypto.randomUUID(), space, from, limit: 100 }));
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
  const response = await fetch("/api/state");
  state.world = await response.json();
  state.clockOffset = Number(state.world.server_time ?? Date.now()) - Date.now();
  audio?.sync(effectiveDubspace(), state.clockOffset);
  render();
}

function call(space: string, target: string, verb: string, args: any[] = []) {
  const id = crypto.randomUUID();
  state.socket?.send(JSON.stringify({ op: "call", id, space, message: { target, verb, args } }));
}

function direct(target: string, verb: string, args: any[] = []) {
  const id = crypto.randomUUID();
  state.socket?.send(JSON.stringify({ op: "direct", id, target, verb, args }));
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
  return copy;
}

function sendPreviewControl(target: string, name: string, value: any) {
  const key = liveKey(target, name);
  state.liveControls[key] = { value, actor: state.actor ?? "", at: Date.now() };
  audio?.sync(effectiveDubspace(), state.clockOffset);
  const last = directThrottle.get(key) ?? 0;
  if (Date.now() - last < 35) return;
  directThrottle.set(key, Date.now());
  direct("the_dubspace", "preview_control", [target, name, value]);
}

function receiveLiveEvent(observation: any) {
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
  const input = document.querySelector<HTMLInputElement>(`[data-control="${observation.target}:${observation.name}"]`);
  if (input && document.activeElement !== input) input.value = String(observation.value);
  audio?.sync(effectiveDubspace(), state.clockOffset);
}

function forgetLiveControls(observations: any[]) {
  for (const obs of observations) {
    if (obs.type === "control_changed" && obs.target && obs.name) delete state.liveControls[liveKey(String(obs.target), String(obs.name))];
  }
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
        <div class="actor">${state.actor ?? "connecting..."}</div>
        ${navButton("dubspace", "Dubspace")}
        ${navButton("taskspace", "Taskspace")}
        ${navButton("ide", "IDE")}
      </aside>
      <main class="main">
        ${state.tab === "dubspace" ? renderDubspace() : ""}
        ${state.tab === "taskspace" ? renderTaskspace() : ""}
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
  if (state.tab === "ide") bindIde();
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
  const slots = ["slot_1", "slot_2", "slot_3", "slot_4"];
  const filter = dub.filter_1?.props ?? {};
  const delay = dub.delay_1?.props ?? {};
  const drum = dub.drum_1?.props ?? {};
  const pattern = normalizePattern(drum.pattern);
  return `
    <section class="toolbar">
      <h1>Dubspace</h1>
      <button data-audio>Audio</button>
      <button data-save-scene>Save Scene</button>
      <button data-recall-scene>Recall Scene</button>
    </section>
    <section class="grid">
      ${slots
        .map((id) => {
          const slot = dub[id]?.props ?? {};
          return `
          <article class="panel slot ${slot.playing ? "playing" : ""}">
            <h2>${dub[id]?.name ?? id}</h2>
            <button data-loop="${id}" data-playing="${slot.playing ? "true" : "false"}">${slot.playing ? "Stop" : "Start"}</button>
            <label>Gain <input data-control="${id}:gain" type="range" min="0" max="1" step="0.01" value="${slot.gain ?? 0.75}"></label>
          </article>`;
        })
        .join("")}
      <article class="panel">
        <h2>Filter</h2>
        <label>Cutoff <input data-control="filter_1:cutoff" type="range" min="80" max="5000" step="1" value="${filter.cutoff ?? 1000}"></label>
      </article>
      <article class="panel">
        <h2>Delay</h2>
        ${slider("delay_1", "send", delay.send ?? 0.3)}
        ${slider("delay_1", "time", delay.time ?? 0.25)}
        ${slider("delay_1", "feedback", delay.feedback ?? 0.35)}
        ${slider("delay_1", "wet", delay.wet ?? 0.4)}
      </article>
      <article class="panel sequencer">
        <div class="panel-head">
          <h2>Percussion</h2>
          <button data-transport="${drum.playing ? "stop" : "start"}">${drum.playing ? "Stop" : "Start"}</button>
        </div>
        <label>BPM <input data-tempo type="range" min="60" max="200" step="1" value="${drum.bpm ?? 118}"><span>${drum.bpm ?? 118}</span></label>
        <div class="steps">
          ${drumVoices.map((voice) => renderStepRow(voice.id, voice.label, pattern[voice.id])).join("")}
        </div>
      </article>
    </section>
  `;
}

function slider(obj: string, prop: string, value: number) {
  return `<label>${prop} <input data-control="${obj}:${prop}" type="range" min="0" max="1" step="0.01" value="${value}"></label>`;
}

function bindDubspace() {
  document.querySelector<HTMLButtonElement>("[data-audio]")?.addEventListener("click", async () => {
    audio ??= new DubAudio();
    await audio.start();
    audio.sync(effectiveDubspace(), state.clockOffset);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-loop]").forEach((button) => {
    button.addEventListener("click", () => {
      const slot = button.dataset.loop!;
      const playing = button.dataset.playing === "true";
      call("the_dubspace", "the_dubspace", playing ? "stop_loop" : "start_loop", [slot]);
    });
  });
  document.querySelectorAll<HTMLInputElement>("[data-control]").forEach((input) => {
    input.addEventListener("input", () => {
      const [target, name] = input.dataset.control!.split(":");
      sendPreviewControl(target, name, Number(input.value));
    });
    input.addEventListener("change", () => {
      const [target, name] = input.dataset.control!.split(":");
      call("the_dubspace", "the_dubspace", "set_control", [target, name, Number(input.value)]);
    });
  });
  document.querySelector<HTMLButtonElement>("[data-transport]")?.addEventListener("click", (event) => {
    const mode = (event.currentTarget as HTMLButtonElement).dataset.transport;
    call("the_dubspace", "the_dubspace", mode === "stop" ? "stop_transport" : "start_transport", []);
  });
  document.querySelector<HTMLInputElement>("[data-tempo]")?.addEventListener("change", (event) => {
    call("the_dubspace", "the_dubspace", "set_tempo", [Number((event.currentTarget as HTMLInputElement).value)]);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-step]").forEach((button) => {
    button.addEventListener("click", () => {
      const [voice, step] = button.dataset.step!.split(":");
      call("the_dubspace", "the_dubspace", "set_drum_step", [voice, Number(step), button.dataset.enabled !== "true"]);
    });
  });
  document.querySelector<HTMLButtonElement>("[data-save-scene]")?.addEventListener("click", () => call("the_dubspace", "the_dubspace", "save_scene", [`Scene ${new Date().toLocaleTimeString()}`]));
  document.querySelector<HTMLButtonElement>("[data-recall-scene]")?.addEventListener("click", () => call("the_dubspace", "the_dubspace", "recall_scene", ["default_scene"]));
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
      <span>${label}</span>
      ${row
        .map(
          (enabled, index) =>
            `<button class="step ${enabled ? "active" : ""}" data-step="${voice}:${index}" data-enabled="${enabled ? "true" : "false"}">${index + 1}</button>`
        )
        .join("")}
    </div>
  `;
}

function renderTaskspace() {
  const taskspace = state.world?.taskspace;
  const tasks = taskspace?.tasks ?? {};
  const roots = taskspace?.root_tasks ?? [];
  const selected = state.selectedTask ? tasks[state.selectedTask] : undefined;
  return `
    <section class="toolbar">
      <h1>Taskspace</h1>
      <input data-new-title placeholder="New task title" />
      <button data-create-task>Create</button>
    </section>
    <section class="split">
      <div class="panel tree">${roots.map((id: string) => renderTaskNode(id, tasks)).join("") || "<p>No tasks yet.</p>"}</div>
      <div class="panel inspector">${selected ? renderTaskInspector(selected) : "<p>Select a task.</p>"}</div>
    </section>
  `;
}

function renderTaskNode(id: string, tasks: any): string {
  const task = tasks[id];
  if (!task) return "";
  const props = task.props;
  return `
    <div class="task-node">
      <button data-select-task="${id}" class="${state.selectedTask === id ? "selected" : ""}">${escapeHtml(props.title)} <span>${props.status}</span></button>
      <div class="children">${(props.subtasks ?? []).map((child: string) => renderTaskNode(child, tasks)).join("")}</div>
    </div>
  `;
}

function renderTaskInspector(task: any) {
  const props = task.props;
  return `
    <h2>${escapeHtml(props.title)}</h2>
    <p>${escapeHtml(props.description ?? "")}</p>
    <div class="row"><strong>Status</strong><span>${props.status}</span></div>
    <div class="row"><strong>Assignee</strong><span>${props.assignee ?? "none"}</span></div>
    <div class="button-row">
      <button data-task-action="claim">Claim</button>
      <button data-task-action="release">Release</button>
      <button data-task-action="status:in_progress">In Progress</button>
      <button data-task-action="status:blocked">Blocked</button>
      <button data-task-action="status:done">Done</button>
    </div>
    <div class="inline-form"><input data-subtask-title placeholder="Subtask title"><button data-add-subtask>Add Subtask</button></div>
    <div class="inline-form"><input data-requirement placeholder="Requirement"><button data-add-requirement>Add Requirement</button></div>
    <ul class="checklist">${(props.requirements ?? [])
      .map((item: any, index: number) => `<li><label><input data-check-req="${index}" type="checkbox" ${item.checked ? "checked" : ""}> ${escapeHtml(item.text)}</label></li>`)
      .join("")}</ul>
    <div class="inline-form"><input data-message placeholder="Message"><button data-add-message>Add Message</button></div>
    <div class="inline-form"><input data-artifact placeholder="https://example.com/artifact"><button data-add-artifact>Add Artifact</button></div>
  `;
}

function bindTaskspace() {
  document.querySelector<HTMLButtonElement>("[data-create-task]")?.addEventListener("click", () => {
    const title = document.querySelector<HTMLInputElement>("[data-new-title]")?.value.trim() || "Untitled";
    call("the_taskspace", "the_taskspace", "create_task", [title, ""]);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-select-task]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedTask = button.dataset.selectTask!;
      render();
    });
  });
  const id = state.selectedTask;
  if (!id) return;
  document.querySelectorAll<HTMLButtonElement>("[data-task-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.taskAction!;
      if (action === "claim" || action === "release") call("the_taskspace", id, action, []);
      if (action.startsWith("status:")) call("the_taskspace", id, "set_status", [action.slice("status:".length)]);
    });
  });
  document.querySelector<HTMLButtonElement>("[data-add-subtask]")?.addEventListener("click", () => {
    const title = document.querySelector<HTMLInputElement>("[data-subtask-title]")?.value.trim() || "Subtask";
    call("the_taskspace", id, "add_subtask", [title, ""]);
  });
  document.querySelector<HTMLButtonElement>("[data-add-requirement]")?.addEventListener("click", () => {
    const text = document.querySelector<HTMLInputElement>("[data-requirement]")?.value.trim() || "Requirement";
    call("the_taskspace", id, "add_requirement", [text]);
  });
  document.querySelectorAll<HTMLInputElement>("[data-check-req]").forEach((input) => {
    input.addEventListener("change", () => call("the_taskspace", id, "check_requirement", [Number(input.dataset.checkReq), input.checked]));
  });
  document.querySelector<HTMLButtonElement>("[data-add-message]")?.addEventListener("click", () => {
    const body = document.querySelector<HTMLInputElement>("[data-message]")?.value.trim() || "Update";
    call("the_taskspace", id, "add_message", [body]);
  });
  document.querySelector<HTMLButtonElement>("[data-add-artifact]")?.addEventListener("click", () => {
    const ref = document.querySelector<HTMLInputElement>("[data-artifact]")?.value.trim() || "https://example.com";
    call("the_taskspace", id, "add_artifact", [{ kind: ref.startsWith("http") ? "url" : "external", ref }]);
  });
}

function renderIde() {
  const objects = Object.keys(state.world?.objects ?? {}).sort();
  const installTarget = state.selectedObject || "delay_1";
  return `
    <section class="toolbar">
      <h1>IDE</h1>
      <select data-object-select>${objects.map((id) => `<option ${id === state.selectedObject ? "selected" : ""}>${id}</option>`).join("")}</select>
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
    const info = await fetch(`/api/object?id=${encodeURIComponent(object)}`).then((response) => response.json());
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
    call("the_dubspace", state.selectedObject, name, [0.62]);
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

  sync(dubspace: any, clockOffset = 0) {
    if (!dubspace) return;
    this.dubspace = dubspace;
    this.clockOffset = clockOffset;
    this.syncEffects(dubspace);
    const freqs: Record<string, number> = { slot_1: 110, slot_2: 146.83, slot_3: 196, slot_4: 261.63 };
    for (const [id, freq] of Object.entries(freqs)) {
      const props = dubspace[id]?.props ?? {};
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
      this.gains.get(id)?.gain.setTargetAtTime((props.gain ?? 0.5) * 0.08, this.context.currentTime, 0.02);
    }
    this.ensureSequencer();
  }

  private syncEffects(dubspace: any) {
    const now = this.context.currentTime;
    const delay = dubspace.delay_1?.props ?? {};
    const filter = dubspace.filter_1?.props ?? {};
    const channel = dubspace.channel_1?.props ?? {};
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
    const drum = this.dubspace?.drum_1?.props;
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

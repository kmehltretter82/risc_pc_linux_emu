// SPDX-License-Identifier: GPL-2.0
// Phase 1: serial-console MVP. The terminal is the real UART; the monitor
// stays dark until the VIDC20 model exists (Phase 2).

"use strict";

const ASSETS = {
  initrd: "assets/initramfs-busybox.cpio.gz",
};
const KERNELS = Object.freeze({
  current: Object.freeze({
    version: "7.2-rc4+",
    url: "assets/zImage",
    detail: "current kernel with three Risc PC fixes",
  }),
  stable: Object.freeze({
    version: "7.1.4",
    url: "assets/zImage-7.1.4",
    detail: "stable kernel with the upstream zImage build fix",
  }),
});
const KERNEL_STORAGE_KEY = "riscpc-boot-kernel";
// Prebuilt by build/build-qemu.sh; provenance in assets/README.md.
const QEMU_JS = "assets/qemu/qemu-system-arm.js";

// QEMU argv. -serial stdio is picked up by emscripten as the module's stdout,
// which is proxied from the worker running main() back to this thread.
const QEMU_ARGS = [
  "-M", "riscpc",
  "-kernel", "/assets/zImage",
  "-initrd", "/assets/initramfs-busybox.cpio.gz",
  "-append", "console=ttyS0 rdinit=/init",
  "-serial", "stdio",
  "-display", "none",
];

const term = new Terminal({
  cols: 80, rows: 24,
  fontFamily: 'ui-monospace, "Cascadia Mono", Menlo, monospace',
  // A modest footprint that remains readable on the emulated workbench. The
  // glass below is measured from the resulting 80 x 24 cell grid.
  fontSize: 13,
  cursorBlink: true,
  theme: {                       // amber phosphor
    background: "#100c04",
    foreground: "#ffb000",
    cursor: "#ffb000",
    selectionBackground: "#7a5a10",
  },
});
const terminalHost = document.getElementById("terminal");
term.open(terminalHost);

const bench = document.querySelector(".bench");
const machine = document.querySelector(".machine");
const vt = document.querySelector(".vt");
const serialCable = document.getElementById("serial-cable");
const serialCablePaths = [...serialCable.querySelectorAll("path")];
const casePlug = document.getElementById("serial-plug-case");
const vtPlug = document.getElementById("serial-plug-vt");
let cableFrame = 0;

function drawSerialCable() {
  cableFrame = 0;
  const benchRect = bench.getBoundingClientRect();
  const machineRect = machine.getBoundingClientRect();
  const vtSectionRect = vt.getBoundingClientRect();
  const caseRect = casePlug.getBoundingClientRect();
  const vtRect = vtPlug.getBoundingClientRect();
  if (!benchRect.width || !benchRect.height || !caseRect.width || !vtRect.width) return;

  const stacked = vtSectionRect.top >= machineRect.bottom - 1;
  const start = {
    x: caseRect.right - benchRect.left,
    y: caseRect.top + caseRect.height / 2 - benchRect.top,
  };
  const end = {
    x: (stacked ? vtRect.right : vtRect.left) - benchRect.left,
    y: vtRect.top + vtRect.height / 2 - benchRect.top,
  };

  let path;
  if (stacked) {
    // Route down the outside when the workbench stacks vertically, keeping
    // the cable clear of the boot-module tray and explanatory captions.
    const outsideX = Math.min(
      benchRect.width - 7,
      Math.max(start.x, end.x) + Math.min(55, benchRect.width * 0.08),
    );
    const bend = Math.min(80, Math.max(32, (end.y - start.y) * 0.24));
    path = `M ${start.x} ${start.y} C ${outsideX} ${start.y + bend}, ` +
      `${outsideX} ${end.y - bend}, ${end.x} ${end.y}`;
  } else {
    // On the desktop the short serial lead hangs in a loose loop between the
    // case and terminal instead of looking like a rigid horizontal bar.
    const slackY = Math.min(
      benchRect.height - 7,
      Math.max(start.y, end.y) + Math.min(90, benchRect.height * 0.16),
    );
    const span = end.x - start.x;
    path = `M ${start.x} ${start.y} C ${start.x + span * 0.28} ${slackY}, ` +
      `${end.x - span * 0.28} ${slackY}, ${end.x} ${end.y}`;
  }

  serialCable.setAttribute("viewBox", `0 0 ${benchRect.width} ${benchRect.height}`);
  for (const cablePath of serialCablePaths) cablePath.setAttribute("d", path);
}

function scheduleSerialCable() {
  if (cableFrame) cancelAnimationFrame(cableFrame);
  cableFrame = requestAnimationFrame(drawSerialCable);
}

const cableObserver = new ResizeObserver(scheduleSerialCable);
for (const element of [bench, machine, vt]) cableObserver.observe(element);
addEventListener("resize", scheduleSerialCable);
requestAnimationFrame(scheduleSerialCable);

// xterm sizes its canvas from the browser's measured monospace cell. Size the
// surrounding glass from that result instead of assuming every browser maps a
// CSS font size to the same glyph width (Safari does not). The initial 640px
// CSS width is only a no-JS/loading fallback.
const terminalScreen = term.element.querySelector(".xterm-screen");
const terminalViewport = term.element.querySelector(".xterm-viewport");

function sizeTerminalGlass() {
  const screen = terminalScreen.getBoundingClientRect();
  if (!screen.width || !screen.height) return;

  const style = getComputedStyle(term.element);
  const pixels = (value) => Number.parseFloat(value) || 0;
  const paddingX = pixels(style.paddingLeft) + pixels(style.paddingRight);
  const paddingY = pixels(style.paddingTop) + pixels(style.paddingBottom);
  const scrollbarWidth = terminalViewport
    ? Math.max(0, terminalViewport.offsetWidth - terminalViewport.clientWidth)
    : 0;

  terminalHost.style.width =
    `${Math.ceil(screen.width + paddingX + scrollbarWidth)}px`;
  terminalHost.style.height = `${Math.ceil(screen.height + paddingY)}px`;
}

new ResizeObserver(() => {
  sizeTerminalGlass();
  scheduleSerialCable();
}).observe(terminalScreen);
requestAnimationFrame(sizeTerminalGlass);
self.__term = term;   // handle for build/test-browser.py

// The terminal's detachable keyboard was DEC's LK201. Its editing and
// function-key sequences below follow the VT220's 7-bit ANSI forms. xterm.js
// still handles physical keyboard input; this layer mirrors those presses on
// the drawn keyboard and gives pointer/touch users a working serial keyboard.
const inputEncoder = new TextEncoder();
let terminalInputSubscription = null;

function sendGuestInput(data) {
  const stdin = self.__rpcStdin;
  if (!stdin) return false;
  for (const byte of inputEncoder.encode(data)) stdin.push(byte);
  return true;
}

function keyDef(id, label, codes, send = null, options = {}) {
  return {
    id, label, send,
    codes: Array.isArray(codes) ? codes : (codes ? [codes] : []),
    ...options,
  };
}

const FUNCTION_KEYS = [
  keyDef("F1", "Hold\nScreen", "F1", null, { className: "key-local", local: true }),
  keyDef("F2", "Print\nScreen", "F2", null, { className: "key-local", local: true }),
  keyDef("F3", "Set-Up", "F3", null, { className: "key-local", local: true }),
  keyDef("F4", "Data/Talk", "F4", null, { className: "key-local", local: true }),
  keyDef("F5", "Break", "F5", null, { className: "key-local", local: true }),
  keyDef("F6", "F6", "F6", "\x1b[17~", { className: "key-function", groupStart: true }),
  keyDef("F7", "F7", "F7", "\x1b[18~", { className: "key-function" }),
  keyDef("F8", "F8", "F8", "\x1b[19~", { className: "key-function" }),
  keyDef("F9", "F9", "F9", "\x1b[20~", { className: "key-function" }),
  keyDef("F10", "F10", "F10", "\x1b[21~", { className: "key-function" }),
  keyDef("F11", "F11\n(ESC)", ["F11", "Escape"], "\x1b[23~", { className: "key-function", groupStart: true }),
  keyDef("F12", "F12\n(BS)", "F12", "\x1b[24~", { className: "key-function" }),
  keyDef("F13", "F13\n(LF)", "F13", "\x1b[25~", { className: "key-function" }),
  keyDef("F14", "F14", "F14", "\x1b[26~", { className: "key-function" }),
  keyDef("Help", "Help", "F15", "\x1b[28~", { className: "key-function", groupStart: true }),
  keyDef("Do", "Do", "F16", "\x1b[29~", { className: "key-function" }),
  keyDef("F17", "F17", "F17", "\x1b[31~", { className: "key-function", groupStart: true }),
  keyDef("F18", "F18", "F18", "\x1b[32~", { className: "key-function" }),
  keyDef("F19", "F19", "F19", "\x1b[33~", { className: "key-function" }),
  keyDef("F20", "F20", "F20", "\x1b[34~", { className: "key-function" }),
];

const characterKey = (id, label, send, shift = null, units = 1) =>
  keyDef(id, label, id, send, { character: true, shift, units });
const letterKey = (letter) => characterKey(
  `Key${letter}`, letter, letter.toLowerCase(), letter,
);

const MAIN_KEY_ROWS = [
  [
    characterKey("Backquote", "~\n`", "`", "~"),
    characterKey("Digit1", "!\n1", "1", "!"),
    characterKey("Digit2", "@\n2", "2", "@"),
    characterKey("Digit3", "#\n3", "3", "#"),
    characterKey("Digit4", "$\n4", "4", "$"),
    characterKey("Digit5", "%\n5", "5", "%"),
    characterKey("Digit6", "^\n6", "6", "^"),
    characterKey("Digit7", "&\n7", "7", "&"),
    characterKey("Digit8", "*\n8", "8", "*"),
    characterKey("Digit9", "(\n9", "9", "("),
    characterKey("Digit0", ")\n0", "0", ")"),
    characterKey("Minus", "_\n-", "-", "_"),
    characterKey("Equal", "+\n=", "=", "+"),
    keyDef("DeleteChar", "Delete", "Backspace", "\x7f", { units: 1.55 }),
  ],
  [
    keyDef("Tab", "Tab", "Tab", "\t", { units: 1.45 }),
    ..."QWERTYUIOP".split("").map(letterKey),
    characterKey("BracketLeft", "{\n[", "[", "{"),
    characterKey("BracketRight", "}\n]", "]", "}"),
    keyDef("Return", "Return", "Enter", "\r", { units: 1.75 }),
  ],
  [
    keyDef("Control", "Ctrl", ["ControlLeft", "ControlRight"], null,
      { units: 1.55, modifier: "control", className: "key-local" }),
    ..."ASDFGHJKL".split("").map(letterKey),
    characterKey("Semicolon", ":\n;", ";", ":"),
    characterKey("Quote", "\"\n'", "'", "\""),
    characterKey("Backslash", "|\n\\", "\\", "|", 1.35),
  ],
  [
    keyDef("ShiftLeft", "Shift", "ShiftLeft", null,
      { units: 2, modifier: "shift", className: "key-local" }),
    ..."ZXCVBNM".split("").map(letterKey),
    characterKey("Comma", "<\n,", ",", "<"),
    characterKey("Period", ">\n.", ".", ">"),
    characterKey("Slash", "?\n/", "/", "?"),
    keyDef("ShiftRight", "Shift", "ShiftRight", null,
      { units: 2.15, modifier: "shift", className: "key-local" }),
  ],
  [
    keyDef("Compose", "Compose\nCharacter", ["AltLeft", "AltRight", "MetaLeft", "MetaRight"],
      null, { units: 2.5, className: "key-local key-wide-label", local: true }),
    characterKey("Space", "", " ", null, 8),
    keyDef("Lock", "Lock", "CapsLock", null,
      { units: 2, modifier: "caps", className: "key-local" }),
  ],
];

const EDIT_KEYS = [
  keyDef("Find", "Find", "Home", "\x1b[1~", { gridColumn: "1", gridRow: "1" }),
  keyDef("InsertHere", "Insert\nHere", "Insert", "\x1b[2~", { gridColumn: "2", gridRow: "1" }),
  keyDef("Remove", "Remove", "Delete", "\x1b[3~", { gridColumn: "3", gridRow: "1" }),
  keyDef("Select", "Select", "End", "\x1b[4~", { gridColumn: "1", gridRow: "2" }),
  keyDef("PrevScreen", "Prev\nScreen", "PageUp", "\x1b[5~", { gridColumn: "2", gridRow: "2" }),
  keyDef("NextScreen", "Next\nScreen", "PageDown", "\x1b[6~", { gridColumn: "3", gridRow: "2" }),
  keyDef("ArrowUp", "↑", "ArrowUp", "\x1b[A", { gridColumn: "2", gridRow: "4", className: "key-arrow" }),
  keyDef("ArrowLeft", "←", "ArrowLeft", "\x1b[D", { gridColumn: "1", gridRow: "5", className: "key-arrow" }),
  keyDef("ArrowDown", "↓", "ArrowDown", "\x1b[B", { gridColumn: "2", gridRow: "5", className: "key-arrow" }),
  keyDef("ArrowRight", "→", "ArrowRight", "\x1b[C", { gridColumn: "3", gridRow: "5", className: "key-arrow" }),
];

const KEYPAD_KEYS = [
  keyDef("PF1", "PF1", "NumLock", "\x1bOP", { gridColumn: "1", gridRow: "1", className: "key-pf" }),
  keyDef("PF2", "PF2", "NumpadDivide", "\x1bOQ", { gridColumn: "2", gridRow: "1", className: "key-pf" }),
  keyDef("PF3", "PF3", "NumpadMultiply", "\x1bOR", { gridColumn: "3", gridRow: "1", className: "key-pf" }),
  keyDef("PF4", "PF4", null, "\x1bOS", { gridColumn: "4", gridRow: "1", className: "key-pf" }),
  keyDef("Numpad7", "7", "Numpad7", "7", { gridColumn: "1", gridRow: "2" }),
  keyDef("Numpad8", "8", "Numpad8", "8", { gridColumn: "2", gridRow: "2" }),
  keyDef("Numpad9", "9", "Numpad9", "9", { gridColumn: "3", gridRow: "2" }),
  keyDef("NumpadMinus", "−", "NumpadSubtract", "-", { gridColumn: "4", gridRow: "2" }),
  keyDef("Numpad4", "4", "Numpad4", "4", { gridColumn: "1", gridRow: "3" }),
  keyDef("Numpad5", "5", "Numpad5", "5", { gridColumn: "2", gridRow: "3" }),
  keyDef("Numpad6", "6", "Numpad6", "6", { gridColumn: "3", gridRow: "3" }),
  keyDef("NumpadComma", ",", "NumpadComma", ",", { gridColumn: "4", gridRow: "3" }),
  keyDef("Numpad1", "1", "Numpad1", "1", { gridColumn: "1", gridRow: "4" }),
  keyDef("Numpad2", "2", "Numpad2", "2", { gridColumn: "2", gridRow: "4" }),
  keyDef("Numpad3", "3", "Numpad3", "3", { gridColumn: "3", gridRow: "4" }),
  keyDef("NumpadEnter", "Enter", "NumpadEnter", "\r",
    { gridColumn: "4", gridRow: "4 / span 2", className: "key-wide-label" }),
  keyDef("Numpad0", "0", "Numpad0", "0", { gridColumn: "1 / span 2", gridRow: "5" }),
  keyDef("NumpadDecimal", ".", "NumpadDecimal", ".", { gridColumn: "3", gridRow: "5" }),
];

const physicalKeyMap = new Map();
const virtualModifiers = { shift: false, control: false, caps: false };
const keyPulseTimers = new WeakMap();

function pulseKeyboardKey(button) {
  clearTimeout(keyPulseTimers.get(button));
  button.classList.add("is-pressed");
  keyPulseTimers.set(button, setTimeout(() => button.classList.remove("is-pressed"), 90));
}

function updateVirtualModifiers() {
  for (const button of document.querySelectorAll(".vt-key[data-modifier]")) {
    const latched = virtualModifiers[button.dataset.modifier];
    button.classList.toggle("is-latched", latched);
    button.setAttribute("aria-pressed", String(latched));
  }
  document.getElementById("keyboard-lock-light").classList.toggle("on", virtualModifiers.caps);
}

function activateKeyboardKey(definition) {
  if (definition.modifier) {
    virtualModifiers[definition.modifier] = !virtualModifiers[definition.modifier];
    updateVirtualModifiers();
    return;
  }
  if (definition.local || definition.send === null) return;

  let data = definition.send;
  if (definition.character) {
    if (/^[a-z]$/.test(data)) {
      const uppercase = virtualModifiers.shift !== virtualModifiers.caps;
      data = uppercase ? data.toUpperCase() : data;
    } else if (virtualModifiers.shift && definition.shift !== null) {
      data = definition.shift;
    }

    if (virtualModifiers.control && data.length === 1) {
      const code = data.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) data = String.fromCharCode(code & 31);
      else if (data === " ") data = "\0";
    }
  }
  sendGuestInput(data);
}

function createKeyboardKey(definition, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `vt-key ${extraClass} ${definition.className || ""}`.trim();
  button.textContent = definition.label;
  button.dataset.keyId = definition.id;
  button.style.setProperty("--key-units", definition.units || 1);
  if (definition.modifier) {
    button.dataset.modifier = definition.modifier;
    button.setAttribute("aria-pressed", "false");
  }
  if (definition.groupStart) button.classList.add("group-start");
  if (definition.gridColumn) button.style.gridColumn = definition.gridColumn;
  if (definition.gridRow) button.style.gridRow = definition.gridRow;
  button.setAttribute("aria-label", definition.label.replace(/\n/g, " ") || "Space");
  if (definition.local) button.title = "Local VT220 key — no serial code";

  for (const code of definition.codes) {
    if (!physicalKeyMap.has(code)) physicalKeyMap.set(code, new Set());
    physicalKeyMap.get(code).add(button);
  }

  button.addEventListener("click", () => {
    pulseKeyboardKey(button);
    activateKeyboardKey(definition);
    term.focus();
  });
  return button;
}

function renderKeyboard() {
  const functionRow = document.getElementById("keyboard-function-row");
  for (const definition of FUNCTION_KEYS) {
    functionRow.append(createKeyboardKey(definition));
  }

  const main = document.getElementById("keyboard-main");
  for (const definitions of MAIN_KEY_ROWS) {
    const row = document.createElement("div");
    row.className = "keyboard-main-row";
    for (const definition of definitions) row.append(createKeyboardKey(definition));
    main.append(row);
  }

  const edit = document.getElementById("keyboard-edit");
  for (const definition of EDIT_KEYS) {
    edit.append(createKeyboardKey(definition, "key-edit key-wide-label"));
  }

  const keypad = document.getElementById("keyboard-keypad");
  for (const definition of KEYPAD_KEYS) keypad.append(createKeyboardKey(definition));
  updateVirtualModifiers();
}

renderKeyboard();

// Capture before xterm.js sees the event so its own event handling cannot hide
// the mechanical animation. xterm remains solely responsible for transmitting
// physical keyboard input, preventing browser shortcuts from being duplicated.
addEventListener("keydown", (event) => {
  for (const button of physicalKeyMap.get(event.code) || []) {
    button.classList.add("is-pressed");
  }
}, true);
addEventListener("keyup", (event) => {
  for (const button of physicalKeyMap.get(event.code) || []) {
    button.classList.remove("is-pressed");
  }
}, true);
addEventListener("blur", () => {
  for (const buttons of physicalKeyMap.values()) {
    for (const button of buttons) button.classList.remove("is-pressed");
  }
});

const powerBtn = document.getElementById("power");
const led = document.getElementById("power-led");
const kernelSelector = document.getElementById("kernel-selector");
const kernelSelection = document.getElementById("kernel-selection");
const kernelInputs = [...document.querySelectorAll('input[name="kernel"]')];
let powerState = "off";

function restoreKernelSelection() {
  let key = "current";
  try {
    const saved = sessionStorage.getItem(KERNEL_STORAGE_KEY);
    if (KERNELS[saved]) key = saved;
  } catch (err) {
    console.warn("kernel selection could not be restored", err);
  }
  const input = kernelInputs.find((candidate) => candidate.value === key);
  if (input) input.checked = true;
  updateKernelSelection();
}

function selectedKernel() {
  const input = kernelInputs.find((candidate) => candidate.checked);
  return KERNELS[input?.value] || KERNELS.current;
}

function updateKernelSelection() {
  const choice = selectedKernel();
  kernelSelection.textContent = `Selected: Linux ${choice.version} — ${choice.detail}.`;
}

function lockKernelSelection(locked) {
  kernelSelector.disabled = locked;
}

for (const input of kernelInputs) {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    try {
      sessionStorage.setItem(KERNEL_STORAGE_KEY, input.value);
    } catch (err) {
      console.warn("kernel selection could not be saved", err);
    }
    updateKernelSelection();
  });
}
restoreKernelSelection();

term.writeln("Acorn RISC PC 600 · serial console · 115200 8N1");
term.writeln("");
term.writeln("Machine is powered off. Press POWER.");

powerBtn.addEventListener("click", async () => {
  if (powerState === "on") {
    hardPowerOff();
    return;
  }
  if (powerState !== "off") return;

  powerState = "starting";
  powerBtn.disabled = true;
  lockKernelSelection(true);
  led.classList.add("busy");
  try {
    await powerOn();
    powerState = "on";
    led.classList.remove("busy");
    led.classList.add("on");
    powerBtn.disabled = false;
    powerBtn.title = "Hard power off";
    powerBtn.setAttribute("aria-pressed", "true");
  } catch (err) {
    powerState = "off";
    led.classList.remove("busy");
    term.writeln(`\r\n\x1b[31m${err.message}\x1b[0m`);
    powerBtn.disabled = false;
    lockKernelSelection(false);
  }
});

function hardPowerOff() {
  powerState = "stopping";
  powerBtn.disabled = true;
  led.classList.remove("busy", "on");
  term.writeln("\r\n\x1b[31m[hard power off]\x1b[0m");

  // The Emscripten module does not expose QEMU's process-exit machinery.
  // Reloading destroys its pthread worker and SharedArrayBuffer immediately,
  // which is the browser equivalent of cutting power. The fresh page comes
  // back in the powered-off state and can start a new machine instance.
  setTimeout(() => location.reload(), 50);
}

async function fetchWithProgress(url, label) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  const total = +resp.headers.get("Content-Length") || 0;
  const reader = resp.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    const pct = total ? Math.floor((got / total) * 100) : "?";
    term.write(`\r\x1b[Kloading ${label}... ${pct}%`);
  }
  term.write(`\r\x1b[Kloading ${label}... ok (${(got / 1024 / 1024).toFixed(1)} MB)\r\n`);
  const buf = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return buf;
}

async function powerOn() {
  if (!self.crossOriginIsolated) {
    throw new Error("not cross-origin isolated — SharedArrayBuffer is " +
                    "unavailable. coi-serviceworker installs on first visit; " +
                    "reload the page once and try again.");
  }

  const probe = await fetch(QEMU_JS, { method: "HEAD" });
  if (!probe.ok) {
    term.writeln("");
    term.writeln("\x1b[33mThe WASM build of QEMU is not deployed yet.\x1b[0m");
    term.writeln("Follow along: github.com/kmehltretter82/risc_pc_linux_emu");
    throw new Error("emulator not deployed");
  }

  const choice = selectedKernel();
  const kernel = await fetchWithProgress(choice.url, `kernel ${choice.version}`);
  const initrd = await fetchWithProgress(ASSETS.initrd, "initramfs");
  term.writeln("");
  await bootQemu(kernel, initrd);
}

async function bootQemu(kernel, initrd) {
  term.reset();
  term.focus();

  // Keystrokes land here on the main thread; build/stdin-proxy.js drains the
  // queue from the worker running QEMU's main loop.
  self.__rpcStdin = [];
  if (terminalInputSubscription) terminalInputSubscription.dispose();
  terminalInputSubscription = term.onData(sendGuestInput);

  // Emscripten's default stdout TTY buffers until LF before calling print().
  // A shell prompt has no LF, so it used to remain invisible until the user
  // pressed Enter. Supplying Module.stdout replaces that TTY with a raw byte
  // device. fd_write() is already proxied from QEMU's worker to this browser
  // thread by Emscripten, so the callback can safely feed xterm.js directly.
  // Batch bytes per microtask: Emscripten invokes stdout once per byte, while
  // xterm.js is much happier receiving chunks.
  const serialDecoder = new TextDecoder();
  let serialBytes = [];
  let serialFlushQueued = false;

  const flushSerial = () => {
    serialFlushQueued = false;
    if (!serialBytes.length) return;
    const bytes = Uint8Array.from(serialBytes);
    serialBytes = [];
    const text = serialDecoder.decode(bytes, { stream: true });
    if (text) term.write(text);
  };

  const writeSerialByte = (byte) => {
    serialBytes.push(byte);
    if (!serialFlushQueued) {
      serialFlushQueued = true;
      queueMicrotask(flushSerial);
    }
  };

  const finishSerial = () => {
    flushSerial();
    const tail = serialDecoder.decode();
    if (tail) term.write(tail);
  };

  // print/printErr are still line-oriented Emscripten diagnostics. Guest
  // serial bytes take the Module.stdout path above and retain their own CR/LF.
  const writeLine = (line) =>
    term.write(line.replace(/\n/g, "\r\n") + "\r\n");

  // The build is MODULARIZE'd and emits an ES module exporting a factory,
  // so this is a dynamic import rather than a <script> tag.
  const moduleArg = {
    arguments: QEMU_ARGS,
    stdout: writeSerialByte,
    print: writeLine,
    printErr: (line) => {
      // emscripten's own diagnostics stay in devtools; guest output shows.
      if (/^warning: unsupported syscall|^Blocking on the main thread/.test(line)) {
        console.warn(line);
      } else {
        writeLine(line);
      }
    },
    preRun: [
      () => {
        moduleArg.FS.mkdir("/assets");
        moduleArg.FS.writeFile("/assets/zImage", kernel);
        moduleArg.FS.writeFile("/assets/initramfs-busybox.cpio.gz", initrd);
      },
    ],
    onAbort: (what) => {
      self.__rpcStdin = null;
      finishSerial();
      term.writeln(`\r\n\x1b[31m[abort] ${what}\x1b[0m`);
    },
    onExit: () => {
      self.__rpcStdin = null;
      if (terminalInputSubscription) terminalInputSubscription.dispose();
      terminalInputSubscription = null;
      finishSerial();
      term.writeln("\r\n\x1b[33m[machine halted]\x1b[0m");
      powerState = "off";
      led.classList.remove("on");
      powerBtn.disabled = false;
      lockKernelSelection(false);
      powerBtn.title = "Power on";
      powerBtn.setAttribute("aria-pressed", "false");
    },
  };

  const { default: createQemu } = await import(new URL(QEMU_JS, location.href).href);
  await createQemu(moduleArg);
}

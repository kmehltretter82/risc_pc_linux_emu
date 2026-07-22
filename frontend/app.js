// SPDX-License-Identifier: GPL-2.0
// Browser front panel for the emulated RISC PC. The canvas is the VIDC20
// framebuffer and the VT220 is the separate, real UART console.

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
const IDE_PATH = "/assets/hda.img";
const IDE_MAX_BYTES = 512 * 1024 * 1024;
const FLOPPY_PATH = "/assets/fd0.img";
// Exact sector counts accepted by QEMU's fd_formats table. Restricting raw
// uploads here prevents a plausible-looking but mis-sized image from silently
// being treated as the controller's fallback 1.44 MB geometry.
const FLOPPY_FORMAT_BYTES = new Set([
  320, 360, 640, 720, 820, 840, 1440, 1600, 1640, 1660, 1760, 2080,
  2240, 2400, 2880, 2952, 2988, 3200, 3360, 3444, 3486, 3520, 3680,
  3840, 5760, 6240, 6400, 7040, 7680,
].map((sectors) => sectors * 512));
const IDE_PERSIST_ROOT = "/persist";
const IDE_PERSIST_CURRENT = `${IDE_PERSIST_ROOT}/hda.img`;
const IDE_PERSIST_FACTORY = `${IDE_PERSIST_ROOT}/factory.img`;
const IDE_PERSIST_META_KEY = "riscpc-persistent-ide";

// QEMU argv. -serial stdio is picked up by emscripten as the module's stdout,
// which is proxied from the worker running main() back to this thread.
const QEMU_ARGS = [
  "-M", "riscpc",
  "-kernel", "/assets/zImage",
  "-initrd", "/assets/initramfs-busybox.cpio.gz",
  // Both consoles live at once: tty0 puts the kernel log on the VIDC20
  // framebuffer, ttyS0 comes last so it stays /dev/console and the VT220
  // beside the machine remains the interactive one.
  "-append", "console=tty0 console=ttyS0 rdinit=/init",
  "-serial", "stdio",
  "-display", "none",
];

// The monitor. qemu/ui/wasm-canvas.c pushes each VIDC20 frame out to this
// canvas from QEMU's worker; build/display-canvas.js does the blit on this
// thread. The canvas resizes itself to whatever mode the guest programs -
// acornfb picks 640x480, NetBSD picks 640x350 - so the glass follows the
// guest rather than the other way round.
const monitorCanvas = document.getElementById("screen");
const nosignal = document.getElementById("nosignal");
self.__rpcCanvas = monitorCanvas;
self.__rpcOnResize = (w, h) => {
  nosignal.hidden = true;
  monitorCanvas.classList.add("live");
  document.getElementById("machine-caption").textContent =
    `VIDC20 output, ${w}x${h}. This is the machine's own framebuffer; ` +
    "click it for the RISC PC keyboard and mouse. The terminal beside it " +
    "is the serial console.";
};

// Browser input crosses from this main thread to QEMU's worker through
// build/display-canvas.js. Each uint32 has an event kind in its high byte and
// a Linux input keycode, mouse button, or signed relative delta in its low
// 16 bits. QEMU then feeds its normal PS/2 and quadrature-mouse handlers.
const RPC_INPUT = Object.freeze({
  KEY_DOWN: 1,
  KEY_UP: 2,
  REL_X: 3,
  REL_Y: 4,
  BUTTON_DOWN: 5,
  BUTTON_UP: 6,
});
const RPC_INPUT_SHIFT = 24;
const RPC_INPUT_QUEUE_LIMIT = 4096;

self.__rpcMachineInput = null;
self.__rpcInputStats = null;

function signedInputValue(packed) {
  const value = packed & 0xffff;
  return value & 0x8000 ? value - 0x10000 : value;
}

function queueMachineInput(kind, rawValue) {
  const queue = self.__rpcMachineInput;
  if (!queue) return false;

  const value = Math.max(-32768, Math.min(32767, Math.round(rawValue)));
  const pending = queue.events.length - queue.head;

  // Mousemove can arrive much faster than the 30 Hz worker-side drain. Merge
  // adjacent deltas to keep latency bounded without losing total movement.
  if ((kind === RPC_INPUT.REL_X || kind === RPC_INPUT.REL_Y) && pending) {
    const lastIndex = queue.events.length - 1;
    const last = queue.events[lastIndex] >>> 0;
    if ((last >>> RPC_INPUT_SHIFT) === kind) {
      const combined = Math.max(-32768, Math.min(
        32767, signedInputValue(last) + value,
      ));
      queue.events[lastIndex] =
        ((kind << RPC_INPUT_SHIFT) | (combined & 0xffff)) >>> 0;
      return true;
    }
  }

  // A pathological stream of pointer movement must not grow memory forever.
  // Preserve discrete key/button transitions once the cap is reached.
  if (pending >= RPC_INPUT_QUEUE_LIMIT) {
    if (kind === RPC_INPUT.REL_X || kind === RPC_INPUT.REL_Y) return false;
    queue.events.splice(queue.head, 1);
  }
  queue.events.push(
    ((kind << RPC_INPUT_SHIFT) | (value & 0xffff)) >>> 0,
  );
  if (self.__rpcInputStats) self.__rpcInputStats.queued++;
  return true;
}

// KeyboardEvent.code describes the physical key, which is exactly what the
// Linux evdev keycodes accepted by QEMU describe. This layout-independent map
// covers the RISC PC keyboard plus the common extended PC keys.
const LINUX_KEY_CODES = Object.freeze({
  Escape: 1,
  Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6,
  Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
  KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20,
  KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
  BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34,
  KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38, Semicolon: 39,
  Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48,
  KeyN: 49, KeyM: 50, Comma: 51, Period: 52, Slash: 53,
  ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, Space: 57,
  CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63,
  F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  NumLock: 69, ScrollLock: 70,
  Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74,
  Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78,
  Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82,
  NumpadDecimal: 83, IntlBackslash: 86, F11: 87, F12: 88,
  IntlRo: 89, NumpadEnter: 96, ControlRight: 97,
  NumpadDivide: 98, PrintScreen: 99, AltRight: 100,
  Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105,
  ArrowRight: 106, End: 107, ArrowDown: 108, PageDown: 109,
  Insert: 110, Delete: 111, NumpadEqual: 117, Pause: 119,
  NumpadComma: 121,
  IntlYen: 124, MetaLeft: 125, MetaRight: 126, ContextMenu: 127,
  F13: 183, F14: 184, F15: 185, F16: 186,
  F17: 187, F18: 188, F19: 189, F20: 190,
});

const monitorHeldKeys = new Map();
const monitorHeldButtons = new Set();

function monitorHasFocus() {
  return document.activeElement === monitorCanvas;
}

function releaseMonitorInput() {
  for (const linuxCode of monitorHeldKeys.values()) {
    queueMachineInput(RPC_INPUT.KEY_UP, linuxCode);
  }
  monitorHeldKeys.clear();
  for (const button of monitorHeldButtons) {
    queueMachineInput(RPC_INPUT.BUTTON_UP, button);
  }
  monitorHeldButtons.clear();
}

addEventListener("keydown", (event) => {
  if (!monitorHasFocus()) return;
  const linuxCode = LINUX_KEY_CODES[event.code];
  if (linuxCode === undefined) return;
  event.preventDefault();
  if (monitorHeldKeys.has(event.code)) return;
  monitorHeldKeys.set(event.code, linuxCode);
  queueMachineInput(RPC_INPUT.KEY_DOWN, linuxCode);
}, true);

addEventListener("keyup", (event) => {
  const linuxCode = monitorHeldKeys.get(event.code);
  if (linuxCode === undefined) return;
  event.preventDefault();
  monitorHeldKeys.delete(event.code);
  queueMachineInput(RPC_INPUT.KEY_UP, linuxCode);
}, true);

monitorCanvas.addEventListener("blur", releaseMonitorInput);
monitorCanvas.addEventListener("pointerdown", (event) => {
  monitorCanvas.focus({ preventScroll: true });
  if (event.button < 0 || event.button > 2) return;
  event.preventDefault();
  if (!monitorHeldButtons.has(event.button)) {
    monitorHeldButtons.add(event.button);
    queueMachineInput(RPC_INPUT.BUTTON_DOWN, event.button);
  }
  try {
    monitorCanvas.setPointerCapture(event.pointerId);
  } catch (err) {
    // Safari can reject capture if the pointer ended during focus handling.
  }
});
monitorCanvas.addEventListener("pointermove", (event) => {
  if (!monitorHasFocus()) return;
  if (event.movementX) queueMachineInput(RPC_INPUT.REL_X, event.movementX);
  if (event.movementY) queueMachineInput(RPC_INPUT.REL_Y, event.movementY);
});
monitorCanvas.addEventListener("pointerup", (event) => {
  if (!monitorHeldButtons.delete(event.button)) return;
  event.preventDefault();
  queueMachineInput(RPC_INPUT.BUTTON_UP, event.button);
});
monitorCanvas.addEventListener("pointercancel", releaseMonitorInput);
monitorCanvas.addEventListener("lostpointercapture", () => {
  for (const button of monitorHeldButtons) {
    queueMachineInput(RPC_INPUT.BUTTON_UP, button);
  }
  monitorHeldButtons.clear();
});
monitorCanvas.addEventListener("contextmenu", (event) => {
  if (monitorHasFocus()) event.preventDefault();
});

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
const ideDrive = document.getElementById("ide-drive");
const ideDriveLabel = document.getElementById("ide-drive-label");
const ideUpload = document.getElementById("ide-upload");
const ideDownload = document.getElementById("ide-download");
const ideSavedChoice = document.getElementById("ide-saved-choice");
const ideUseSaved = document.getElementById("ide-use-saved");
const ideSave = document.getElementById("ide-save");
const ideReset = document.getElementById("ide-reset");
const ideStatus = document.getElementById("ide-status");
const floppyDrive = document.getElementById("floppy-drive");
const floppyUpload = document.getElementById("floppy-upload");
const floppyDownload = document.getElementById("floppy-download");
const floppyStatus = document.getElementById("floppy-status");
let powerState = "off";
let selectedIdeImage = null;
let activeIdeImage = null;
let selectedFloppyImage = null;
let activeFloppyImage = null;
let activeQemuModule = null;
let ideLoading = false;
let floppyLoading = false;
let persistenceBusy = false;
let persistenceReady = false;

function loadSavedIdeMetadata() {
  try {
    const meta = JSON.parse(localStorage.getItem(IDE_PERSIST_META_KEY));
    if (meta && typeof meta.name === "string" && Number.isSafeInteger(meta.size)
        && meta.size > 0 && meta.size <= IDE_MAX_BYTES && meta.size % 512 === 0) {
      return { name: meta.name, size: meta.size, source: "saved" };
    }
  } catch (err) {
    console.warn("saved IDE metadata could not be restored", err);
  }
  return null;
}

let savedIdeImage = loadSavedIdeMetadata();

function storeSavedIdeMetadata(image) {
  savedIdeImage = { name: image.name, size: image.size, source: "saved" };
  try {
    localStorage.setItem(IDE_PERSIST_META_KEY, JSON.stringify(savedIdeImage));
  } catch (err) {
    console.warn("saved IDE metadata could not be recorded", err);
  }
}

function clearSavedIdeMetadata() {
  savedIdeImage = null;
  ideUseSaved.checked = false;
  try {
    localStorage.removeItem(IDE_PERSIST_META_KEY);
  } catch (err) {
    console.warn("saved IDE metadata could not be cleared", err);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function safeDownloadName(name) {
  const leaf = name.replace(/^.*[\\/]/, "").replace(/[^A-Za-z0-9._-]+/g, "_");
  return `modified-${leaf || "riscpc-disk.img"}`;
}

function updateIdeControls() {
  const useSaved = ideUseSaved.checked && savedIdeImage;
  const image = useSaved || selectedIdeImage || activeIdeImage;
  ideSavedChoice.hidden = !savedIdeImage;
  ideDrive.classList.toggle("has-disk", Boolean(image));
  ideDriveLabel.textContent = image
    ? `${image.name} · ${formatBytes(image.size)}`
    : "EMPTY · CLICK TO FIT";
  ideDownload.disabled = !(activeQemuModule && activeIdeImage);
  ideSave.disabled = !(activeQemuModule && activeIdeImage) || persistenceBusy;
  ideReset.disabled = !(activeQemuModule && savedIdeImage && persistenceReady)
    || persistenceBusy;
}

function lockIdeSelection(locked) {
  ideDrive.disabled = locked || ideLoading;
  ideUpload.disabled = locked || ideLoading;
  ideUseSaved.disabled = locked || ideLoading;
}

function updateFloppyControls() {
  const image = selectedFloppyImage || activeFloppyImage;
  floppyDrive.classList.toggle("has-disk", Boolean(image));
  floppyDrive.setAttribute(
    "aria-label",
    image
      ? `Replace floppy disk image ${image.name}`
      : "Select a raw floppy disk image",
  );
  floppyDrive.title = image
    ? `${image.name} · ${formatBytes(image.size)}`
    : "Click to insert a raw floppy disk image";
  floppyDownload.disabled = !(activeQemuModule && activeFloppyImage);
}

function lockFloppySelection(locked) {
  floppyDrive.disabled = locked || floppyLoading;
  floppyUpload.disabled = locked || floppyLoading;
}

function selectedIdeForBoot() {
  if (ideUseSaved.checked && savedIdeImage) return savedIdeImage;
  return selectedIdeImage;
}

function syncPersistentFilesystem(module, populate) {
  return new Promise((resolve, reject) => {
    module.FS.syncfs(populate, (err) => err ? reject(err) : resolve());
  });
}

ideDrive.addEventListener("click", () => ideUpload.click());
ideUpload.addEventListener("change", async () => {
  const file = ideUpload.files?.[0];
  if (!file) return;

  ideLoading = true;
  lockIdeSelection(true);
  if (powerState === "off") powerBtn.disabled = true;
  ideStatus.textContent = `Reading ${file.name}…`;
  try {
    if (!file.size) throw new Error("The disk image is empty.");
    if (file.size > IDE_MAX_BYTES) {
      throw new Error("Disk images are limited to 512 MiB in this browser build.");
    }
    if (file.size % 512) {
      throw new Error("A raw IDE image must contain a whole number of 512-byte sectors.");
    }
    selectedIdeImage = {
      name: file.name,
      size: file.size,
      bytes: new Uint8Array(await file.arrayBuffer()),
      source: "upload",
    };
    ideUseSaved.checked = false;
    activeIdeImage = null;
    activeQemuModule = null;
    persistenceReady = false;
    ideStatus.textContent =
      `${file.name} is ready. It will attach as the primary IDE disk at power-on.`;
  } catch (err) {
    selectedIdeImage = null;
    ideStatus.textContent = err.message;
  } finally {
    ideLoading = false;
    lockIdeSelection(powerState !== "off");
    if (powerState === "off") powerBtn.disabled = false;
    updateIdeControls();
    ideUpload.value = "";
  }
});

floppyDrive.addEventListener("click", () => floppyUpload.click());
floppyUpload.addEventListener("change", async () => {
  const file = floppyUpload.files?.[0];
  if (!file) return;

  floppyLoading = true;
  lockFloppySelection(true);
  if (powerState === "off") powerBtn.disabled = true;
  floppyStatus.textContent = `READING ${file.name}…`;
  try {
    if (!file.size) throw new Error("The floppy image is empty.");
    if (!FLOPPY_FORMAT_BYTES.has(file.size)) {
      throw new Error(
        "Unsupported raw floppy geometry. Use a standard 360K, 720K, " +
        "1.2M, 1.44M, or 2.88M image.",
      );
    }
    selectedFloppyImage = {
      name: file.name,
      size: file.size,
      bytes: new Uint8Array(await file.arrayBuffer()),
    };
    activeFloppyImage = null;
    floppyStatus.textContent =
      `${file.name} is ready · ${formatBytes(file.size)} · inserts at power-on`;
  } catch (err) {
    selectedFloppyImage = null;
    floppyStatus.textContent = err.message;
  } finally {
    floppyLoading = false;
    lockFloppySelection(powerState !== "off");
    if (powerState === "off") powerBtn.disabled = false;
    updateFloppyControls();
    floppyUpload.value = "";
  }
});

ideUseSaved.addEventListener("change", () => {
  if (ideUseSaved.checked && savedIdeImage) {
    ideStatus.textContent =
      `${savedIdeImage.name} will be restored from browser storage at power-on.`;
  } else if (selectedIdeImage) {
    ideStatus.textContent =
      `${selectedIdeImage.name} is ready. It will attach as the primary IDE disk.`;
  } else {
    ideStatus.textContent = "Select a raw disk image before pressing POWER.";
  }
  updateIdeControls();
});

ideDownload.addEventListener("click", () => {
  if (!activeQemuModule || !activeIdeImage) return;
  try {
    const bytes = activeQemuModule.FS.readFile(IDE_PATH);
    const url = URL.createObjectURL(new Blob([bytes], {
      type: "application/octet-stream",
    }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = safeDownloadName(activeIdeImage.name);
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    ideStatus.textContent =
      `Exported ${activeIdeImage.name}. Run sync in the guest before exporting ` +
      "to include its latest cached writes.";
  } catch (err) {
    ideStatus.textContent = `Could not export the disk: ${err.message}`;
  }
});

floppyDownload.addEventListener("click", () => {
  if (!activeQemuModule || !activeFloppyImage) return;
  try {
    const bytes = activeQemuModule.FS.readFile(FLOPPY_PATH);
    const url = URL.createObjectURL(new Blob([bytes], {
      type: "application/octet-stream",
    }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = safeDownloadName(activeFloppyImage.name);
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    floppyStatus.textContent =
      `Exported ${activeFloppyImage.name} · sync the guest before downloading`;
  } catch (err) {
    floppyStatus.textContent = `Could not export the floppy: ${err.message}`;
  }
});

ideSave.addEventListener("click", async () => {
  if (!activeQemuModule || !activeIdeImage || persistenceBusy) return;
  persistenceBusy = true;
  updateIdeControls();
  ideStatus.textContent = `Saving ${activeIdeImage.name} to browser storage…`;
  try {
    const FS = activeQemuModule.FS;
    const current = FS.readFile(IDE_PATH);
    FS.writeFile(IDE_PERSIST_CURRENT, current);

    // A newly uploaded image defines "factory" for this saved disk. A disk
    // restored from IDBFS keeps the factory copy already stored beside it.
    if (activeIdeImage.source === "upload") {
      if (!selectedIdeImage?.bytes) {
        throw new Error("The original upload is no longer available.");
      }
      FS.writeFile(IDE_PERSIST_FACTORY, selectedIdeImage.bytes);
    } else if (!FS.analyzePath(IDE_PERSIST_FACTORY).exists) {
      throw new Error("The saved disk has no factory image.");
    }

    await syncPersistentFilesystem(activeQemuModule, false);
    persistenceReady = true;
    storeSavedIdeMetadata(activeIdeImage);
    ideStatus.textContent =
      `${activeIdeImage.name} is saved in this browser. BOOT SAVED COPY stays ` +
      "opt-in after a reload.";
  } catch (err) {
    ideStatus.textContent = `Could not save the disk: ${err.message}`;
  } finally {
    persistenceBusy = false;
    updateIdeControls();
  }
});

ideReset.addEventListener("click", async () => {
  if (!activeQemuModule || !savedIdeImage || persistenceBusy) return;
  persistenceBusy = true;
  updateIdeControls();
  ideStatus.textContent = "Resetting the saved copy to its factory image…";
  try {
    const FS = activeQemuModule.FS;
    const factory = FS.readFile(IDE_PERSIST_FACTORY);
    FS.writeFile(IDE_PERSIST_CURRENT, factory);
    await syncPersistentFilesystem(activeQemuModule, false);
    ideStatus.textContent =
      "Saved copy reset to factory. The currently running disk is unchanged; " +
      "power off and choose BOOT SAVED COPY to use the reset image.";
  } catch (err) {
    ideStatus.textContent = `Could not reset the saved disk: ${err.message}`;
  } finally {
    persistenceBusy = false;
    updateIdeControls();
  }
});

updateIdeControls();
updateFloppyControls();
if (savedIdeImage) {
  ideStatus.textContent =
    `${savedIdeImage.name} is stored in this browser. Tick BOOT SAVED COPY ` +
    "to use it; the default remains ephemeral.";
}

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
  lockIdeSelection(true);
  lockFloppySelection(true);
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
    lockIdeSelection(false);
    lockFloppySelection(false);
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
  await bootQemu(kernel, initrd, selectedIdeForBoot(), selectedFloppyImage);
}

async function bootQemu(kernel, initrd, ideImage, floppyImage) {
  term.reset();
  term.focus();

  releaseMonitorInput();
  self.__rpcMachineInput = { events: [], head: 0 };
  self.__rpcInputStats = { queued: 0, popped: 0, poppedByType: {} };
  monitorCanvas.__rpcReady = false;
  monitorCanvas.__rpcImage = null;
  monitorCanvas.classList.remove("live");
  nosignal.hidden = false;
  persistenceReady = false;

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

  const qemuArguments = [...QEMU_ARGS];
  if (ideImage) {
    qemuArguments.push(
      "-drive", `file=${IDE_PATH},format=raw,if=ide,index=0`,
    );
  }
  if (floppyImage) {
    qemuArguments.push(
      "-drive", `file=${FLOPPY_PATH},format=raw,if=floppy,index=0`,
    );
  }
  let persistenceLoadError = null;

  // The build is MODULARIZE'd and emits an ES module exporting a factory,
  // so this is a dynamic import rather than a <script> tag.
  const moduleArg = {
    arguments: qemuArguments,
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
        moduleArg.FS.mkdir(IDE_PERSIST_ROOT);
        moduleArg.FS.mount(
          moduleArg.FS.filesystems.IDBFS, {}, IDE_PERSIST_ROOT,
        );

        if (ideImage?.source === "saved") {
          const dependency = "riscpc-load-saved-ide";
          moduleArg.addRunDependency(dependency);
          moduleArg.FS.syncfs(true, (err) => {
            try {
              if (err) throw err;
              const saved = moduleArg.FS.readFile(IDE_PERSIST_CURRENT);
              if (saved.length !== ideImage.size) {
                throw new Error("saved disk size does not match its metadata");
              }
              if (!moduleArg.FS.analyzePath(IDE_PERSIST_FACTORY).exists) {
                throw new Error("saved disk has no factory image");
              }
              moduleArg.FS.writeFile(IDE_PATH, saved);
              persistenceReady = true;
            } catch (loadErr) {
              persistenceLoadError = loadErr;
              clearSavedIdeMetadata();
              // Keep QEMU's command line valid and make recovery possible even
              // if site storage was cleared independently of localStorage.
              moduleArg.FS.writeFile(IDE_PATH, new Uint8Array(ideImage.size));
            } finally {
              moduleArg.removeRunDependency(dependency);
            }
          });
        } else if (ideImage) {
          moduleArg.FS.writeFile(IDE_PATH, ideImage.bytes);
        }
        if (floppyImage) {
          moduleArg.FS.writeFile(FLOPPY_PATH, floppyImage.bytes);
        }
      },
    ],
    onAbort: (what) => {
      self.__rpcStdin = null;
      self.__rpcMachineInput = null;
      monitorHeldKeys.clear();
      monitorHeldButtons.clear();
      finishSerial();
      term.writeln(`\r\n\x1b[31m[abort] ${what}\x1b[0m`);
    },
    onExit: () => {
      self.__rpcStdin = null;
      self.__rpcMachineInput = null;
      monitorHeldKeys.clear();
      monitorHeldButtons.clear();
      if (terminalInputSubscription) terminalInputSubscription.dispose();
      terminalInputSubscription = null;
      finishSerial();
      term.writeln("\r\n\x1b[33m[machine halted]\x1b[0m");
      powerState = "off";
      led.classList.remove("on");
      powerBtn.disabled = false;
      lockKernelSelection(false);
      lockIdeSelection(false);
      lockFloppySelection(false);
      powerBtn.title = "Power on";
      powerBtn.setAttribute("aria-pressed", "false");
    },
  };

  const { default: createQemu } = await import(new URL(QEMU_JS, location.href).href);
  const instance = await createQemu(moduleArg);
  activeQemuModule = instance;
  activeIdeImage = ideImage ? {
    name: ideImage.name,
    size: ideImage.size,
    source: ideImage.source,
  } : null;
  activeFloppyImage = floppyImage ? {
    name: floppyImage.name,
    size: floppyImage.size,
  } : null;
  if (persistenceLoadError) {
    ideStatus.textContent =
      `The saved disk could not be restored (${persistenceLoadError.message}). ` +
      "A blank recovery disk was attached; select the original image again.";
  } else if (activeIdeImage) {
    ideStatus.textContent =
      `${activeIdeImage.name} is attached read/write. Run sync in the guest ` +
      "before downloading a modified copy.";
  }
  updateIdeControls();
  if (activeFloppyImage) {
    floppyStatus.textContent =
      `${activeFloppyImage.name} is inserted read/write · sync before downloading`;
  }
  updateFloppyControls();
}

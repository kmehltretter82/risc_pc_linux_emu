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

new ResizeObserver(sizeTerminalGlass).observe(terminalScreen);
requestAnimationFrame(sizeTerminalGlass);
self.__term = term;   // handle for build/test-browser.py

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
  const stdin = (self.__rpcStdin = []);
  term.onData((data) => {
    for (const byte of new TextEncoder().encode(data)) stdin.push(byte);
  });

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
      finishSerial();
      term.writeln(`\r\n\x1b[31m[abort] ${what}\x1b[0m`);
    },
    onExit: () => {
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

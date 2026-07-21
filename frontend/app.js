// SPDX-License-Identifier: GPL-2.0
// Phase 1: serial-console MVP. The terminal is the real UART; the monitor
// stays dark until the VIDC20 model exists (Phase 2).

"use strict";

const ASSETS = {
  kernel: "assets/zImage",
  initrd: "assets/initramfs-busybox.cpio.gz",
};
const QEMU_JS = "qemu/qemu-system-arm.js";   // produced by build/build-qemu.sh

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
  fontSize: 14,
  cursorBlink: true,
  theme: {                       // amber phosphor
    background: "#100c04",
    foreground: "#ffb000",
    cursor: "#ffb000",
    selectionBackground: "#7a5a10",
  },
});
term.open(document.getElementById("terminal"));
self.__term = term;   // handle for build/test-browser.py

const powerBtn = document.getElementById("power");
const led = document.getElementById("power-led");

term.writeln("Acorn RISC PC 600 · serial console · 115200 8N1");
term.writeln("");
term.writeln("Machine is powered off. Press POWER.");

powerBtn.addEventListener("click", async () => {
  powerBtn.disabled = true;
  led.classList.add("busy");
  try {
    await powerOn();
    led.classList.remove("busy");
    led.classList.add("on");
  } catch (err) {
    led.classList.remove("busy");
    term.writeln(`\r\n\x1b[31m${err.message}\x1b[0m`);
    powerBtn.disabled = false;
  }
});

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

  const kernel = await fetchWithProgress(ASSETS.kernel, "zImage");
  const initrd = await fetchWithProgress(ASSETS.initrd, "initramfs");
  term.writeln("");
  await bootQemu(kernel, initrd);
}

async function bootQemu(kernel, initrd) {
  term.reset();
  term.focus();

  // QEMU's main() runs in a worker (-sPROXY_TO_PTHREAD), so the guest's
  // console arrives here through emscripten's stdout proxying rather than
  // through a pty. That is also why the console is currently read-only:
  // see build/build-qemu.sh (XTERM_PTY) for the input story.
  const write = (line) => term.write(line.replace(/\n/g, "\r\n") + "\r\n");

  // The build is MODULARIZE'd and emits an ES module exporting a factory,
  // so this is a dynamic import rather than a <script> tag.
  const moduleArg = {
    arguments: QEMU_ARGS,
    print: write,
    printErr: (line) => {
      // emscripten's own diagnostics stay in devtools; guest output shows.
      if (/^warning: unsupported syscall|^Blocking on the main thread/.test(line)) {
        console.warn(line);
      } else {
        write(line);
      }
    },
    preRun: [
      () => {
        moduleArg.FS.mkdir("/assets");
        moduleArg.FS.writeFile("/assets/zImage", kernel);
        moduleArg.FS.writeFile("/assets/initramfs-busybox.cpio.gz", initrd);
      },
    ],
    onAbort: (what) => term.writeln(`\r\n\x1b[31m[abort] ${what}\x1b[0m`),
    onExit: () => {
      term.writeln("\r\n\x1b[33m[machine halted]\x1b[0m");
      led.classList.remove("on");
      powerBtn.disabled = false;
    },
  };

  const { default: createQemu } = await import(new URL(QEMU_JS, location.href).href);
  await createQemu(moduleArg);
}

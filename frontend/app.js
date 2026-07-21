// SPDX-License-Identifier: GPL-2.0
// Phase 1: serial-console MVP. The terminal is the real UART; the monitor
// stays dark until the VIDC20 model exists (Phase 2).

"use strict";

const ASSETS = {
  kernel: "assets/zImage",
  initrd: "assets/initramfs-busybox.cpio.gz",
};
const QEMU_JS = "qemu/qemu-system-arm.js";   // produced by build/build-qemu.sh

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
banner();

const powerBtn = document.getElementById("power");
const led = document.getElementById("power-led");

powerBtn.addEventListener("click", async () => {
  powerBtn.disabled = true;
  led.classList.add("busy");
  try {
    await powerOn();
    led.classList.remove("busy");
    led.classList.add("on");
  } catch (err) {
    led.classList.remove("busy");
    term.writeln(`\r\n\x1b[31mpower-on failed: ${err.message}\x1b[0m`);
    powerBtn.disabled = false;
  }
});

function banner() {
  term.writeln("Acorn RISC PC 600 · serial console · 115200 8N1");
  term.writeln("");
  term.writeln("Machine is powered off. Press POWER.");
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
  if (!crossOriginIsolated) {
    term.writeln("\r\n\x1b[33mwarning: not cross-origin isolated; " +
                 "SharedArrayBuffer unavailable (coi-serviceworker should fix " +
                 "this after one reload)\x1b[0m");
  }
  // Is the emulator deployed yet?
  const probe = await fetch(QEMU_JS, { method: "HEAD" });
  if (!probe.ok) {
    term.writeln("");
    term.writeln("\x1b[33mThe WASM build of QEMU is not deployed yet " +
                 "(Phase 1 in progress).\x1b[0m");
    term.writeln("Follow along: github.com/kmehltretter82/risc_pc_linux_emu");
    throw new Error("emulator not deployed");
  }

  const kernel = await fetchWithProgress(ASSETS.kernel, "zImage");
  const initrd = await fetchWithProgress(ASSETS.initrd, "initramfs");
  term.writeln("starting qemu-system-arm -M riscpc ...\r\n");
  await bootQemu(kernel, initrd);
}

// Wiring to the Emscripten module lands after Milestone A (kernel boots
// under node). It will: place kernel/initrd into the module FS, start the
// module with the canonical riscpc arguments, and bridge the serial
// chardev to this terminal (term.onData -> UART rx, UART tx -> term.write).
async function bootQemu(kernel, initrd) {
  throw new Error("bootQemu: not wired yet (Milestone A pending)");
}

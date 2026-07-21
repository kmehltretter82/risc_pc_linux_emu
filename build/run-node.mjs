// SPDX-License-Identifier: GPL-2.0
// Milestone A harness: boot the wasm QEMU under node, outside any browser.
// Usage: node build/run-node.mjs [assets-dir] [kernel-file]
//
// The generated loader is an ES module exporting a factory, so this is an
// .mjs and imports it. Assets are read from disk and written into MEMFS,
// which is deliberately the same path the browser takes with its fetched
// copies - this harness exercises the wiring the page will use, not a
// node-only shortcut (NODEFS would need -lnodefs.js and test less).
// emscripten-pty.js is linked into the module and always reads Module.pty,
// so we hand it a pty here too, driven by this process's stdio instead of
// an xterm.js instance.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { openpty } = require(path.join(here, "..", "frontend", "vendor", "xterm-pty.js"));

const assetsDir = path.resolve(process.argv[2] || path.join(here, "..", "assets"));
const kernelFile = process.argv[3] || "zImage";
const qemuJs = path.join(here, "out", "qemu-system-arm.js");

const { master, slave } = openpty();

// Minimal stand-in for the xterm.js side of the pty.
const noop = { dispose() {} };
master.activate({
  write: (data, ack) => { process.stdout.write(Buffer.from(data)); if (ack) ack(); },
  onData: (handler) => {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on("data", (d) => handler(d.toString("binary")));
    return noop;
  },
  onBinary: () => noop,
  onResize: () => noop,
});

const moduleArg = {
  arguments: [
    "-M", "riscpc",
    "-kernel", "/assets/zImage",
    "-initrd", "/assets/initramfs-busybox.cpio.gz",
    "-append", "console=ttyS0 rdinit=/init",
    "-serial", "stdio",
    "-display", "none",
  ],
  pty: slave,
  preRun: [
    () => {
      moduleArg.FS.mkdir("/assets");
      moduleArg.FS.writeFile("/assets/zImage",
        fs.readFileSync(path.join(assetsDir, kernelFile)));
      moduleArg.FS.writeFile("/assets/initramfs-busybox.cpio.gz",
        fs.readFileSync(path.join(assetsDir, "initramfs-busybox.cpio.gz")));
    },
  ],
  printErr: (t) => process.stderr.write(t + "\n"),
  onAbort: (what) => {
    process.stderr.write(`\n[abort] ${what}\n`);
    process.exitCode = 1;
  },
};

process.stderr.write(`[harness] assets=${assetsDir} kernel=${kernelFile}\n`);
const createQemu = (await import(pathToFileURL(qemuJs).href)).default;
await createQemu(moduleArg);

// SPDX-License-Identifier: GPL-2.0
// Milestone A harness: boot the wasm QEMU under node, outside any browser.
// Usage: node build/run-node.mjs [assets-dir] [kernel-file]
// Set QEMU_BUILD_OUT to test a side build without replacing build/out.
// Set QEMU_BOOT_TEST=1 for a non-interactive BusyBox + uname smoke test.
// Set QEMU_MACHINE=netwinder to boot the serial-only NetWinder target.
//
// The generated loader is an ES module exporting a factory, so this is an
// .mjs and imports it. Assets are read from disk and written into MEMFS,
// which is deliberately the same path the browser takes with its fetched
// copies - this harness exercises the wiring the page will use, not a
// node-only shortcut (NODEFS would need -lnodefs.js and test less).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const assetsDir = path.resolve(process.argv[2] || path.join(here, "..", "assets"));
const machineKey = process.env.QEMU_MACHINE || "riscpc";
const machines = {
  riscpc: {
    qemu: "riscpc",
    kernel: "zImage",
    append: "console=tty0 console=ttyS0 rdinit=/init",
    extraSerial: [],
  },
  netwinder: {
    qemu: "netwinder",
    kernel: "zImage-netwinder",
    append: "console=ttyS0 rdinit=/init",
    extraSerial: ["-serial", "null", "-serial", "null"],
  },
};
const machine = machines[machineKey];
if (!machine) {
  throw new Error(`QEMU_MACHINE must be one of: ${Object.keys(machines).join(", ")}`);
}
const kernelFile = process.argv[3] || machine.kernel;
const qemuBuildOut = path.resolve(process.env.QEMU_BUILD_OUT || path.join(here, "out"));
const qemuJs = path.join(qemuBuildOut, "qemu-system-arm.js");

// stdin-proxy.js pulls bytes from the same main-thread queue used by the
// browser page. Module.stdout bypasses Emscripten's line-buffered default so
// prompts without a newline are visible here too.
globalThis.__rpcStdin = [];
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("data", (data) => globalThis.__rpcStdin.push(...data));

const bootTest = process.env.QEMU_BOOT_TEST === "1";
const bootTimeout = Number(process.env.QEMU_BOOT_TIMEOUT || 120) * 1000;
let bootOutput = "";
let probeSent = false;
let bootPassed = false;
const bootTimer = bootTest ? setTimeout(() => {
  process.stderr.write("\n[harness] FAIL: guest did not answer uname -m\n");
  process.exit(1);
}, bootTimeout) : null;

function stdout(byte) {
  process.stdout.write(Buffer.from([byte]));
  if (!bootTest || bootPassed) return;

  bootOutput = (bootOutput + String.fromCharCode(byte)).slice(-262144);
  if (!probeSent && bootOutput.includes("BusyBox on ARMv4")
      && bootOutput.endsWith("# ")) {
    globalThis.__rpcStdin.push(...Buffer.from("uname -m\n"));
    probeSent = true;
  }
  if (probeSent && /[\r\n]armv4l[\r\n]/.test(bootOutput)) {
    bootPassed = true;
    clearTimeout(bootTimer);
    process.stderr.write("\n[harness] PASS: BusyBox answered armv4l\n");
    setImmediate(() => process.exit(0));
  }
}

const moduleArg = {
  arguments: [
    "-M", machine.qemu,
    "-kernel", "/assets/zImage",
    "-initrd", "/assets/initramfs-busybox.cpio.gz",
    "-append", machine.append,
    "-serial", "stdio",
    ...machine.extraSerial,
    "-display", "none",
  ],
  stdout,
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

process.stderr.write(
  `[harness] qemu=${qemuJs} machine=${machineKey} ` +
  `assets=${assetsDir} kernel=${kernelFile}\n`,
);
const createQemu = (await import(pathToFileURL(qemuJs).href)).default;
await createQemu(moduleArg);

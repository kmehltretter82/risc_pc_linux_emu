// SPDX-License-Identifier: GPL-2.0
// Milestone A harness: boot the wasm QEMU under node, outside any browser.
// Usage: node build/run-node.js [assets-dir]
//
// Host assets are mounted via NODEFS rather than preloaded, so the same
// build serves the browser (which writes fetched images into MEMFS instead).

const path = require("path");

const assetsDir = path.resolve(process.argv[2] || path.join(__dirname, "..", "assets"));
const qemuJs = path.join(__dirname, "out", "qemu-system-arm.js");

globalThis.Module = {
  arguments: [
    "-M", "riscpc",
    "-kernel", "/assets/zImage",
    "-initrd", "/assets/initramfs-busybox.cpio.gz",
    "-append", "console=ttyS0 rdinit=/init",
    "-serial", "stdio",
    "-display", "none",
  ],
  preRun: [
    function () {
      const M = globalThis.Module;
      M.FS.mkdir("/assets");
      M.FS.mount(M.NODEFS, { root: assetsDir }, "/assets");
    },
  ],
  print: (t) => process.stdout.write(t + "\n"),
  printErr: (t) => process.stderr.write(t + "\n"),
  onAbort: (what) => {
    process.stderr.write(`\n[abort] ${what}\n`);
    process.exitCode = 1;
  },
};

process.stderr.write(`[harness] assets=${assetsDir}\n`);
require(qemuJs);

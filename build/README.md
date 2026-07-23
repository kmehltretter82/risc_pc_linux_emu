# build/ — reproducible emulator and userspace builds

The scripts in this directory produce the prebuilt artifacts served from
`assets/`:

- `env.sh` — pinned emsdk 4.0.23 environment and Wasm build flags
- dependency cross-build recipes (glib, zlib, libffi, pixman) following
  [ktock/qemu-wasm](https://github.com/ktock/qemu-wasm)
- `build-qemu.sh` — QEMU configure/build script for the `qemu/` submodule
  (`--target-list=arm-softmmu`, Emscripten host, native Wasm TCG backend,
  device list trimmed to the selectable RISC PC and NetWinder boards). Set
  `QEMU_TCG_BACKEND=tci` only for the interpreted fallback.
- `build-initramfs.sh` — deterministic BusyBox 1.38.0 initramfs build, with its
  exact config, `/init`, unprivileged `newc` writer and strict ARMv4
  musl-cross-make inputs beside it
- `test-provenance.py` — CI gate matching every served binary to the checksums
  and source pins in `assets/README.md`

`run-node.mjs` boots the RiscPC under Emscripten's Node runtime. Set
`QEMU_MACHINE=netwinder` for the second board, `QEMU_BOOT_TEST=1` for the
automated BusyBox/`uname -m` gate, and
`QEMU_BUILD_OUT` to test a clean side build. `WASM_DEPS_DIR` gives both build
scripts a side dependency prefix; the prefix is stamped with its Emscripten
version so a 4.0.10 cache cannot be reused accidentally. For example:

```sh
WASM_DEPS_DIR=/tmp/riscpc-wasm-deps ./build/build-deps.sh
WASM_DEPS_DIR=/tmp/riscpc-wasm-deps \
  QEMU_BUILD_OUT=/tmp/riscpc-qemu-wasm ./build/build-qemu.sh
QEMU_BUILD_OUT=/tmp/riscpc-qemu-wasm QEMU_BOOT_TEST=1 \
  node build/run-node.mjs
```

`test-browser.py` is the full Chromium boot, input, storage and layout gate used
before GitHub Pages deployment. It runs the complete RISC PC path, switches the
board selector, then requires NetWinder PCI, IDE, Tulip and shell output. See
`assets/README.md` for the exact source pins and rebuild commands.

# build/ — reproducible emulator and userspace builds

The scripts in this directory produce the prebuilt artifacts served from
`assets/`:

- `env.sh` — pinned emsdk 4.0.10 environment and Wasm build flags
- dependency cross-build recipes (glib, zlib, libffi, pixman) following
  [ktock/qemu-wasm](https://github.com/ktock/qemu-wasm)
- `build-qemu.sh` — QEMU configure/build script for the `qemu/` submodule
  (`--target-list=arm-softmmu`, Emscripten host, TCI backend, device list
  trimmed to what `-M riscpc` needs)
- `build-initramfs.sh` — deterministic BusyBox 1.38.0 initramfs build, with its
  exact config, `/init`, unprivileged `newc` writer and strict ARMv4
  musl-cross-make inputs beside it
- `test-provenance.py` — CI gate matching every served binary to the checksums
  and source pins in `assets/README.md`

`run-node.mjs` boots the RiscPC under Emscripten's Node runtime;
`test-browser.py` is the full Chromium boot, input, storage and layout gate used
before GitHub Pages deployment. See `assets/README.md` for the exact source pins
and rebuild commands.

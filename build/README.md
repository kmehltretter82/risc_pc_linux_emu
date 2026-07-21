# build/ — Emscripten build of QEMU (Phase 1)

Will contain:

- `Dockerfile` — pinned emsdk image
- dependency cross-build recipes (glib, zlib, libffi, pixman) following
  [ktock/qemu-wasm](https://github.com/ktock/qemu-wasm)
- QEMU configure/build script for the `qemu/` submodule
  (`--target-list=arm-softmmu`, Emscripten host, TCI backend, device list
  trimmed to what `-M riscpc` needs)

Milestone A (before any browser work): the wasm build boots the rpc kernel
under Emscripten's node runtime.

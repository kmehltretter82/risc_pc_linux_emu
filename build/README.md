# build/ — reproducible emulator and userspace builds

The scripts in this directory produce the prebuilt artifacts served from
`assets/`:

- `env.sh` — pinned emsdk 4.0.23 environment and Wasm build flags
- dependency cross-build recipes (glib, zlib, libffi, pixman) following
  [ktock/qemu-wasm](https://github.com/ktock/qemu-wasm)
- `build-qemu.sh` — QEMU configure/build script for the `qemu/` submodule
  (`--target-list=arm-softmmu`, Emscripten host, native Wasm TCG backend,
  device list trimmed to what `-M riscpc` needs). Set
  `QEMU_TCG_BACKEND=tci` only for the interpreted fallback.
- `build-initramfs.sh` — deterministic BusyBox 1.38.0 initramfs build, with its
  exact config, `/init`, unprivileged `newc` writer and strict ARMv4
  musl-cross-make inputs beside it
- `build-netbsd-userland.sh` — SHA-512-pinned NetBSD 10.1 source and acorn32
  binary sets, the two recorded kernel fixes, a cross-built GENERIC kernel and
  an unprivileged 384 MiB FFSv1 root image
- `test-netbsd-userland.py` — native-QEMU gate that answers the framebuffer
  boot prompts and requires a marker plus `uname -p` from the userland root
  shell
- `test-provenance.py` — CI gate matching every served binary to the checksums
  and source pins in `assets/README.md`

`run-node.mjs` boots the RiscPC under Emscripten's Node runtime. Set
`QEMU_BOOT_TEST=1` for the automated BusyBox/`uname -m` gate and
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
before GitHub Pages deployment. See `assets/README.md` for the exact source pins
and rebuild commands.

## NetBSD/acorn32 userland

NetBSD 10.1's bundled host tools predate GCC 15's C23 default, so the tested
build uses GCC 14. The script downloads and verifies the official source sets
and the acorn32 `base`, `etc`, and `rescue` sets, builds the patched kernel, and
uses NetBSD's own `MAKEDEV` metadata and `makefs` tool to create the filesystem
without root privileges:

```sh
NETBSD_HOST_CC=gcc-14 ./build/build-netbsd-userland.sh
```

The default outputs are
`build/out/netbsd-10.1/netbsd-GENERIC` and
`build/out/netbsd-10.1/netbsd-10.1-riscpc.ffs`. A side build can set
`NETBSD_BUILD_ROOT`; `JOBS`, `NETBSD_HOST_CC`, `NETBSD_IMAGE_SIZE`, and
`SOURCE_DATE_EPOCH` are also configurable.

Boot the raw FFS image through the RiscPC IDE model:

```sh
qemu/build/qemu-system-arm -M riscpc -m 64M \
  -kernel build/out/netbsd-10.1/netbsd-GENERIC \
  -drive if=ide,file=build/out/netbsd-10.1/netbsd-10.1-riscpc.ffs,format=raw,snapshot=on \
  -display gtk -serial none
```

At the framebuffer prompts, select `wd0a` for the root device and accept the
defaults for dump device, filesystem type, and init path. The stock `etc` set
deliberately leaves `rc_configured=NO`; after multi-user boot is aborted, press
Enter for a root shell.

The native regression uses a disposable qcow2 overlay, boots through those
prompts, and has the root shell redirect a unique marker plus `uname -p` to the
emulated UART. It passes only after the host captures both the marker and
`earmv4`:

```sh
./build/test-netbsd-userland.py
```

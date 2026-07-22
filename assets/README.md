# Prebuilt boot assets — provenance

**Rule (enforced by review, later by CI): no binary ships unless this file names
the public commit it was built from.**

| File | What | Source | License |
|---|---|---|---|
| `zImage` | Linux 7.2.0-rc4+ for `ARCH_RPC` (Acorn RiscPC), md5 `9b9f0f45806c5ee160f8c04e2caf8e18` | [kmehltretter82/linux](https://github.com/kmehltretter82/linux) branch `riscpc-emu`, commit `36ea1cf6b8d1c802f4121a8032d4f5d58f5a8283` (= tag `v7.2-rc4` + 3 fix patches found on this emulated hardware) — built from a clean checkout of that commit and boot-verified | GPL-2.0 |
| `zImage.config` | exact kernel config used for `zImage` | same commit, `rpc_defconfig`-derived | GPL-2.0 |
| `zImage-7.1.4` | Linux 7.1.4 stable for `ARCH_RPC`, md5 `e0ef1cbbfecb652ce6a3712d742fb624` | kernel.org stable commit [`7a5cef0db4795d9d453a12e0f61b5b7634fc4d40`](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/commit/?id=7a5cef0db4795d9d453a12e0f61b5b7634fc4d40) plus only upstream commit [`470ea955a18c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=470ea955a18c76eeb10ca11ffcb2fe923bfc5515), which fixes the RiscPC ARM zImage build — gcc-8 build and boot-verified | GPL-2.0 |
| `zImage-7.1.4.config` | exact kernel config used for `zImage-7.1.4` | same source, seeded from `zImage.config` then normalized with `olddefconfig` | GPL-2.0 |
| `initramfs-busybox.cpio.gz` | BusyBox userspace, static musl, strict ARMv4 | BusyBox (GPL-2.0) + musl (MIT), built with the `armv4-tc` musl cross toolchain; recipe import into `build/` is a Phase 1 task | GPL-2.0 / MIT |
| `qemu/qemu-system-arm.wasm` | the emulator, wasm64/TCI, md5 `1f6508c2c92265d7ab0d7653287b057a` | [kmehltretter82/qemu](https://github.com/kmehltretter82/qemu) branch `armv4-boards`, commit `53e1cf80d72127f4e3f5c1a9467ed299619005e5`, built by `build/build-qemu.sh` with emsdk 4.0.10 | GPL-2.0 |
| `qemu/qemu-system-arm.js` | its Emscripten loader plus the browser display/input bridge, md5 `8a25bb2bb9518f320070c5c598d8ab13` | same build; bridge source is `build/display-canvas.js` in this repository | GPL-2.0 |

## Why the emulator is prebuilt too

Same reason as the kernel: a from-scratch dependency + QEMU build takes over
two hours on GitHub's 2-core runners, and it changes only when the machine
model does. `build/build-qemu.sh` reproduces it from the commit named above;
regenerate with:

```sh
./build/build-deps.sh && ./build/build-qemu.sh
cp build/out/qemu-system-arm.{js,wasm} assets/qemu/
```

then update the checksums here. CI still boots whatever is committed before it
will deploy it.

## Toolchain constraint (important)

`ARCH_RPC` must be built with **gcc 6–8** (newer gcc silently degrades the
config — the RiscPC bus cannot execute `strh`; see PLAN.md). Both shipped
zImages were built with a gcc-8 strict-ARMv4 musl toolchain. **CI must never
rebuild a kernel with a distro gcc.** Rebuild manually:

```sh
make ARCH=arm CROSS_COMPILE=<armv4-gcc8-toolchain>- O=<builddir> olddefconfig zImage
# .config = zImage.config from this directory, source = linux submodule commit above
```

For the stable comparison image, check out stable commit
`7a5cef0db4795d9d453a12e0f61b5b7634fc4d40`, apply upstream commit
`470ea955a18c76eeb10ca11ffcb2fe923bfc5515`, seed the build directory with
`zImage-7.1.4.config`, and use the same command with `LOCALVERSION=`. That is
the only backport: the stable image intentionally omits the three RiscPC
runtime fixes in the current image. It reaches the shell while reproducing the
known floppy teardown warning (`work still pending`).

Boot (native QEMU from the `qemu` submodule, branch `armv4-boards`):

```sh
qemu-system-arm -M riscpc -kernel zImage -initrd initramfs-busybox.cpio.gz \
    -append 'console=tty0 console=ttyS0 rdinit=/init' -serial stdio
```

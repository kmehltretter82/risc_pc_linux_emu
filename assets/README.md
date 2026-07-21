# Prebuilt boot assets — provenance

**Rule (enforced by review, later by CI): no binary ships unless this file names
the public commit it was built from.**

| File | What | Source | License |
|---|---|---|---|
| `zImage` | Linux 7.2.0-rc4+ for `ARCH_RPC` (Acorn RiscPC), md5 `9b9f0f45806c5ee160f8c04e2caf8e18` | [kmehltretter82/linux](https://github.com/kmehltretter82/linux) branch `riscpc-emu`, commit `36ea1cf6b8d1c802f4121a8032d4f5d58f5a8283` (= tag `v7.2-rc4` + 3 fix patches found on this emulated hardware) — built from a clean checkout of that commit and boot-verified | GPL-2.0 |
| `zImage.config` | exact kernel config used for `zImage` | same commit, `rpc_defconfig`-derived | GPL-2.0 |
| `initramfs-busybox.cpio.gz` | BusyBox userspace, static musl, strict ARMv4 | BusyBox (GPL-2.0) + musl (MIT), built with the `armv4-tc` musl cross toolchain; recipe import into `build/` is a Phase 1 task | GPL-2.0 / MIT |
| `qemu/qemu-system-arm.wasm` | the emulator, wasm64/TCI, md5 `de9f072c7b53ac8b26af0d66c48cf1c1` | [kmehltretter82/qemu](https://github.com/kmehltretter82/qemu) branch `armv4-boards`, commit `9fceb54d7147f52e1995595d355d41696e31762e`, built by `build/build-qemu.sh` with emsdk 4.0.10 | GPL-2.0 |
| `qemu/qemu-system-arm.js` | its Emscripten loader, md5 `acb23c94e346353adedc21999b495a40` | same build | GPL-2.0 |

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
config — the RiscPC bus cannot execute `strh`; see PLAN.md). The shipped zImage
was built with a gcc-8 strict-ARMv4 musl toolchain. **CI must never rebuild the
kernel with a distro gcc.** Rebuild manually:

```sh
make ARCH=arm CROSS_COMPILE=<armv4-gcc8-toolchain>- O=<builddir> olddefconfig zImage
# .config = zImage.config from this directory, source = linux submodule commit above
```

Boot (native QEMU from the `qemu` submodule, branch `armv4-boards`):

```sh
qemu-system-arm -M riscpc -kernel zImage -initrd initramfs-busybox.cpio.gz \
    -append 'console=ttyS0 rdinit=/init' -serial stdio
```

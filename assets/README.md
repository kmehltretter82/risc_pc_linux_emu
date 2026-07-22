# Prebuilt boot assets — provenance

**Rule (enforced by `build/test-provenance.py` in CI): no binary ships unless
this file names the public source it was built from.**

| File | What | Source | License |
|---|---|---|---|
| `zImage` | Linux 7.2.0-rc4+ for `ARCH_RPC` (Acorn RiscPC), md5 `9b9f0f45806c5ee160f8c04e2caf8e18` | [kmehltretter82/linux](https://github.com/kmehltretter82/linux) branch `riscpc-emu`, commit `36ea1cf6b8d1c802f4121a8032d4f5d58f5a8283` (= tag `v7.2-rc4` + 3 fix patches found on this emulated hardware) — built from a clean checkout of that commit and boot-verified | GPL-2.0 |
| `zImage.config` | exact kernel config used for `zImage` | same commit, `rpc_defconfig`-derived | GPL-2.0 |
| `zImage-7.1.4` | Linux 7.1.4 stable for `ARCH_RPC`, md5 `e0ef1cbbfecb652ce6a3712d742fb624` | kernel.org stable commit [`7a5cef0db4795d9d453a12e0f61b5b7634fc4d40`](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/commit/?id=7a5cef0db4795d9d453a12e0f61b5b7634fc4d40) plus only upstream commit [`470ea955a18c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=470ea955a18c76eeb10ca11ffcb2fe923bfc5515), which fixes the RiscPC ARM zImage build — gcc-8 build and boot-verified | GPL-2.0 |
| `zImage-7.1.4.config` | exact kernel config used for `zImage-7.1.4` | same source, seeded from `zImage.config` then normalized with `olddefconfig` | GPL-2.0 |
| `initramfs-busybox.cpio.gz` | BusyBox 1.38.0 userspace, static musl, strict ARMv4, md5 `6422c34f8371eda683ae6e023838d385` | [BusyBox 1.38.0](https://busybox.net/downloads/busybox-1.38.0.tar.bz2), source SHA-256 `34f9ea6ff8636f2c9241153b9114eefa9e65674a45318ae1ef95bb5f31c53bb2`; exact [`build/busybox-1.38.0.config`](../build/busybox-1.38.0.config), [`build/initramfs-init`](../build/initramfs-init), and deterministic [`build/build-initramfs.sh`](../build/build-initramfs.sh) / [`build/gen-initramfs.py`](../build/gen-initramfs.py) recipe. Built with GCC 8.5.0 + musl 1.2.6 from musl-cross-make commit [`227df8b99103`](https://github.com/richfelker/musl-cross-make/commit/227df8b99103f9c59f6570babf892978e293082f), using [`build/musl-cross-make-armv4.config`](../build/musl-cross-make-armv4.config) and [`build/musl-1.2.6-armv4.patch`](../build/musl-1.2.6-armv4.patch). | GPL-2.0 / MIT |
| `qemu/qemu-system-arm.wasm` | the emulator, wasm64/TCI, md5 `cd1ec6389b72514d7a5898a035671a56` | [kmehltretter82/qemu](https://github.com/kmehltretter82/qemu) branch `armv4-boards`, public commit [`f3d9daffc056`](https://github.com/kmehltretter82/qemu/commit/f3d9daffc05611137446c4d9690eb3f981b2ab51), built by `build/build-qemu.sh` with emsdk 4.0.10. Its tree `80e0546ccf11` is byte-identical to the pre-publication build commit, so the binary did not need rebuilding after the history reconciliation. | GPL-2.0 |
| `qemu/qemu-system-arm.js` | its Emscripten loader plus the browser display/input bridge and IDBFS support, md5 `08a54441b64539548db5ea2ae14dd5ee` | same build; bridge source is `build/display-canvas.js` in this repository | GPL-2.0 |

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

## Rebuilding the initramfs

The toolchain patch replaces ARMv4T-only `bx` returns in musl's ARM assembly;
the SA-110 is ARMv4 without Thumb and cannot execute them. From this repository,
build the pinned toolchain and image with:

```sh
MCM_DIR=/path/to/musl-cross-make
git clone https://github.com/richfelker/musl-cross-make "$MCM_DIR"
git -C "$MCM_DIR" checkout 227df8b99103f9c59f6570babf892978e293082f
cp build/musl-cross-make-armv4.config "$MCM_DIR/config.mak"
cp build/musl-1.2.6-armv4.patch \
   "$MCM_DIR/patches/musl-1.2.6/0099-armv4-strict.diff"
make -C "$MCM_DIR" -j8 install

BUSYBOX_TARBALL=/path/to/busybox-1.38.0.tar.bz2 \
ARMV4_CROSS_COMPILE="$MCM_DIR/output/armv4-tc-gcc8/bin/arm-linux-musleabi-" \
SOURCE_DATE_EPOCH=0 ./build/build-initramfs.sh
cp build/out/initramfs-busybox.cpio.gz assets/
```

`build/build-initramfs.sh` checks the source archive and refuses a BusyBox
configuration rewrite. The `newc` writer records root ownership, a real 5:1
`/dev/console`, stable ordering and the fixed epoch without requiring root.
Two clean builds must have the documented md5 above before updating the asset.

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
    -append 'console=tty0 console=ttyS0 rdinit=/init' -serial stdio \
    -drive file=floppy.img,format=raw,if=floppy,index=0
```

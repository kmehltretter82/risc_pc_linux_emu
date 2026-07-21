# Prebuilt boot assets — provenance

**Rule (enforced by review, later by CI): no binary ships unless this file names
the public commit it was built from.**

| File | What | Source | License |
|---|---|---|---|
| `zImage` | Linux 7.2.0-rc4+ for `ARCH_RPC` (Acorn RiscPC), md5 `9b9f0f45806c5ee160f8c04e2caf8e18` | [kmehltretter82/linux](https://github.com/kmehltretter82/linux) branch `riscpc-emu`, commit `36ea1cf6b8d1c802f4121a8032d4f5d58f5a8283` (= tag `v7.2-rc4` + 3 fix patches found on this emulated hardware) — built from a clean checkout of that commit and boot-verified | GPL-2.0 |
| `zImage.config` | exact kernel config used for `zImage` | same commit, `rpc_defconfig`-derived | GPL-2.0 |
| `initramfs-busybox.cpio.gz` | BusyBox userspace, static musl, strict ARMv4 | BusyBox (GPL-2.0) + musl (MIT), built with the `armv4-tc` musl cross toolchain; recipe import into `build/` is a Phase 1 task | GPL-2.0 / MIT |

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

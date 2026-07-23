# NetBSD/acorn32 boot fixes

`0001-acorn32-iomd-ignore-zero-statclock-rate.patch` is applied to the
NetBSD 10.1 source release before building the test kernel.

The bug and the same zero-rate guard were reported by Mike Pumford on the
`port-acorn32` list in March 2019:

https://mail-index.netbsd.org/port-acorn32/2019/03/26/msg000081.html

The stock 10.1 kernel leaves `stathz` at zero. Generic `statclock()` passes
that value to the machine-dependent `setstatclockrate()`, which otherwise
divides the IOMD timer frequency by zero on the first clock tick. Returning
for a zero rate is also the established no-separate-statclock behaviour on
other NetBSD ports.

`0002-iomd-align-intrnames-pointer.patch` aligns the `_intrnames` pointer
before emitting it with `.word`.  Without the alignment, the NetBSD 10.1
GENERIC link placed it at an address ending in `...4b`.  An SA-110 word load
rounds an unaligned address down and rotates the result, so `irq_claim()`
loaded `0x0021704f` instead of the intended kernel pointer `0xf031a64f` and
faulted as soon as the IDE interrupt was claimed.  QEMU's former generic
unaligned-load behaviour accidentally hid this NetBSD bug.

With both guest fixes in place, one final failure was in QEMU rather than
NetBSD. The direct kernel loader placed the live framebuffer in the top 4 MiB
of RAM but advertised that region to NetBSD as ordinary DRAM. Once the VM
allocator reused it, wscons pixels overwrote kernel locks and `/sbin/init`
faulted. The QEMU bootconfig now excludes that scratch region from `dram[]`.

`build/build-netbsd-userland.sh` uses the official NetBSD 10.1 `gnusrc.tgz`,
`sharesrc.tgz`, `src.tgz`, and `syssrc.tgz` source sets, plus the official
acorn32 `base`, `etc`, and `rescue` binary sets. Every input is verified against
its release SHA-512 value. It then builds the two-patch GENERIC kernel and an
unprivileged FFSv1 image using NetBSD's own cross-built `makefs`.

The validated result mounts the image as `wd0a`, executes the release
`/sbin/init`, reaches a root shell, and reports:

```text
NetBSD 10.1 ... earmv4 acorn32
```

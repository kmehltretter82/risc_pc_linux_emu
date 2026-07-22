# ARM FIQ descriptor warning

## Outcome

The warning printed on the first RiscPC floppy data transfer is a Linux IRQ
state-accounting regression at the legacy ARM FIQ API boundary. It is not an
FDC emulation failure: the same transfer completes, the guest reads back the
written sector, and the browser test downloads an image containing the
`RPCFLOP` marker.

The regression has been present since Linux v4.15. The emulator made it
observable because it is now able to exercise the RiscPC's real FIQ-driven
floppy pseudo-DMA path.

No kernel source or shipped kernel image is changed as part of this
investigation.

## Reproduction

The browser deployment gate attaches a 1.44 MiB raw image and runs this in the
guest:

```sh
printf RPCFLOP | dd of=/dev/fd0 bs=512 seek=1 conv=notrunc
sync
```

On the first data transfer the kernel reports a warning in
`kernel/irq/chip.c` from `irq_startup()`. The transfer nevertheless completes,
and `build/test-browser.py` verifies bytes 512–518 in the downloaded image.
The warning is `WARN_ON_ONCE`, so later transfers do not print it again.

Both shipped kernels contain the same `arch/arm/kernel/fiq.c` and
`arch/arm/mach-rpc/dma.c` implementation and are affected.

## Exact call path

The source used for the current image is public at Linux commit
[`36ea1cf6b8d1c802f4121a8032d4f5d58f5a8283`](https://github.com/kmehltretter82/linux/commit/36ea1cf6b8d1c802f4121a8032d4f5d58f5a8283).

1. `rpc_init_irq()` configures Linux IRQs 64–71 as the eight IOMD FIQ
   sources with `irq_set_chip()`. This associates mask/unmask operations and
   chip data, but does not activate the descriptors.
2. The generic descriptor defaults are disabled and masked. They do not have
   `IRQD_ACTIVATED` set.
3. `floppy_enable_dma()` claims the FIQ vector, installs the direction-specific
   assembly handler and its banked registers, then calls
   `enable_fiq(FIQ_FLOPPYDATA)`.
4. `enable_fiq()` simply maps FIQ 0 to Linux IRQ 64 and calls
   `enable_irq(64)`.
5. Generic startup checks `IRQD_ACTIVATED`, warns because it is clear, and
   continues to the IOMD chip's unmask callback. This is why the hardware path
   still works.

Normal interrupt users do not hit this. `request_irq()` calls the internal
`irq_activate()` helper before it starts or enables an interrupt. The FIQ API
has its own ownership mechanism (`claim_fiq()`) and never calls
`request_irq()`, so it bypasses that activation step.

RiscPC floppy DMA is the only in-tree caller of `enable_fiq()` and
`disable_fiq()` in the current Linux tree. The i.MX AVIC and TZIC still call
`init_FIQ()`, but no in-tree i.MX driver enables a FIQ through this API.

## Where the regression entered

Linux commit
[`c942cee46bba` ("genirq: Separate activation and startup")](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=c942cee46bba761ce97ee6d4fc71892e064e8628)
first appeared in v4.15-rc1.

Before that commit, `__irq_startup()` itself called
`irq_domain_activate_irq()`. The commit deliberately moved activation into
the request/setup path and added the warning when startup is attempted without
it. That was correct for ordinary IRQ users, but the ARM FIQ wrapper was not
converted and retained its direct `enable_irq()` call.

The shipped RiscPC configurations use a static, non-hierarchical controller
(`CONFIG_IRQ_DOMAIN=y`, `CONFIG_IRQ_DOMAIN_HIERARCHY` unset). For these FIQ
descriptors, activation has no hardware allocation callback; it sets the
generic `IRQD_ACTIVATED` state. Consequently the missing step currently causes
the warning rather than a failed transfer. It is still a real API/state bug.

## Upstream repair direction

The repair should restore an activation step for legacy FIQ users before
generic startup. There is currently no public architecture-facing helper that
means "activate this virq without installing a generic IRQ action"; the
relevant helpers are private to `kernel/irq/`.

The clean direction is therefore an ARM/genirq change agreed with both
maintainer groups: expose or add a narrow activation helper, and have
`enable_fiq()` use it before `enable_irq()`. Activation failure also needs an
explicit policy because the historic `enable_fiq()` interface returns `void`.

Two tempting local workarounds should not be submitted as the fix:

- setting `IRQD_ACTIVATED` directly in `mach-rpc` would bypass genirq's
  activation abstraction;
- installing a dummy `request_irq()` action would duplicate `claim_fiq()`
  ownership and misrepresent an interrupt dispatched through the dedicated FIQ
  vector rather than a generic flow handler.

Any future patch should be checked with all of the following:

- no `irq_startup()` warning on the first floppy read and write;
- the native-QEMU and browser `RPCFLOP` sector round trips;
- all QEMU 82078/FDC qtests;
- boot with `-M riscpc,floppy=off`;
- an ARM build covering an i.MX FIQ configuration, so the exported legacy API
  is not fixed only for RiscPC.

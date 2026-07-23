# risc_pc_linux_emu

An Acorn **RISC PC** (1994) and Rebel **NetWinder** (1998), both ARMv4,
booting **current mainline Linux** — QEMU compiled to WebAssembly and running
entirely client-side on GitHub Pages. No server, no plugins.

**Live page:** https://kmehltretter82.github.io/risc_pc_linux_emu/

> **Branch status:** `netwinder-web` is a non-deployed feature branch. The live
> GitHub Pages URL continues to serve the RISC-PC-only `main` branch. Pages
> deployment is explicitly restricted to `refs/heads/main` in the workflow.

## Status

**On this branch, both machines boot and you can type at them.** Select the RISC
PC or NetWinder, choose one of that board's removable boot modules, and press
POWER. The RISC PC offers current patched Linux 7.2-rc4 or stable Linux 7.1.4;
the NetWinder boots the current kernel and exposes its Footbridge PCI host,
SL82C105 IDE controller and onboard Tulip Ethernet through the serial log.

The RISC PC's own monitor is live too: QEMU's VIDC20 model drives its canvas.
Click the monitor and a physical keyboard and mouse are routed to the emulated
KART/PS/2 port and quadrature mouse; click the terminal to return input to the
serial UART.

The NetWinder model is deliberately serial-only. Selecting it turns the same
bench into the darker 1998 appliance, leaves the monitor marked `SERIAL ONLY`,
and routes its first 16550 UART to the VT220.

The open internal IDE bay accepts a raw disk image before power-on. Linux sees
it as a real read/write ATA disk, and **DOWNLOAD DISK** exports the modified
image back to the host (run `sync` in the guest first).

The front-panel floppy slot is live as well: click it to insert a supported
raw floppy image before power-on. Linux reaches it through the RiscPC's
82077AA-compatible SMC FDC37C665 controller and ARM FIQ pseudo-DMA path, and
**DOWNLOAD FLOPPY** returns the writable image to the host.

The serial connection is drawn from the RISC PC to the VT220-style terminal.
Its full LK201-style keyboard is clickable, sends input to the guest, and
mirrors key-down/key-up animation from a physical PC or Mac keyboard.

The linked **About** page explains the data-sheet-first emulation method, the
Linux/NetBSD/QEMU bugs this hardware exposed, and every browser-to-guest data
path, with direct links to the public patch commits.

See [PLAN.md](PLAN.md) for the full roadmap:

1. **Serial-console MVP** — live VT220-style terminal on the emulated 16550
   UART; boots to an interactive shell. *(done)*
2. **The machine wakes up** — VIDC20 framebuffer, IOMD PS/2 keyboard,
   quadrature mouse. *(done)*
3. **Clickable storage** — IDE image upload/download, opt-in browser
   persistence, and front-panel floppy upload/download. *(done)*

## Layout

| Path | Contents |
|---|---|
| `frontend/` | the static page (art, xterm.js glue, coi-serviceworker) |
| `assets/` | three selectable prebuilt kernels, userspace, emulator + provenance ([assets/README.md](assets/README.md)) |
| `build/` | Emscripten build recipes for QEMU and its dependencies |
| `qemu/` | submodule → [kmehltretter82/qemu](https://github.com/kmehltretter82/qemu) branch `armv4-boards` (RiscPC and NetWinder models) |
| `linux/` | submodule → [kmehltretter82/linux](https://github.com/kmehltretter82/linux) branch `riscpc-emu` (v7.2-rc4 + RiscPC-found fixes) |

Submodules are pointers only; clone with `--recurse-submodules` if you want the
sources locally.

## License

GPL-2.0 (see [LICENSE](LICENSE)) — matching the QEMU build and Linux kernel the
page distributes. Every shipped binary names its public source commit in
[assets/README.md](assets/README.md).

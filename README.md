# risc_pc_linux_emu

An Acorn **RISC PC** (1994, ARMv4) booting **current mainline Linux** — QEMU
compiled to WebAssembly, running entirely client-side on GitHub Pages.
No server, no plugins. Faster than the real machine, in a browser tab.

**Live page:** https://kmehltretter82.github.io/risc_pc_linux_emu/

## Status

**It boots, and you can type at it.** Select a removable boot module, press
POWER, and a 1994 Acorn RISC PC runs either the current patched Linux 7.2-rc4
or stable Linux 7.1.4 in your browser tab — real QEMU, real ARMv4 emulation, no
server, interactive shell.

The RISC PC's own monitor is live too: QEMU's VIDC20 model drives its canvas.
Click the monitor and a physical keyboard and mouse are routed to the emulated
KART/PS/2 port and quadrature mouse; click the terminal to return input to the
serial UART.

The open internal IDE bay accepts a raw disk image before power-on. Linux sees
it as a real read/write ATA disk, and **DOWNLOAD DISK** exports the modified
image back to the host (run `sync` in the guest first).

The front-panel floppy slot is live as well: click it to insert a supported
raw floppy image before power-on. Linux reaches it through the RiscPC's
82C711-compatible controller and ARM FIQ pseudo-DMA path, and **DOWNLOAD
FLOPPY** returns the writable image to the host.

The serial connection is drawn from the RISC PC to the VT220-style terminal.
Its full LK201-style keyboard is clickable, sends input to the guest, and
mirrors key-down/key-up animation from a physical PC or Mac keyboard.

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
| `assets/` | two selectable prebuilt kernels, userspace, emulator + provenance ([assets/README.md](assets/README.md)) |
| `build/` | Emscripten build recipes for QEMU and its dependencies |
| `qemu/` | submodule → [kmehltretter82/qemu](https://github.com/kmehltretter82/qemu) branch `armv4-boards` (the RiscPC machine model) |
| `linux/` | submodule → [kmehltretter82/linux](https://github.com/kmehltretter82/linux) branch `riscpc-emu` (v7.2-rc4 + RiscPC-found fixes) |

Submodules are pointers only; clone with `--recurse-submodules` if you want the
sources locally.

## License

GPL-2.0 (see [LICENSE](LICENSE)) — matching the QEMU build and Linux kernel the
page distributes. Every shipped binary names its public source commit in
[assets/README.md](assets/README.md).

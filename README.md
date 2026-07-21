# risc_pc_linux_emu

An Acorn **RISC PC** (1994, ARMv4) booting **current mainline Linux** — QEMU
compiled to WebAssembly, running entirely client-side on GitHub Pages.
No server, no plugins. Faster than the real machine, in a browser tab.

**Live page:** https://kmehltretter82.github.io/risc_pc_linux_emu/ *(Phase 1 - serial console)*

## Status

**It boots, and you can type at it.** Press POWER and a 1994 Acorn RISC PC runs
Linux 7.2-rc4 in your browser tab — real QEMU, real ARMv4 emulation, no server,
interactive shell.

See [PLAN.md](PLAN.md) for the full roadmap:

1. **Serial-console MVP** — drawn RiscPC with a dark "NO SIGNAL" monitor, live
   VT220-style terminal on the emulated 16550 UART; boots to an interactive
   shell. *(done)*
2. **The machine wakes up** — VIDC20 framebuffer, IOMD PS/2 keyboard,
   quadrature mouse.
3. **Clickable storage** — upload/download IDE disk images, floppy.

## Layout

| Path | Contents |
|---|---|
| `frontend/` | the static page (art, xterm.js glue, coi-serviceworker) |
| `assets/` | prebuilt boot binaries + provenance ([assets/README.md](assets/README.md)) |
| `build/` | Emscripten build recipes for QEMU and its dependencies |
| `qemu/` | submodule → [kmehltretter82/qemu](https://github.com/kmehltretter82/qemu) branch `armv4-boards` (the RiscPC machine model) |
| `linux/` | submodule → [kmehltretter82/linux](https://github.com/kmehltretter82/linux) branch `riscpc-emu` (v7.2-rc4 + RiscPC-found fixes) |

Submodules are pointers only; clone with `--recurse-submodules` if you want the
sources locally.

## License

GPL-2.0 (see [LICENSE](LICENSE)) — matching the QEMU build and Linux kernel the
page distributes. Every shipped binary names its public source commit in
[assets/README.md](assets/README.md).

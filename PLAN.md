# RiscPC in the Browser — Project Plan

**Pitch:** An Acorn RISC PC (1994, ARMv4) booting current mainline Linux, emulated by
QEMU compiled to WebAssembly, entirely inside one static web page on GitHub Pages.
No server, no plugins. Faster than the real machine, in a browser tab.

**Repo:** `kmehltretter82/risc_pc_linux_emu` · **URL (once live):** `https://kmehltretter82.github.io/risc_pc_linux_emu/`

---

## What already exists (built in ~/linux-work, 2026-07)

| Piece | Where | Notes |
|---|---|---|
| QEMU RiscPC machine | `kmehltretter82/qemu` branch `armv4-boards` | `-M riscpc`: IOMD, 16550 serial, MMIO IDE. Base 11.0.50 → upstream Emscripten build support already in-tree |
| Mainline kernel for rpc | `~/linux-work/kbuild-rpc-gcc8` | v7.2-rc4 zImage, 3.6 MB. **Must be built with gcc 6–8** (rpc_defconfig silently degrades with gcc ≥ 9 — see `armv4-mainline-watch.sh` CONFIG-LOST check) |
| Toolchain | `~/linux-work/armv4-tc-gcc8` | strict-ARMv4 musl/BusyBox toolchain |
| Rootfs | `~/linux-work/armv4-rootfs/` (tree), `armv4-rootfs.img` (32 MB ext2) | BusyBox userspace; cpio initramfs buildable from the tree |
| Boot convention | in the fork's `hw/arm/boot` changes | old-param/NeTTrom-era parameter block; direct `-kernel` boot — **no RISC OS ROM needed** (sidesteps copyright entirely) |
| Test matrix | `~/linux-work/armv4-boards-test.sh` | 7/7 boot matrix incl. riscpc; use before every deploy |
| Guest drivers (all still in mainline 7.2) | `acornfb` (VIDC20 fb), `rpckbd` (PS/2 kbd via IOMD), `rpcmouse` (quadrature) | needed for Phase 2 — guest side is already done, only QEMU models are missing |

Prior art to lean on: **ktock/qemu-wasm** (Emscripten build recipes, Dockerfiles for
dependency cross-builds, browser glue examples). Upstream QEMU has experimental
Emscripten host support since 10.1 (TCI interpreter for 32-bit guests; the true Wasm
TCG backend is still in review upstream — a future free speed-up).

Performance sanity check: TCI-in-browser is slow by modern standards but the target
is a 30–40 MHz ARM610. The emulation will outrun the original hardware.

---

## Architecture

```
GitHub Pages (static files only)
├── index.html + art          RiscPC case, monitor, VT220 bezel (CSS/SVG)
├── coi-serviceworker.js      enables COOP/COEP → SharedArrayBuffer on Pages
├── xterm.js                  terminal glass inside the VT220 bezel
├── qemu-system-arm.{js,wasm} Emscripten build of the armv4-boards fork
└── assets/
    ├── zImage                mainline rpc kernel (prebuilt, gcc-8)
    ├── rootfs.cpio.gz        BusyBox initramfs (Phase 1 root)
    └── rootfs.img            32 MB ext2 (attached as IDE disk, Phase 3)
```

Boot flow in the tab: click power button → fetch assets with progress indicator →
drop them into Emscripten's in-memory FS → start QEMU with
`-M riscpc -kernel zImage -initrd rootfs.cpio.gz -append 'console=ttyS0 rdinit=/init'`
→ UART chardev bridged to xterm.js.

Input routing model (grows with phases): focus the terminal → bytes to the UART;
(Phase 2+) focus the monitor → scancodes to the machine's own PS/2 keyboard.

---

## Phase 0 — Repo scaffold (hours)

- [ ] Create GitHub repo `risc_pc_linux_emu`; enable Pages (deploy from Actions).
- [ ] Dependencies are our existing forks, pinned as submodules — never copies:
  - `qemu/` → `kmehltretter82/qemu` @ `armv4-boards` (machine model lives here).
  - `linux/` → Karl's linux fork; **create branch `riscpc-emu`**: v7.2-rc4 + the three
    patches from `~/linux-work/patches/kernel/` + the rpc defconfig used for the
    shipped zImage. Push it — every shipped binary must have a public source commit.
  - `assets/README.md` records provenance for each binary: source repo, branch,
    exact commit, toolchain (gcc-8/musl), build command.
- [ ] Layout:
  ```
  frontend/          # index.html, css/svg art, xterm glue, coi-serviceworker
  build/             # emsdk Dockerfile + scripts for deps (glib, zlib, pixman, libffi) and QEMU
  assets/            # prebuilt zImage, rootfs images (binary, committed — sizes are fine)
  qemu/              # git submodule → kmehltretter82/qemu @ armv4-boards
  .github/workflows/pages.yml
  PLAN.md            # this file
  ```
- [ ] Commit prebuilt kernel/rootfs as plain files (3.6 MB + ~4 MB cpio + 32 MB ext2 —
      all under Pages/repo limits). Kernel is built **locally** with the gcc-8
      toolchain; CI must not try to build it (wrong gcc = silently degraded config).

## Phase 1 — Serial-console MVP: "the bring-up bench" (2–4 focused days)

Scene: RiscPC + its monitor drawn dark ("NO SIGNAL" — honest: no VIDC20 model yet),
next to it a VT220-style terminal whose glass is live xterm.js showing the real
serial console. dmesg scrolls, `login:` appears, user logs in as root. The user's
physical keyboard types over the serial line when the terminal has focus.

1. **Deps + QEMU wasm build** (the bulk of the effort — toolchain fighting):
   - emsdk pinned in `build/Dockerfile`; cross-compile glib/zlib/libffi/pixman
     following ktock's recipes.
   - `configure --target-list=arm-softmmu` for Emscripten host, TCI backend;
     trim devices/features to shrink the .wasm.
   - Milestone A: our fork boots the rpc kernel under `node` (Emscripten's
     node runtime) before any browser work.
2. **Frontend**:
   - Static page, no framework needed. SVG/CSS art: RiscPC slice case (power LED),
     dark monitor, VT220 bezel around an xterm.js viewport (amber/green theme,
     optional scanline shader).
   - Power button starts asset fetch (progress shown), then QEMU.
   - `TERM=xterm-256color` getty in the rootfs inittab (xterm.js is a VT100/VT220
     superset with color — vi/htop render correctly).
   - Optional toggle: 9600-baud output throttle for the authentic teletype crawl.
3. **Hosting**:
   - `coi-serviceworker` for cross-origin isolation (Pages can't set COOP/COEP
     headers; SharedArrayBuffer/pthreads need them).
   - GitHub Action: build wasm in the emsdk container, assemble `frontend/ + assets/`,
     deploy to Pages.
4. **Definition of done**: public URL, cold load → `login:` , interactive shell,
   works in Chrome + Firefox (Safari best-effort).

## Phase 2 — The machine gets its own screen and keyboard (1–2 weeks)

New QEMU device models on `armv4-boards` (guest drivers already exist in mainline):

- [ ] **VIDC20 framebuffer** → guest `acornfb`/fbcon. Palette + mode timing regs +
      video DMA from IOMD. The money shot: Tux logo on a VIDC20 that never met a
      2026 kernel. Monitor artwork lights up as a live canvas.
- [ ] **IOMD PS/2 keyboard** (KART regs) → guest `rpckbd`. Reuse QEMU's ps2 core.
- [ ] **Quadrature mouse** (IOMD counters + button bits) → guest `rpcmouse`.
- [ ] Frontend: draw the RiscPC's own keyboard below the monitor; input routing by
      focus (terminal→UART, monitor→PS/2). Both consoles live simultaneously,
      like a real bring-up bench.
- [ ] Native regression: extend `armv4-boards-test.sh` with a framebuffer smoke test.

## Phase 3 — Storage UX: clickable drives (≈1 week)

- [ ] **IDE upload/download** (model exists): click the HDD → upload an image,
      attach; "download disk" to export the modified image. Near-free — it's just
      Emscripten-FS plumbing.
- [ ] **Persistence (opt-in)**: mirror the disk to IndexedDB (IDBFS) —
      "Save disk" / "Reset to factory". Default stays ephemeral.
- [ ] **Floppy** — the marquee interaction (click floppy slot → upload image):
      model the 82C711-combo FDC (QEMU's `fdc` core) wired for the ARM FIQ
      pseudo-DMA transfer style the kernel driver uses. The fiddly one; do last.
      Note: adding the FDC removes our accidental reproducer for the floppy
      init-path bug (patch 0001) — keep a no-FDC machine option for regression use.
- [ ] Explicitly **out of scope**: networking (browsers have no raw sockets; a
      WebSocket proxy would break the "pure static page" constraint).

## Phase 4 — Ecosystem / stretch (ongoing)

- [ ] Send the four pending patches (`~/linux-work/patches/`, needs Karl's
      `git send-email`) — cover letters can now cite the live demo URL as evidence
      that mach-rpc has users.
- [ ] "About" page: the bug-hunt story, links to patches, how the emulation works.
- [ ] Upstream the machine models (riscpc, netwinder, acorn-iomd, dc21285,
      sl82c105) with `tests/functional/` entries; collie is the precedent.
- [ ] Adopt the upstream Wasm TCG backend when merged (free speed-up over TCI).
- [ ] Second machine on the page: NetWinder (model already boots; has PCI + Tulip).
- [ ] Kernel-version badge: wire `armv4-mainline-watch.sh` into CI so the page can
      say "now booting v7.3-rc1" shortly after each tag.
- [ ] **Other guest OSes** (the name says Linux, but the hardware doesn't care):
  - **RISC OS 5.30** — RISC OS Open relicensed RISC OS 5 under Apache 2.0, so a
    legally redistributable ROM exists (RPCEmu ships one). Needs ROM-at-reset boot
    support plus much higher hardware fidelity than Linux does (full VIDC20, IOMD
    timers/keyboard, podule probing). A real project of its own — Phase 2 hardware
    is the prerequisite. The era-authentic RISC OS 3.5–3.7 ROMs remain proprietary.
  - **NetBSD/acorn32** — historic releases supported the RiscPC; would validate the
    machine model against a second kernel.
  - **Debian sarge (2004)** — 2.4.27-riscpc kernels + installer already collected in
    `~/linux-work/armv4-images/riscpc/`; "install Debian from 2004 in your browser"
    is a fun museum piece and needs no new hardware beyond Phase 3 storage.

---

## Licensing & source compliance

The page *distributes* GPL binaries (that's what serving a .wasm build is), so
compliance is part of the design, not an afterthought:

| Component | License | Our obligation |
|---|---|---|
| QEMU fork (the .wasm we serve) | GPLv2 | public source for the exact build: submodule pin + footer link to fork commit |
| Linux kernel (zImage asset) | GPLv2 | same: `riscpc-emu` branch on the linux fork, commit linked from the site |
| BusyBox (inside rootfs images) | GPLv2 | link source + build config (musl-cross-make / buildroot recipe) |
| musl | MIT | attribution |
| xterm.js, coi-serviceworker | MIT | attribution |
| **This repo** (frontend, art, build scripts) | **GPLv2** (recommended) | keeps the whole combined work under one license — the frontend JS drives the GPL'd emulator module directly, so uniform GPLv2 is the zero-analysis option. (MIT for our files would also be GPL-compatible if we ever want to split.) |

Rule of thumb baked into CI: no binary ships unless `assets/README.md` names the
public commit it was built from. The site footer links every source repo.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| emsdk dependency builds are painful | ktock/qemu-wasm Dockerfiles as reference; pin emsdk version; Milestone A under node isolates browser issues |
| Pages can't set COOP/COEP headers | coi-serviceworker shim (established pattern) |
| Kernel needs gcc 6–8 | kernel is a prebuilt committed artifact; CI never builds it; CONFIG-LOST check before updating the artifact |
| TCI too slow (unlikely) | target is 30–40 MHz ARM610; if needed, wasm TCG backend later |
| Safari (no wasm64 / isolation quirks) | build wasm32; Chrome+Firefox are the supported browsers, Safari best-effort |
| RISC OS ROM copyright | avoided by design: direct `-kernel` boot, authentic to NeTTrom-era Linux bring-up |

## Effort summary

| Phase | Wall-clock (part-time) |
|---|---|
| 0 scaffold | an evening |
| 1 serial MVP | 2–4 focused days |
| 2 screen+keyboard+mouse | 1–2 weeks |
| 3 storage UX + floppy | ~1 week |
| 4 ecosystem | ongoing |

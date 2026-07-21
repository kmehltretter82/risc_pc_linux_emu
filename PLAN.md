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
| Guest drivers in mainline 7.2 | `acornfb` (VIDC20 fb), `rpcmouse` (quadrature), `rpckbd` (KART serio) | All three present. `rpckbd` lives in **`drivers/input/serio/`**, not `drivers/input/keyboard/`, under `CONFIG_SERIO_RPCKBD`; `atkbd` binds on top of it. The booted kernel already probes it and reports `keyboard reset failed on rpckbd/serio0` — so a KART model has a waiting client |
| VIDC20 datasheet | `~/linux-work/docs/vidc20-datasheet.pdf` | Acorn/GEC Plessey, Feb 1995, 69 pp, **has a text layer**. §4.1 is the register allocation; its §6.0 on p33 is the one `mach/acornfb.h` cites. **This is the specification** |
| RPCEmu | `~/linux-work/rpcemu/src/vidc20.c` | Independent implementation written against RISC OS. Documents field masks (`HDSR/HDER & 0x3ffe`, `VDSR/VDER & 0x1fff`) and rejects writes with reserved bits set |
| NetBSD/acorn32 | `~/linux-work/netbsd-acorn32/` | 10.1 GENERIC kernel (ELF32 ARM, entry 0xf0000000) + `vidc20config.c`, `vidc.h`, `bootconfig.h`, `rpc_machdep.c`. Second independent VIDC20 driver, **with a serial console** |
| Debian RiscPC kernels | `~/linux-work/armv4-images/riscpc/` | 2.2.19 / 2.4.16 / 2.4.27, `CONFIG_FB_ACORN=y`, `CONFIG_RPCMOUSE=y`. Frozen 2004 artifacts — cannot have been influenced by this emulator |
| SA-110 datasheet | `~/linux-work/docs/sa110-datasheet.pdf` | DEC StrongARM Data Sheet V2.0, 64 pp, **has a text layer**. §5.1 p14 is the CP15 access rules, §5.2 p15 Table 3 the register set. Settles Finding #1 |
| RiscPC TRM | `~/linux-work/docs/riscpc-trm.pdf` | 112 pp, but a **scan** — no usable text layer. Needs poppler to render pages as images |

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

**Status (2026-07-21): done.** The guest boots to an interactive shell in
Chromium — `build/test-browser.py` presses POWER, waits for the BusyBox banner,
then types `uname -m` and asserts the guest answers `armv4l`; that is the gate
CI enforces before deploying. `build/run-node.mjs` is the same check headless.
Built: emsdk 4.0.10 + deps (`build/build-deps.sh`), wasm64/TCI QEMU
(`build/build-qemu.sh`, 43 MB `.wasm`), the RiscPC/VT220 scene,
coi-serviceworker, `build/serve.py` for local COOP/COEP.

Three things worth knowing before touching the build:

- **Link flags do not come from `LDFLAGS`.** QEMU's own
  `configs/meson/emscripten.txt` is loaded after configure's cross file and
  replaces `c_link_args` wholesale. `build-qemu.sh` reads that list and appends
  to it; edit there, not in `env.sh`.
- **Keyboard input goes through `build/stdin-proxy.js`.** QEMU's `main()` runs
  on a worker (`-sPROXY_TO_PTHREAD`) while keystrokes arrive on the browser
  main thread, so the `read` and `poll` paths for fd 0 are proxied across with
  emscripten's `__proxy: 'sync'`. xterm-pty would add real termios handling but
  cannot work in this mode (its PTY object is main-thread-only and it does not
  proxy reads); dropping `PROXY_TO_PTHREAD` instead freezes the tab. Kept
  behind `XTERM_PTY=1` for reference.
- **The console is raw, not a termios pty.** No line discipline, no `TIOCGWINSZ`
  — full-screen programs and window resizing will not behave until something
  like the xterm-pty path works under a proxied main.

## Phase 2 — The machine gets its own screen (2–3 weeks)

### Method: the datasheet is the spec, not any driver

The whole point of this emulator is finding mach-rpc bugs (Phase 4, and the
floppy reproducer in Phase 3). An emulator tuned until `acornfb` is happy can
never again *falsify* `acornfb` — it becomes a mirror of one driver's
assumptions. So:

1. **Write each register from `docs/vidc20-datasheet.pdf` §4.1.** Never infer
   semantics from what a driver happens to write.
2. **Cross-check against two independent implementations** before trusting a
   reading: RPCEmu (written against RISC OS) and NetBSD `vidc20config.c`.
   Worked example: both `acornfb` and NetBSD subtract **18** when computing
   HDSR (`acornfb.c:124`, `vidc20config.c:486`) — two unrelated codebases
   agreeing makes that a real pipeline delay, not a Linux quirk.
3. **Record disagreements, don't absorb them.** Where datasheet-faithful
   behaviour makes a guest misbehave, that is a candidate guest bug and a
   Phase 4 patch — not something to paper over in the model.

Oracles, weakest to strongest independence: mainline `acornfb` (fast loop) →
Debian 2.2/2.4 (frozen 2004 binaries) → **NetBSD/acorn32** (independent driver
*and* a serial console) → RISC OS (fully independent, but silent when it fails).

### 2a. Boot NetBSD/acorn32 — the primary target

NetBSD is target #1 because it is an independent VIDC20 driver that still
prints to `ttyS0`. RISC OS is *not* a prerequisite — `!BtNetBSD` is only a
bootloader — but it is **not** a plain `-kernel` load either.

**The kernel must be entered with the MMU already on.** `start` (0xf0000000)
zeroes BSS and loads `sp` from absolute `0xf03f….` virtual addresses and
contains no `mcr p15` in its first 4 KB; RAM is physically at 0x10000000.
BtNetBSD gets this for free by running under RISC OS, whose MMU is already
enabled. `initarm()` builds the kernel's *final* tables — by then it is
already running mapped. QEMU must therefore supply the initial mapping:

- [ ] Build an L1 section table in guest RAM: kernel VA `0xf0000000` → load
      PA, plus **identity-mapped I/O** (`initarm` dereferences
      `VIDC_HW_BASE 0x03400000` and `IOMD_HW_BASE` raw — `vidc_machdep.h:54`).
- [ ] Entry stub: set TTBR0 + DACR, enable MMU, `r0` = bootconfig VA, jump to
      0xf0000000. Precedent: the blobs in `hw/arm/boot.c`.
- [ ] Synthesize `struct bootconfig` (magic `0x43112233`, v2): `dram[]`,
      `pagesize`, `kernelname`, `args`. The `display_*` fields wait for 2b.
- [ ] Load `netbsd-GENERIC` (ELF32, one LOAD segment, vaddr==paddr==
      0xf0000000 — so the ELF paddr is a *virtual* address; do not honour it
      literally when placing the image).
- [ ] Definition of done: NetBSD reaches its serial console.

Estimate: days, not hours. This is the riskiest item in Phase 2 — it is the
one piece with no working reference in-tree.

**Status: done.** NetBSD 10.1 GENERIC prints its banner, sizes memory
(65536 KB / 58488 KB avail) and attaches `mainbus0`. Its console is
`vidcvideo`, not serial — the framebuffer is the only output, so read it
with a `screendump` or by dumping `display_phys`.

**Finding #1 — resolved: this is a QEMU bug, not a NetBSD one.**
`cpu_attach` drops to `ddb` on an undefined instruction:

    f0017118:  mrc 15, 0, r3, cr1, cr0, {1}   ; ACTLR    - ARMv6+
    f0017120:  mrc 15, 0, r3, cr0, cr0, {6}   ; ID_MMFR2 - ARMv7

Both reads are unconditional, on an ARMv4 core that has neither register.

`docs/sa110-datasheet.pdf` settles it. §5.1 (p14) documents the undefined
instruction trap for exactly one case — *"only allowed in non-user modes
and the undefined instruction trap will be taken if accesses are attempted
in user mode"* — and describes `CRm`/`OPC_2` as *"function bits for **some**
MRC/MCR instructions"*, i.e. not decoded for the rest. §5.2 (p15) says an
access to an invalid register is *"unpredictable"*, which constrains the
**result**, not the behaviour.

`cpu_attach` runs in SVC mode, so on real silicon neither read traps; they
return an unpredictable value, most likely the Control register, and
NetBSD stores a junk value it never uses. **QEMU's SA-110 model is wrong to
raise undefined here.**

Fix in the CPU model, citing the datasheet: CP15 reads in a privileged
mode must not trap on undecoded `OPC_2`/`CRm`. Note this is a fix *to the
model*, justified by the specification — not a workaround to make a guest
boot. Nothing in mainline Linux reads either register, which is why only
an independent guest surfaced it.

**Finding #2 (open).** With the display handed over, NetBSD reaches
`podulebus0` and the clock, then:

    [ 1.0000000] clock: hz=100 stathz = 0 profhz = 0
    [ 1.0000030] panic: divide by 0
    ... traceback includes statclock() ...

`stathz` is reported as 0 and something in the statistics-clock path
divides by it. Two candidates, not yet separated: acorn32 starts the
stat clock without setting `stathz`, or our IOMD timers lead it to. Do
not "fix" this in the timer model until which is established — that is
the same trap as Finding #1, where the obvious patch would have hidden a
real defect in our own code.

### 2b. VIDC20 framebuffer

- [ ] New `hw/display/vidc20.c`: single write port at `0x03400000`, register
      selected by bits 31..24. Palette (28-bit: R 0-7, G 8-15, B 16-23,
      Ext 24-27), HDSR/HDER/VDSR/VDER geometry, CONREG bpp at bits 5-7.
      Draw via `framebuffer.c` from **main DRAM** — with `-kernel` boot
      `vram_size` is 0, so `acornfb` allocates via `dma_alloc_wc` and no VRAM
      model is needed.
- [ ] IOMD video DMA: `VIDSTART` 0x1D8, `VIDEND` 0x1D4, `VIDINIT` 0x1DC,
      `VIDCR` 0x1E0. Values already land in `regs[]`; add an accessor.
      Open question for the datasheet: `acornfb.c:568-579` writes an *address*
      into `VIDEND` despite naming it `size`, and `VIDCR` gets
      `DMA_CR_E|DMA_CR_D|16` whose D bit and count are undocumented in the
      driver. Resolve from §4, not by fitting.
- [x] Cross-validated against two independent drivers, which is the point
      of the exercise: Linux `acornfb` at 640x480x4bpp, and NetBSD `wscons`
      at **640x350** — a different mode, so HDSR/HDER/VDSR/VDER are
      confirmed against something other than one driver's arithmetic.
      Debian 2.4.27 remains to be tried.

### 2c. Input (after the screen works)

- [x] **Quadrature mouse** (IOMD `MOUSEX`/`MOUSEY` 0x0A0/0x0A4, buttons in
      their own decode at 0x03310000) → mainline `rpcmouse`. Note it
      samples on **VSYNC**, so VIDC20 also gained a 60 Hz vblank pulse on
      bank A bit 3; without it the mouse never moves.
- [x] **KART keyboard** (PS/2, via QEMU's ps2 core) → mainline `rpckbd`
      with `atkbd` above it. KCTRL bit 7 TXEMPTY / bit 5 RXFULL, receive on
      bank B bit 7. Linux now registers `AT Raw Set 2 keyboard`.
- [ ] Frontend (**still open**): monitor becomes a live canvas; input
      routing by focus (terminal→UART, monitor→PS/2), both consoles live at
      once. Needs the wasm rebuild plus canvas work in `frontend/`; the
      device side is done and testable natively.

### 2d. Regression

- [x] `armv4-boards-test.sh` gained `run_fb_test` plus a
      `riscpc-vidc20-fbcon` case: boot, `screendump` to PPM, assert
      geometry and a minimum lit-pixel count. Verified non-vacuous with a
      negative control (serial-only console → 0 lit pixels → FAIL).
      **Needs a QEMU built with pixman** — `screendump` is compiled out of
      a `--without-default-features` build.
- [x] `/proc/interrupts` is a cheap check that the input side is live:
      vsync (3) and keyboard-receive (15) should both be counting.

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
  - **NetBSD/acorn32** — *moved up to Phase 2a as the primary target.* Not
    historic: acorn32 ships in the current **NetBSD 10.1** release. Remaining
    Phase 4 work is only userland (install sets, disc images) once it boots.
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
| 2 NetBSD boot + screen + input | 2–3 weeks |
| 3 storage UX + floppy | ~1 week |
| 4 ecosystem | ongoing |

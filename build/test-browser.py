#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0
# Headless browser check for the assembled _site/: press POWER and assert the
# guest reaches userspace. This is the browser counterpart of run-node.mjs and
# the gate for "the page actually boots", not just "the page loads".
#
# Usage: build/testvenv/bin/python build/test-browser.py [url] [timeout_s]

import re
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8777/"
TIMEOUT = int(sys.argv[2]) if len(sys.argv) > 2 else 300

# Exercise the non-default module so this test proves that the selector changes
# the binary QEMU boots, rather than merely checking that either kernel starts.
WANT = "BusyBox on ARMv4 -- Linux 7.1.4"
KERNEL_BANNER = "Linux version 7.1.4"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--enable-features=SharedArrayBuffer"])
        page = browser.new_page()

        console = []
        page.on("console", lambda m: console.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: console.append(f"[pageerror] {e}"))

        page.goto(URL, wait_until="load")

        # A first-time visitor to GitHub Pages arrives without COOP/COEP:
        # coi-serviceworker registers itself and reloads the page. Wait that
        # out rather than clicking into a non-isolated context.
        def isolated_now():
            # The reload can land mid-call and destroy the execution context.
            try:
                return bool(page.evaluate("self.crossOriginIsolated"))
            except Exception:
                return False

        for _ in range(20):
            if isolated_now():
                break
            page.wait_for_timeout(1000)
        isolated = isolated_now()
        print(f"crossOriginIsolated={isolated}")
        if not isolated:
            print("RESULT: FAIL (never became cross-origin isolated)")
            browser.close()
            return 1

        # The routed cable must have real endpoints, and the generated LK201
        # keyboard must be complete. Hold a physical key long enough to inspect
        # the matching rendered key's down/up animation state.
        page.wait_for_function("""() => {
            const cable = document.querySelector('#serial-cable-sheath');
            return document.querySelectorAll('.vt-key').length >= 100
                && cable.getAttribute('d') && cable.getTotalLength() > 20;
        }""")
        hardware = page.evaluate("""() => ({
            keys: document.querySelectorAll('.vt-key').length,
            cableLength: document.querySelector('#serial-cable-sheath').getTotalLength(),
        })""")
        page.keyboard.down("a")
        physical_down = page.locator('[data-key-id="KeyA"]').evaluate(
            "el => el.classList.contains('is-pressed')"
        )
        page.keyboard.up("a")
        physical_up = not page.locator('[data-key-id="KeyA"]').evaluate(
            "el => el.classList.contains('is-pressed')"
        )
        hardware_ok = (
            hardware["keys"] >= 100
            and hardware["cableLength"] > 20
            and physical_down
            and physical_up
        )
        print(f"serial cable + LK201: {'works' if hardware_ok else 'FAILED'} "
              f"{hardware}, key_down={physical_down}, key_up={physical_up}")

        page.locator('label[for="kernel-stable"]').click()
        selector = page.evaluate("""() => ({
            stable: document.querySelector('#kernel-stable').checked,
            current: document.querySelector('#kernel-current').checked,
            disabled: document.querySelector('#kernel-selector').disabled,
            status: document.querySelector('#kernel-selection').textContent,
        })""")
        selector_ok = (
            selector["stable"]
            and not selector["current"]
            and not selector["disabled"]
            and "Linux 7.1.4" in selector["status"]
        )
        print(f"kernel selector: {'stable selected' if selector_ok else 'FAILED'} "
              f"{selector}")

        # Attach a tiny blank raw disk through the same file input a user gets
        # by clicking the drawn internal HDD. Later the guest writes a marker
        # through pata_platform and the download path must contain it.
        disk_bytes = bytes(1024 * 1024)
        page.locator("#ide-upload").set_input_files({
            "name": "browser-test.img",
            "mimeType": "application/octet-stream",
            "buffer": disk_bytes,
        })
        page.wait_for_function(
            "document.querySelector('#ide-status').textContent.includes('is ready')"
        )
        disk_selection = page.evaluate("""() => ({
            fitted: document.querySelector('#ide-drive').classList.contains('has-disk'),
            label: document.querySelector('#ide-drive-label').textContent,
            status: document.querySelector('#ide-status').textContent,
            downloadDisabled: document.querySelector('#ide-download').disabled,
        })""")
        disk_selection_ok = (
            disk_selection["fitted"]
            and "browser-test.img" in disk_selection["label"]
            and "1.0 MiB" in disk_selection["label"]
            and disk_selection["downloadDisabled"]
        )
        print(f"IDE image selection: "
              f"{'ready' if disk_selection_ok else 'FAILED'} {disk_selection}")

        # The xterm canvas is sized from measured glyphs. Safari's ui-monospace
        # metrics are wider than Chromium's, so guard against any renderer
        # escaping the terminal bezel or the bezel escaping the viewport.
        layout = page.evaluate("""() => {
            const bezel = document.querySelector('.vt-bezel').getBoundingClientRect();
            const host = document.querySelector('#terminal').getBoundingClientRect();
            const root = document.querySelector('#terminal .xterm');
            const screen = root.querySelector('.xterm-screen').getBoundingClientRect();
            const viewport = root.querySelector('.xterm-viewport');
            const style = getComputedStyle(root);
            const px = value => Number.parseFloat(value) || 0;
            const expectedWidth = screen.width
                + px(style.paddingLeft) + px(style.paddingRight)
                + Math.max(0, viewport.offsetWidth - viewport.clientWidth);
            const expectedHeight = screen.height
                + px(style.paddingTop) + px(style.paddingBottom);
            const canvases = [...document.querySelectorAll('#terminal canvas')]
                .map(canvas => canvas.getBoundingClientRect());
            // xterm.js can select either a canvas or DOM renderer. The screen
            // box is the correct fallback for the latter.
            const rendered = canvases.length ? canvases : [screen];
            return {
                bezelLeft: bezel.left,
                bezelRight: bezel.right,
                viewportWidth: innerWidth,
                widthError: Math.abs(host.width - Math.ceil(expectedWidth)),
                heightError: Math.abs(host.height - Math.ceil(expectedHeight)),
                renderer: canvases.length ? 'canvas' : 'dom',
                contentLeft: Math.min(...rendered.map(rect => rect.left)),
                contentRight: Math.max(...rendered.map(rect => rect.right)),
            };
        }""")
        layout_ok = (
            layout["bezelLeft"] >= -0.5
            and layout["bezelRight"] <= layout["viewportWidth"] + 0.5
            and layout["contentLeft"] >= layout["bezelLeft"] - 0.5
            and layout["contentRight"] <= layout["bezelRight"] + 0.5
            and layout["widthError"] <= 0.5
            and layout["heightError"] <= 0.5
        )
        print(f"terminal layout: {'fits' if layout_ok else 'OVERFLOW'} {layout}")

        page.click("#power")

        # The terminal's text lives in xterm.js's buffer, not the DOM, so
        # scrape it out rather than matching on rendered rows.
        read_buffer = """() => {
            const t = window.__term;
            if (!t) return '';
            const b = t.buffer.active;
            let out = [];
            for (let i = 0; i < b.length; i++) {
                const line = b.getLine(i);
                if (line) out.push(line.translateToString(true));
            }
            return out.join('\\n');
        }"""

        def download_disk():
            with page.expect_download(timeout=10000) as download_info:
                page.click("#ide-download")
            download = download_info.value
            with open(download.path(), "rb") as exported:
                exported.seek(4096)
                marker = exported.read(7)
                exported.seek(0, 2)
                exported_size = exported.tell()
            return {
                "name": download.suggested_filename,
                "size": exported_size,
                "marker": marker,
            }

        deadline = TIMEOUT * 1000
        step = 2000
        waited = 0
        text = ""
        while waited < deadline:
            page.wait_for_timeout(step)
            waited += step
            text = page.evaluate(read_buffer)
            if WANT in text:
                break
            if waited % 20000 == 0:
                tail = [l for l in text.strip().split("\n") if l.strip()][-1:]
                print(f"  {waited//1000}s: {tail}")

        booted = WANT in text and KERNEL_BANNER in text

        # The RISC PC monitor is a separate VIDC20 framebuffer. A visible
        # canvas is not enough: sample the pixels to prove QEMU actually drew
        # the guest's fbcon rather than merely revealing an empty element.
        display_ok = False
        display = {}
        if booted:
            try:
                page.wait_for_function("""() => {
                    const canvas = document.querySelector('#screen');
                    if (!canvas.classList.contains('live')) return false;
                    const pixels = canvas.getContext('2d').getImageData(
                        0, 0, canvas.width, canvas.height).data;
                    let lit = 0;
                    for (let i = 0; i < pixels.length; i += 16) {
                        if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) lit++;
                    }
                    return lit > 100;
                }""", timeout=30000)
                display = page.evaluate("""() => {
                    const canvas = document.querySelector('#screen');
                    const pixels = canvas.getContext('2d').getImageData(
                        0, 0, canvas.width, canvas.height).data;
                    let lit = 0;
                    for (let i = 0; i < pixels.length; i += 16) {
                        if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) lit++;
                    }
                    return {
                        live: canvas.classList.contains('live'),
                        width: canvas.width,
                        height: canvas.height,
                        litSamples: lit,
                    };
                }""")
                display_ok = (
                    display["live"]
                    and display["width"] == 640
                    and display["height"] == 480
                    and display["litSamples"] > 100
                )
            except Exception as exc:
                console.append(f"[display] {exc}")
            print(f"VIDC20 canvas: {'live' if display_ok else 'FAILED'} {display}")

        # A shell prompt is written without a trailing newline. It must become
        # visible before we type anything; otherwise Emscripten stdout has
        # regressed to its default line-buffered TTY behavior.
        prompt_visible = False
        if booted:
            for _ in range(15):
                text = page.evaluate(read_buffer)
                lines = [line.rstrip() for line in text.split("\n")]
                if any(line.endswith(" #") for line in lines):
                    prompt_visible = True
                    break
                page.wait_for_timeout(1000)
        print(f"initial prompt: {'visible' if prompt_visible else 'MISSING'}")

        # Type into the guest and see whether it answers. Input travels
        # main thread -> stdin-proxy.js -> QEMU's fd 0 on the worker.
        typed_ok = False
        if booted:
            page.click("#terminal")
            page.keyboard.type("uname -m")
            page.keyboard.press("Enter")
            for _ in range(30):
                page.wait_for_timeout(2000)
                after = page.evaluate(read_buffer)
                if "armv4l" in after.replace(WANT, ""):
                    typed_ok = True
                    text = after
                    break
            print(f"keyboard input: {'works' if typed_ok else 'NO RESPONSE'}")

        # Focus now selects the other input path. Read the real rpckbd receive
        # interrupt count over serial, press a key with the VIDC20 canvas in
        # focus, and require that Linux observes a new interrupt. The bridge's
        # per-kind counters independently cover mouse button and motion events.
        machine_input_ok = False
        machine_input = {}
        if typed_ok and display_ok:
            irq_pattern = re.compile(r"^\s*15:\s+(\d+)\b.*\brpckbd\b", re.M)

            page.click("#terminal")
            before_lines = irq_pattern.findall(page.evaluate(read_buffer))
            page.keyboard.type("grep '^ *15:' /proc/interrupts")
            page.keyboard.press("Enter")
            before_irq = None
            for _ in range(20):
                page.wait_for_timeout(500)
                before_lines_now = irq_pattern.findall(page.evaluate(read_buffer))
                if len(before_lines_now) > len(before_lines):
                    before_irq = int(before_lines_now[-1])
                    break

            canvas = page.locator("#screen")
            canvas.click(position={"x": 120, "y": 90})
            box = canvas.bounding_box()
            if box:
                page.mouse.move(box["x"] + 128, box["y"] + 96)
            page.keyboard.press("a")
            page.wait_for_function("""() => {
                const stats = self.__rpcInputStats;
                const kinds = stats && stats.poppedByType;
                return kinds && kinds[1] && kinds[2] && kinds[3]
                    && kinds[4] && kinds[5] && kinds[6];
            }""", timeout=10000)

            page.click("#terminal")
            after_lines = irq_pattern.findall(page.evaluate(read_buffer))
            page.keyboard.type("grep '^ *15:' /proc/interrupts")
            page.keyboard.press("Enter")
            after_irq = None
            for _ in range(20):
                page.wait_for_timeout(500)
                after_lines_now = irq_pattern.findall(page.evaluate(read_buffer))
                if len(after_lines_now) > len(after_lines):
                    after_irq = int(after_lines_now[-1])
                    break

            machine_input = page.evaluate("self.__rpcInputStats")
            machine_input.update({"irqBefore": before_irq, "irqAfter": after_irq})
            kinds = machine_input.get("poppedByType", {})
            machine_input_ok = (
                before_irq is not None
                and after_irq is not None
                and after_irq > before_irq
                and all(int(kinds.get(str(kind), 0)) > 0 for kind in range(1, 7))
            )
            print(f"monitor PS/2 + mouse input: "
                  f"{'works' if machine_input_ok else 'FAILED'} {machine_input}")

        # Enter a second command using only the rendered LK201 buttons. This
        # checks the pointer/touch path separately from xterm's physical input.
        virtual_keys_ok = False
        if typed_ok:
            for key_id in (
                "KeyE", "KeyC", "KeyH", "KeyO", "Space",
                "KeyL", "KeyK", "Digit2", "Digit0", "Digit1", "Return",
            ):
                page.locator(f'[data-key-id="{key_id}"]').click()
            for _ in range(30):
                page.wait_for_timeout(1000)
                after = page.evaluate(read_buffer)
                if "lk201" in after.replace("echo lk201", ""):
                    virtual_keys_ok = True
                    text = after
                    break
            print(f"on-screen LK201 input: "
                  f"{'works' if virtual_keys_ok else 'NO RESPONSE'}")

        # Write through Linux's IDE block device, flush the guest cache, then
        # export the MEMFS-backed raw image and verify the changed bytes. This
        # checks upload -> QEMU -> pata_platform -> download as one round trip.
        ide_round_trip_ok = False
        ide_round_trip = {}
        if virtual_keys_ok:
            command = (
                "printf RPCDISK|dd of=/dev/sda bs=512 seek=8 2>/dev/null"
                "&&sync&&echo IDE_OK"
            )
            page.click("#terminal")
            page.keyboard.type(command)
            page.keyboard.press("Enter")
            for _ in range(30):
                page.wait_for_timeout(1000)
                after = page.evaluate(read_buffer)
                if any(line.strip() == "IDE_OK" for line in after.split("\n")):
                    text = after
                    break

            marker_written = any(
                line.strip() == "IDE_OK" for line in text.split("\n")
            )
            download_enabled = page.locator("#ide-download").is_enabled()
            if marker_written and download_enabled:
                exported = download_disk()
                ide_round_trip = {
                    **exported,
                    "marker": exported["marker"].decode("ascii", errors="replace"),
                }
                ide_round_trip_ok = (
                    exported["name"] == "modified-browser-test.img"
                    and exported["size"] == len(disk_bytes)
                    and exported["marker"] == b"RPCDISK"
                )
            print(f"IDE upload/write/download: "
                  f"{'works' if ide_round_trip_ok else 'FAILED'} {ide_round_trip}")

        persistence_save_ok = False
        persistence_save = {}
        if ide_round_trip_ok:
            page.click("#ide-save")
            page.wait_for_function(
                "document.querySelector('#ide-status').textContent.includes('is saved')",
                timeout=30000,
            )
            persistence_save = page.evaluate("""() => ({
                savedChoiceVisible: !document.querySelector('#ide-saved-choice').hidden,
                saveEnabled: !document.querySelector('#ide-save').disabled,
                resetEnabled: !document.querySelector('#ide-reset').disabled,
                metadata: localStorage.getItem('riscpc-persistent-ide'),
                status: document.querySelector('#ide-status').textContent,
            })""")
            persistence_save_ok = (
                persistence_save["savedChoiceVisible"]
                and persistence_save["saveEnabled"]
                and persistence_save["resetEnabled"]
                and "browser-test.img" in (persistence_save["metadata"] or "")
            )
            print(f"IDBFS save: "
                  f"{'works' if persistence_save_ok else 'FAILED'} "
                  f"{persistence_save}")

        # Once running, POWER is a hard switch: it must reload the page (which
        # terminates the Wasm pthread) and return to a clean powered-off scene.
        hard_off_ok = False
        if (virtual_keys_ok and machine_input_ok and ide_round_trip_ok
                and persistence_save_ok):
            try:
                page.wait_for_function("!document.querySelector('#power').disabled")
                with page.expect_navigation(wait_until="load", timeout=10000):
                    page.click("#power")
                off_text = page.evaluate(read_buffer)
                led_on = page.locator("#power-led").evaluate(
                    "el => el.classList.contains('on')"
                )
                hard_off_ok = (
                    "Machine is powered off. Press POWER." in off_text
                    and page.locator("#power").is_enabled()
                    and not led_on
                    and page.locator("#kernel-stable").is_checked()
                    and page.locator("#kernel-stable").is_enabled()
                    and not page.locator("#ide-drive").evaluate(
                        "el => el.classList.contains('has-disk')"
                    )
                    and page.locator("#ide-download").is_disabled()
                    and page.locator("#ide-saved-choice").is_visible()
                    and not page.locator("#ide-use-saved").is_checked()
                )
            except Exception as exc:
                console.append(f"[hard-off] {exc}")
            print(f"hard power off: {'works' if hard_off_ok else 'FAILED'}")

        # Persistence is opt-in on every load. Explicitly select the saved
        # image, start a fresh Wasm instance, and prove the guest-written bytes
        # came back from IndexedDB. Then reset the saved copy to the original
        # upload and verify that state across one more hard power cycle.
        persistence_restore_ok = False
        factory_reset_ok = False
        if hard_off_ok:
            page.locator("#ide-use-saved").check()
            page.click("#power")
            page.wait_for_function(
                "!document.querySelector('#ide-download').disabled",
                timeout=120000,
            )
            restored = download_disk()
            persistence_restore_ok = (
                restored["size"] == len(disk_bytes)
                and restored["marker"] == b"RPCDISK"
            )
            print("IDBFS restore: "
                  f"{'works' if persistence_restore_ok else 'FAILED'} "
                  f"size={restored['size']}, marker={restored['marker']!r}")

            if persistence_restore_ok:
                page.click("#ide-reset")
                page.wait_for_function(
                    "document.querySelector('#ide-status').textContent.includes('reset to factory')",
                    timeout=30000,
                )
                page.wait_for_function("!document.querySelector('#power').disabled")
                with page.expect_navigation(wait_until="load", timeout=10000):
                    page.click("#power")

                page.locator("#ide-use-saved").check()
                page.click("#power")
                page.wait_for_function(
                    "!document.querySelector('#ide-download').disabled",
                    timeout=120000,
                )
                factory = download_disk()
                factory_reset_ok = (
                    factory["size"] == len(disk_bytes)
                    and factory["marker"] == bytes(7)
                )
                print("IDBFS factory reset: "
                      f"{'works' if factory_reset_ok else 'FAILED'} "
                      f"size={factory['size']}, marker={factory['marker']!r}")

                page.wait_for_function("!document.querySelector('#power').disabled")
                with page.expect_navigation(wait_until="load", timeout=10000):
                    page.click("#power")

        ok = (hardware_ok and selector_ok and disk_selection_ok
              and layout_ok and booted
              and display_ok and prompt_visible and typed_ok
              and machine_input_ok and virtual_keys_ok
              and ide_round_trip_ok and persistence_save_ok and hard_off_ok
              and persistence_restore_ok and factory_reset_ok)

        print("\n--- terminal ---")
        print("\n".join(l for l in text.split("\n") if l.strip()))
        if console:
            print("\n--- console ---")
            print("\n".join(console[-25:]))
        print(f"\nRESULT: {'PASS' if ok else 'FAIL'} "
              f"(hardware={hardware_ok}, selector={selector_ok}, "
              f"disk_select={disk_selection_ok}, "
              f"layout={layout_ok}, boot={booted}, prompt={prompt_visible}, "
              f"display={display_ok}, physical_input={typed_ok}, "
              f"machine_input={machine_input_ok}, virtual_input={virtual_keys_ok}, "
              f"ide_round_trip={ide_round_trip_ok}, "
              f"idbfs_save={persistence_save_ok}, hard_off={hard_off_ok}, "
              f"idbfs_restore={persistence_restore_ok}, "
              f"factory_reset={factory_reset_ok})")
        browser.close()
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

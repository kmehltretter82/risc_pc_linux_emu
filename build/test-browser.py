#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0
# Headless browser check for the assembled _site/: press POWER and assert the
# guest reaches userspace. This is the browser counterpart of run-node.mjs and
# the gate for "the page actually boots", not just "the page loads".
#
# Usage: build/testvenv/bin/python build/test-browser.py [url] [timeout_s]

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
            return {
                bezelLeft: bezel.left,
                bezelRight: bezel.right,
                viewportWidth: innerWidth,
                widthError: Math.abs(host.width - Math.ceil(expectedWidth)),
                heightError: Math.abs(host.height - Math.ceil(expectedHeight)),
                canvasLeft: Math.min(...canvases.map(rect => rect.left)),
                canvasRight: Math.max(...canvases.map(rect => rect.right)),
            };
        }""")
        layout_ok = (
            layout["bezelLeft"] >= -0.5
            and layout["bezelRight"] <= layout["viewportWidth"] + 0.5
            and layout["canvasLeft"] >= layout["bezelLeft"] - 0.5
            and layout["canvasRight"] <= layout["bezelRight"] + 0.5
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

        # Once running, POWER is a hard switch: it must reload the page (which
        # terminates the Wasm pthread) and return to a clean powered-off scene.
        hard_off_ok = False
        if typed_ok:
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
                )
            except Exception as exc:
                console.append(f"[hard-off] {exc}")
            print(f"hard power off: {'works' if hard_off_ok else 'FAILED'}")

        ok = (selector_ok and layout_ok and booted and prompt_visible
              and typed_ok and hard_off_ok)

        print("\n--- terminal ---")
        print("\n".join(l for l in text.split("\n") if l.strip()))
        if console:
            print("\n--- console ---")
            print("\n".join(console[-25:]))
        print(f"\nRESULT: {'PASS' if ok else 'FAIL'} "
              f"(selector={selector_ok}, layout={layout_ok}, boot={booted}, "
              f"prompt={prompt_visible}, "
              f"input={typed_ok}, hard_off={hard_off_ok})")
        browser.close()
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

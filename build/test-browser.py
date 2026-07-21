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

# What the serial console must show for the boot to count as successful.
WANT = "BusyBox on ARMv4"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--enable-features=SharedArrayBuffer"])
        page = browser.new_page()

        console = []
        page.on("console", lambda m: console.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: console.append(f"[pageerror] {e}"))

        page.goto(URL, wait_until="load")
        isolated = page.evaluate("self.crossOriginIsolated")
        print(f"crossOriginIsolated={isolated}")

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

        ok = WANT in text

        # Type into the guest and see whether it answers. Input travels
        # main thread -> stdin-proxy.js -> QEMU's fd 0 on the worker.
        typed_ok = False
        if ok:
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

        print("\n--- terminal ---")
        print("\n".join(l for l in text.split("\n") if l.strip()))
        if console:
            print("\n--- console ---")
            print("\n".join(console[-25:]))
        print(f"\nRESULT: {'PASS' if ok else 'FAIL'} (looked for {WANT!r})")
        browser.close()
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

// SPDX-License-Identifier: GPL-2.0
//
// Guest display -> browser canvas.
//
// Counterpart of qemu/ui/wasm-canvas.c. QEMU's main() runs on a worker
// under -sPROXY_TO_PTHREAD while the canvas lives on the browser main
// thread, so - exactly as build/stdin-proxy.js does for the keyboard -
// the call goes outwards from C and is marked __proxy: 'sync'. The
// worker blocks on Atomics while the body runs over here.
//
// pthreads implies a SharedArrayBuffer, so the surface pointer QEMU
// hands us is readable from this thread without copying it across.
//
// The page supplies globalThis.__rpcCanvas and __rpcMachineInput (see
// frontend/app.js).

addToLibrary({
  rpc_fb_blit__proxy: 'sync',
  rpc_fb_blit: (data, width, height, stride) => {
    const target = globalThis.__rpcCanvas;
    if (!target || !width || !height) {
      return;
    }

    // MEMORY64=2 uses BigInt for Wasm pointers. The heap is capped at 2 GiB,
    // so converting this byte offset to Number is exact and keeps the pixel
    // arithmetic below from mixing the two JavaScript numeric domains.
    data = Number(data);

    const resized = target.width !== width || target.height !== height;
    if (resized) {
      target.width = width;
      target.height = height;
      target.__rpcImage = null;
    }

    // The markup starts at 640x480, which is also Linux's first mode.  Mode
    // equality therefore cannot be used as a first-frame signal.
    if (!target.__rpcReady || resized) {
      target.__rpcReady = true;
      if (globalThis.__rpcOnResize) {
        globalThis.__rpcOnResize(width, height);
      }
    }

    const ctx = target.__rpcCtx ||
                (target.__rpcCtx = target.getContext('2d'));
    const image = target.__rpcImage ||
                  (target.__rpcImage = ctx.createImageData(width, height));
    const out = image.data;

    // QEMU's surface is 32bpp native-endian xRGB; ImageData wants RGBA.
    for (let y = 0; y < height; y++) {
      let src = data + y * stride;
      let dst = y * width * 4;
      for (let x = 0; x < width; x++, src += 4, dst += 4) {
        out[dst]     = HEAPU8[src + 2];
        out[dst + 1] = HEAPU8[src + 1];
        out[dst + 2] = HEAPU8[src];
        out[dst + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  },

  // Pull one packed browser input event, or zero when the queue is empty.
  // The high byte is the event kind and the low 16 bits are its value.  This
  // function is proxied for the same reason as rpc_fb_blit: the queue belongs
  // to the browser main thread, while QEMU consumes it from its worker.
  rpc_input_pop__proxy: 'sync',
  rpc_input_pop: () => {
    const queue = globalThis.__rpcMachineInput;
    if (!queue || queue.head >= queue.events.length) {
      if (queue && queue.head) {
        queue.events.length = 0;
        queue.head = 0;
      }
      return 0;
    }

    const event = queue.events[queue.head++] >>> 0;
    if (globalThis.__rpcInputStats) {
      globalThis.__rpcInputStats.popped++;
      const kind = event >>> 24;
      const byType = globalThis.__rpcInputStats.poppedByType;
      byType[kind] = (byType[kind] || 0) + 1;
    }

    // Compact occasionally without making every pop an O(n) Array.shift().
    if (queue.head >= 256 && queue.head * 2 >= queue.events.length) {
      queue.events.splice(0, queue.head);
      queue.head = 0;
    }
    return event;
  },
});

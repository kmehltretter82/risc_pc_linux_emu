// SPDX-License-Identifier: GPL-2.0
//
// Keyboard input for the browser build.
//
// QEMU is linked with -sPROXY_TO_PTHREAD, so main() - and therefore every
// read() on the serial console's fd 0 - runs on a worker. The keystrokes,
// though, arrive on the browser main thread where xterm.js lives, and the
// queue holding them cannot be cloned into the worker. Emscripten's own
// __proxy: 'sync' does exactly the right thing: the function body runs on the
// main thread while the calling worker blocks on it via Atomics.
//
// xterm-pty solves the same problem with a full termios pty, but its PTY
// object has the same main-thread-only problem and it does not proxy the
// read path, so it cannot be used in this mode.
//
// The page fills globalThis.__rpcStdin (see frontend/app.js).

const Lib = LibraryManager.library;

addToLibrary({
  // Pull one byte, or -1 when nothing is buffered.
  rpc_stdin_getchar__proxy: 'sync',
  rpc_stdin_getchar: () => {
    const q = globalThis.__rpcStdin;
    return q && q.length ? q.shift() : -1;
  },

  // Is a byte available? Keeps poll() from claiming readable forever, which
  // would spin QEMU's main loop on EAGAIN.
  rpc_stdin_readable__proxy: 'sync',
  rpc_stdin_readable: () => {
    const q = globalThis.__rpcStdin;
    return q && q.length ? 1 : 0;
  },
});

Lib.$TTY__deps = (Lib.$TTY__deps || []).concat([
  'rpc_stdin_getchar',
  'rpc_stdin_readable',
]);

// Feed stdin from the page instead of emscripten's default (which reads
// Module.stdin on whichever thread asks - undefined out here in the worker).
Lib.$TTY.default_tty_ops.get_char = () => {
  const c = _rpc_stdin_getchar();
  // undefined => EAGAIN for the first byte, which is what a non-blocking
  // console read should report when idle. null would mean EOF and would
  // make QEMU close the chardev.
  return c < 0 ? undefined : c;
};

// Only the input tty can be readable; default_tty1_ops (stdout/stderr) has no
// get_char, so those streams stay write-only.
Lib.$TTY.stream_ops.poll = (stream) => {
  const isInput = stream.tty && stream.tty.ops.get_char;
  const readable = isInput && _rpc_stdin_readable() !== 0;
  return (readable ? {{{ cDefs.POLLIN }}} : 0) | {{{ cDefs.POLLOUT }}};
};

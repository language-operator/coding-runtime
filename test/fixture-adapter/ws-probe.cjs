/**
 * Drive the web terminal the way a browser does, and prove a keystroke reaches
 * the process on the other side.
 *
 * Runs inside the adapter image, sharing the server container's network
 * namespace, so it can use the base image's own `ws` and reach the terminal on
 * loopback exactly as the oauth2-proxy sidecar would.
 *
 *   node ws-probe.cjs <url> <origin>
 *
 * Exits 0 when the terminal echoed the command *and* returned its output.
 */

const WebSocket = require('/opt/coding-runtime/node_modules/ws');

const [url, origin] = process.argv.slice(2);

// Split so the marker cannot appear merely because the terminal echoed what was
// typed: the echo shows the quotes, only the shell's own output reconstitutes
// the whole word.
const MARKER = 'CONFORMANCE_TERMINAL_OK';
const COMMAND = 'echo CONFORMANCE_TERMINAL""_OK\r';

const ws = new WebSocket(url, origin ? { headers: { Origin: origin } } : {});
let seen = '';

const done = (code, why) => {
  console.log(why);
  process.exit(code);
};

const timer = setTimeout(() => done(1, `timed out; terminal produced:\n${seen.slice(-500)}`), 20000);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  // The harness needs a moment to start under tmux before it will accept input.
  setTimeout(() => ws.send(COMMAND), 2000);
});

ws.on('message', (data) => {
  seen += data.toString();
  if (seen.includes(MARKER)) {
    clearTimeout(timer);
    ws.close();
    done(0, 'terminal round-trip ok');
  }
});

ws.on('unexpected-response', (_req, res) => done(1, `upgrade rejected with ${res.statusCode}`));
ws.on('error', (err) => done(1, `socket error: ${err.message}`));

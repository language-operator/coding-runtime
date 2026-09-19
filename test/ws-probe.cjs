/**
 * Drive the web terminal the way a browser does.
 *
 *   node ws-probe.cjs <url> <origin> <text>
 *
 * Opens the terminal socket, waits for the agent to render something, types
 * <text> as plain keystrokes, and confirms more output comes back. Exits 0 when
 * the socket carried traffic in both directions.
 *
 * What it deliberately does *not* do is assert what the typed text means. An
 * earlier version typed a shell command and waited for its output, which can
 * only work when the terminal runs a shell — and the whole point of the thick
 * base is to run a TUI, which puts typed text in a prompt box instead of
 * executing it. Whether the keystrokes actually reached the process is settled
 * by asking tmux what the pane contains, which is true of any program.
 *
 * No Enter is sent, for the same reason: submitting a line means something
 * different, and potentially something destructive, in every terminal program.
 */

const WebSocket = require('/opt/coding-runtime/node_modules/ws');

const [url, origin, text] = process.argv.slice(2);
if (!url || !text) {
  console.error('usage: ws-probe.cjs <url> <origin> <text>');
  process.exit(2);
}

const RENDER_TIMEOUT_MS = 20000;
const SETTLE_MS = 3000;
const REPLY_WINDOW_MS = 5000;

const ws = new WebSocket(url, origin ? { headers: { Origin: origin } } : {});

let before = '';
let after = '';
let typed = false;

const finish = (code, why) => {
  console.log(why);
  try { ws.close(); } catch { /* already closing */ }
  process.exit(code);
};

const timer = setTimeout(
  () => finish(1, `timed out waiting for the terminal to render; received ${before.length} bytes`),
  RENDER_TIMEOUT_MS,
);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
});

ws.on('message', (data) => {
  if (typed) {
    after += data.toString();
    return;
  }
  before += data.toString();
  if (before.length === 0) return;

  // Something is on screen. Give a TUI a moment to finish its first paint
  // before typing, then send the keystrokes.
  clearTimeout(timer);
  typed = true;
  setTimeout(() => {
    ws.send(text);
    setTimeout(() => {
      if (after.length === 0) {
        finish(1, `typed ${text.length} bytes but the terminal sent nothing back`);
      }
      finish(0, `terminal rendered ${before.length} bytes, echoed ${after.length} after input`);
    }, REPLY_WINDOW_MS);
  }, SETTLE_MS);
});

ws.on('unexpected-response', (_req, res) => finish(1, `upgrade rejected with ${res.statusCode}`));
ws.on('error', (err) => finish(1, `socket error: ${err.message}`));

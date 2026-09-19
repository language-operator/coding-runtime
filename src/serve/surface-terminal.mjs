/**
 * The web terminal: a WebSocket bridged to a pty running the harness inside tmux.
 *
 * tmux is what makes the session survive the browser. The pty/WebSocket pair is
 * just a tmux *client*: when the socket closes we kill the client, and the
 * session — with the agent still running inside it — stays up waiting for the
 * next reconnect. `new-session -A` attaches to the existing session when there
 * is one and creates it otherwise, so reloading the page rejoins the same
 * session rather than starting a second agent.
 */

import { WebSocketServer } from 'ws';

import { checkOrigin } from './origin.mjs';

const DEFAULT_KEEPALIVE_SECONDS = 25;

export function createTerminalSurface({ manifest, env, log = console }) {
  const terminal = manifest.terminal ?? {};
  const wsPath = terminal.wsPath ?? '/ws';
  const sessionName = terminal.tmuxSession ?? manifest.name ?? 'agent';
  const tmuxConf = terminal.tmuxConf ?? '/etc/tmux.conf';
  const cwd = terminal.cwd ?? manifest.paths?.workDir ?? '/workspace';
  const launch = terminal.launch ?? [];
  const keepaliveMs = (terminal.keepaliveSeconds ?? DEFAULT_KEEPALIVE_SECONDS) * 1000;

  let wss = null;

  return {
    name: 'terminal',
    wsPath,

    /**
     * A terminal surface is ready as soon as it can accept a connection — the
     * agent process is started per-connection, not at boot.
     */
    async ready() {
      return { ready: true };
    },

    attach(server) {
      wss = new WebSocketServer({
        server,
        path: wsPath,
        verifyClient: ({ req }, done) => {
          if (!manifest.serve.originGuard) return done(true);

          const { allowed, reason } = checkOrigin({
            origin: req.headers.origin,
            host: req.headers.host,
            allowedOrigins: manifest.serve.allowedOrigins ?? [],
          });
          if (allowed) return done(true);

          // Logged rather than dropped silently: a proxy that rewrites Host
          // shows up as a terminal that never connects, and this line is the
          // only thing that points at the cause.
          log.warn(
            `ws upgrade rejected: ${reason} (origin=${req.headers.origin} host=${req.headers.host}); ` +
            'set ALLOWED_ORIGINS if this origin is legitimate',
          );
          done(false, 403, 'Forbidden');
        },
      });

      wss.on('connection', (ws, req) => this.onConnection(ws, req));
      return wss;
    },

    async onConnection(ws, req) {
      const remote = req.socket.remoteAddress;
      log.log(`ws connect from ${remote}`);

      // Imported here rather than at module load so the rest of the runtime —
      // and the whole unit test suite — works on a machine where this native
      // addon was never compiled.
      const pty = (await import('node-pty')).default;

      const term = pty.spawn('tmux', ['-f', tmuxConf, 'new-session', '-A', '-s', sessionName, ...launch], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env,
      });

      term.onData((data) => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      });
      term.onExit(({ exitCode, signal }) => {
        log.log(`pty exit code=${exitCode} signal=${signal}`);
        if (ws.readyState === ws.OPEN) ws.close();
      });

      // Keepalive.
      //
      // The ingress in front of an agent closes idle connections — 60s by
      // default on nginx-ingress — and a LanguageAgentRuntime has no way to
      // raise that, since the CRD exposes no ingress annotations. A terminal
      // the user leaves open while reading is idle by definition, so without
      // traffic of our own it simply dies. Ping frames are that traffic, and
      // the missed-pong check also reaps sockets whose peer vanished.
      let alive = true;
      ws.on('pong', () => { alive = true; });
      const heartbeat = setInterval(() => {
        if (!alive) {
          log.warn(`ws from ${remote} missed a pong; terminating`);
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, keepaliveMs);

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          term.write(data);
          return;
        }
        const text = data.toString();
        if (text.length > 0 && text.charCodeAt(0) === 0x7b /* { */) {
          try {
            const msg = JSON.parse(text);
            if (msg?.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
              term.resize(msg.cols, msg.rows);
              return;
            }
          } catch {
            // Not JSON after all — fall through and treat it as raw input.
          }
        }
        term.write(text);
      });

      ws.on('close', () => {
        log.log(`ws close from ${remote}`);
        clearInterval(heartbeat);
        // Kills the tmux *client* only. The session, and the agent inside it,
        // keep running for the next reconnect.
        try { term.kill(); } catch { /* already exited */ }
      });
    },

    async close() {
      if (wss) await new Promise((resolve) => wss.close(resolve));
    },
  };
}

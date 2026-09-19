/**
 * The HTTP server every serving surface sits behind.
 *
 * Endpoint naming matters here: oauth2-proxy v7.6.0 intercepts `/ping` and
 * `/ready` (as well as `/oauth2/*`) before the upstream ever sees them, so a
 * runtime that used those names would have probes that silently answer from the
 * proxy instead of the agent. `/healthz` and `/readyz` are clear.
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicManifest } from '../manifest.mjs';
import { staticAssets } from './static.mjs';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const htmlEscape = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

function renderIndex({ agentName, wsPath }) {
  return readFileSync(join(UI_DIR, 'index.html'), 'utf8')
    // Agent names are RFC 1123 in practice, but escaping is free and the
    // constraint is the operator's to loosen, not ours to rely on.
    .replaceAll('__AGENT_NAME__', htmlEscape(agentName))
    .replaceAll('__WS_PATH__', htmlEscape(wsPath ?? '/ws'));
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`${JSON.stringify(body)}\n`);
};

export function createServer({ manifest, surface, agentName, log = console }) {
  const assets = surface.name === 'terminal' ? staticAssets() : {};
  const index = surface.name === 'terminal' ? renderIndex({ agentName, wsPath: surface.wsPath }) : null;

  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;

    if (path === '/healthz') {
      // Liveness only: the process is up and the event loop is turning.
      return json(res, 200, { status: 'ok', runtime: manifest.name });
    }

    if (path === '/readyz') {
      let state;
      try {
        state = await surface.ready();
      } catch (err) {
        state = { ready: false, reason: err.message };
      }
      return json(res, state.ready ? 200 : 503, { status: state.ready ? 'ready' : 'not-ready', ...state });
    }

    if (path === '/runtime.json') {
      return json(res, 200, publicManifest(manifest));
    }

    if (index && (path === '/' || path === '')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(index);
    }

    // Assets are matched on the final path segment so the page still works when
    // the ingress mounts the agent under a sub-path.
    const asset = assets[basename(path)];
    if (asset) {
      try {
        const buf = readFileSync(asset.file);
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
        return res.end(buf);
      } catch (err) {
        log.error(`failed to read ${asset.file}: ${err.message}`);
        return json(res, 500, { error: 'internal error' });
      }
    }

    return json(res, 404, { error: 'not found' });
  });

  surface.attach(server);
  return server;
}

export async function listen(server, port, log = console) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // 0.0.0.0 because the oauth2-proxy sidecar reaches the agent over the pod's
    // loopback-but-not-localhost path, and the kubelet probes it from outside.
    server.listen(port, '0.0.0.0', resolve);
  });
  log.log(`listening on :${port}`);
  return server;
}

#!/usr/bin/env node
/**
 * coding-runtime — the base image's entrypoint.
 *
 *   env      print the resolved environment as shell exports
 *   seed     translate /etc/agent/config.yaml into the harness's native config
 *   serve    run the serving surface named by the manifest
 *   doctor   check the image against the constraints the operator imposes
 *   version  print the base version
 *
 * `seed` and `serve` are separate because the agent container runs both in
 * sequence (`seed && exec serve`) rather than splitting them across an init
 * container. An init container cannot hand anything to the agent container
 * anyway: the operator mounts /tmp only into the agent container, so there is
 * no shared writable path between them.
 */

import { readFileSync, existsSync, accessSync, constants, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadManifest, MANIFEST_PATH } from './manifest.mjs';
import { normalize } from './config/normalize.mjs';
import { ensureDir, writeFileAtomic } from './config/writers.mjs';
import { loadEmitter, applyWrites } from './emit.mjs';
import { parseAllowedOrigins } from './serve/origin.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function version() {
  const versionFile = join(ROOT, 'VERSION');
  if (existsSync(versionFile)) return readFileSync(versionFile, 'utf8').trim();
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0-unknown';
  }
}

const readAgentConfig = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

const isWritable = (path) => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The environment the harness actually runs with.
 *
 * Every value here exists because the agent container runs with
 * `readOnlyRootFilesystem: true` as uid 1000, with only /tmp and the workspace
 * PVC writable — and /tmp is a memory-backed emptyDir with no size limit, so
 * anything cache-shaped that lands there is charged against the pod's memory
 * limit and overflows as an OOMKill rather than ENOSPC. Caches therefore go to
 * the PVC. Each adapter has patched around some part of this by hand, none the
 * same way; doing it once here is the point of the base image.
 */
export function resolveEnv(manifest, env) {
  const { paths } = manifest;
  const resolved = {
    ...env,
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.configHome,
    XDG_DATA_HOME: paths.dataHome,
    XDG_CACHE_HOME: paths.cacheHome,
    XDG_STATE_HOME: join(paths.dataHome, '..', 'state'),
    TMPDIR: paths.tmpDir,
    npm_config_cache: join(paths.cacheHome, 'npm'),
    PIP_CACHE_DIR: join(paths.cacheHome, 'pip'),
    UV_CACHE_DIR: join(paths.cacheHome, 'uv'),
    GOCACHE: join(paths.cacheHome, 'go-build'),
    GOMODCACHE: join(paths.cacheHome, 'go-mod'),
    GOPATH: join(paths.workspace, '.go'),
    // tmux's socket is small and short-lived, so it stays on the real tmpfs.
    TMUX_TMPDIR: '/tmp',
    SHELL: env.SHELL ?? '/bin/bash',
    // Harness auto-updaters would try to write to the read-only npm prefix.
    DISABLE_AUTOUPDATER: '1',
    npm_config_update_notifier: 'false',
    DO_NOT_TRACK: '1',
    PORT: String(manifest.serve.port),
    ...(manifest.env ?? {}),
  };

  // If the workspace is not writable — no PVC, or a misconfigured mount — fall
  // back to /tmp so the agent still starts rather than failing on first write.
  if (!isWritable(paths.workspace)) {
    resolved.HOME = '/tmp/home';
    resolved.TMPDIR = '/tmp';
    resolved.XDG_CACHE_HOME = '/tmp/cache';
  }
  return resolved;
}

function reportWarnings(warnings, log) {
  for (const w of warnings) {
    log.warn(`[${w.code}]${w.path ? ` ${w.path}:` : ''} ${w.message}`);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdEnv({ env, log, stdout }) {
  const { manifest } = loadManifest({ path: env.CODING_RUNTIME_MANIFEST ?? MANIFEST_PATH, env, version: version() });
  const resolved = resolveEnv(manifest, env);
  for (const [key, value] of Object.entries(resolved)) {
    if (env[key] === value) continue; // unchanged; no need to re-export
    stdout.write(`export ${key}=${JSON.stringify(String(value))}\n`);
  }
  return 0;
}

async function cmdSeed({ env, log }) {
  const { manifest, warnings: manifestWarnings } = loadManifest({ path: env.CODING_RUNTIME_MANIFEST ?? MANIFEST_PATH, env, version: version() });
  reportWarnings(manifestWarnings, log);

  const resolved = resolveEnv(manifest, env);
  for (const dir of [manifest.paths.stateDir, manifest.paths.tmpDir, manifest.paths.cacheHome, resolved.HOME]) {
    try {
      ensureDir(dir);
    } catch (err) {
      log.warn(`could not create ${dir}: ${err.message}`);
    }
  }
  for (const pre of manifest.preflight ?? []) {
    try {
      ensureDir(pre.path, pre.mode ? parseInt(pre.mode, 8) : undefined);
    } catch (err) {
      log.warn(`could not create ${pre.path}: ${err.message}`);
    }
  }

  const config = normalize({
    yamlText: readAgentConfig(manifest.paths.agentConfigPath ?? '/etc/agent/config.yaml'),
    env: resolved,
    runtimeName: manifest.name,
    codingRuntimeVersion: version(),
    paths: manifest.paths,
    now: new Date().toISOString(),
  });
  reportWarnings(config.meta.warnings, log);

  // A debug artifact, never a contract: nothing reads this back. The emitter is
  // handed the document in-process, and any other container re-derives it from
  // the same inputs rather than trusting a file it did not write.
  try {
    writeFileAtomic(join(manifest.paths.stateDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  } catch (err) {
    log.warn(`could not write the debug config snapshot: ${err.message}`);
  }

  const emit = await loadEmitter(manifest.config?.emitter);
  if (!emit) {
    log.log(`no emitter declared for '${manifest.name}'; config left to the harness`);
    return 0;
  }

  const writes = applyWrites(await emit(config, { env: resolved }), { onWarn: (w) => reportWarnings([w], log) });
  for (const w of writes) {
    log.log(`${w.changed ? 'wrote' : 'unchanged'} ${w.path}`);
  }
  return 0;
}

async function cmdServe({ env, log }) {
  const { manifest, warnings } = loadManifest({ path: env.CODING_RUNTIME_MANIFEST ?? MANIFEST_PATH, env, version: version() });
  reportWarnings(warnings, log);

  manifest.serve.allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const resolved = resolveEnv(manifest, env);

  const { createServer, listen } = await import('./serve/server.mjs');
  const surface = manifest.serve.surface === 'terminal'
    ? (await import('./serve/surface-terminal.mjs')).createTerminalSurface({ manifest, env: resolved, log })
    : (await import('./serve/surface-none.mjs')).createNoneSurface({ manifest });

  // `surface: none` with an exec: hand the port and the process over entirely.
  if (surface.name === 'none' && surface.exec) {
    const { spawn } = await import('node:child_process');
    const [cmd, ...args] = surface.exec;
    log.log(`exec ${surface.exec.join(' ')}`);
    const child = spawn(cmd, args, { stdio: 'inherit', env: resolved, cwd: manifest.paths.workDir });
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
    return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
  }

  const server = createServer({ manifest, surface, agentName: env.AGENT_NAME ?? manifest.name, log });
  await listen(server, manifest.serve.port, log);

  // In service mode the Argo step retries forever, so a clean shutdown is only
  // about not dropping a live terminal mid-keystroke on a config change.
  const shutdown = async (signal) => {
    log.log(`${signal} received; shutting down`);
    await surface.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown(signal));

  return new Promise(() => {}); // service mode: run until signalled
}

async function cmdDoctor({ env, log }) {
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok, detail });

  // The operator pins the agent container to uid 1000 with no override
  // (buildContainerSecurityContext is applied unconditionally). An image that
  // creates a user at a different uid gets a process with no passwd entry,
  // which makes git, tmux, ssh and gh each misbehave in their own small way.
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  check('runs as uid 1000', uid === 1000, `uid=${uid}`);
  let passwdOk = false;
  try {
    passwdOk = readFileSync('/etc/passwd', 'utf8').split('\n').some((l) => l.split(':')[2] === String(uid));
  } catch { /* unreadable passwd is itself the failure */ }
  check('uid has an /etc/passwd entry', passwdOk, passwdOk ? '' : `no entry for uid ${uid}`);

  let manifest = null;
  try {
    ({ manifest } = loadManifest({ path: env.CODING_RUNTIME_MANIFEST ?? MANIFEST_PATH, env, version: version() }));
    check('runtime.json is valid', true, `${manifest.name} (surface: ${manifest.serve.surface})`);
  } catch (err) {
    check('runtime.json is valid', false, err.message);
  }

  if (manifest) {
    try {
      const emit = await loadEmitter(manifest.config?.emitter);
      check('emitter resolves', true, emit ? manifest.config.emitter.path : 'none declared');
    } catch (err) {
      check('emitter resolves', false, err.message);
    }
    if (manifest.serve.surface === 'terminal') {
      try {
        await import('node-pty');
        check('node-pty loads', true);
      } catch (err) {
        check('node-pty loads', false, err.message);
      }
    }
  }

  // The read-only rootfs is the constraint every adapter has tripped over.
  // Assert the shape directly rather than trusting it.
  for (const path of ['/opt/coding-runtime', '/etc', '/']) {
    if (existsSync(path)) check(`${path} is read-only`, !isWritable(path));
  }
  check('/tmp is writable', isWritable('/tmp'));

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) {
    log.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  log.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  return failed.length === 0 ? 0 : 1;
}

const COMMANDS = { env: cmdEnv, seed: cmdSeed, serve: cmdServe, doctor: cmdDoctor };

export async function main(argv = process.argv.slice(2), ctx = {}) {
  const { env = process.env, log = console, stdout = process.stdout } = ctx;
  const [command] = argv;

  if (command === 'version' || command === '--version') {
    stdout.write(`${version()}\n`);
    return 0;
  }
  const run = COMMANDS[command];
  if (!run) {
    log.error(`usage: coding-runtime <${Object.keys(COMMANDS).join('|')}|version>`);
    log.error(`\nmanifest: ${MANIFEST_PATH}`);
    return 2;
  }

  try {
    return await run({ env, log, stdout });
  } catch (err) {
    log.error(`coding-runtime ${command}: ${err.message}`);
    return 1;
  }
}

/**
 * Was this file run directly?
 *
 * argv[1] has to be resolved first. Node reports import.meta.url as the real
 * path of the module, but argv[1] is whatever the caller typed — and this CLI
 * is reached through /usr/local/bin/coding-runtime. Comparing the two without
 * resolving makes the guard false for every real invocation, so main() never
 * runs and every command becomes a silent no-op that still exits 0.
 */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then((code) => { if (code !== 0) process.exitCode = code; });
}

/**
 * The adapter's self-description: /etc/coding-runtime/runtime.json.
 *
 * This is the only harness-aware thing in the base image. Everything the base
 * needs to know about claude-code, opencode, openclaw or deepagents — what to
 * launch, where its config goes, how it should be served — arrives here as
 * data, so adding a fifth harness never means editing the base.
 */

import { readFileSync, existsSync } from 'node:fs';

export const MANIFEST_PATH = '/etc/coding-runtime/runtime.json';
export const SUPPORTED_SCHEMA_VERSIONS = [1];
export const SURFACES = ['terminal', 'none'];
export const ROLES = ['main', 'init'];
export const DEFAULT_PORT = 8080;

// ---------------------------------------------------------------------------
// Minimal semver range support
//
// Enough for the `>=1.0.0 <2.0.0` compatibility ranges manifests declare, and
// not a reason to put a dependency into the base image's runtime closure.
// ---------------------------------------------------------------------------

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** True when `version` satisfies every space-separated comparator in `range`. */
export function satisfiesRange(version, range) {
  const actual = parseVersion(version);
  if (!actual) return false;

  for (const clause of String(range).trim().split(/\s+/).filter(Boolean)) {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(clause);
    if (!m) return false;
    const want = parseVersion(m[2]);
    if (!want) return false;
    const cmp = compareVersions(actual, want);
    const ok = { '>=': cmp >= 0, '<=': cmp <= 0, '>': cmp > 0, '<': cmp < 0, '=': cmp === 0, undefined: cmp === 0 }[m[1]];
    if (!ok) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Template interpolation
// ---------------------------------------------------------------------------

/** Replace `${NAME}` with `vars.NAME`, leaving unknown names untouched and visible. */
export function interpolate(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (whole, name) => (name in vars && vars[name] != null ? String(vars[name]) : whole));
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars));
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, vars)]));
  }
  return value;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isMapping = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** @returns {string[]} fatal problems; an empty array means the manifest is usable. */
export function validateManifest(raw) {
  const errors = [];
  if (!isMapping(raw)) return ['runtime.json must contain a JSON object'];

  if (!SUPPORTED_SCHEMA_VERSIONS.includes(raw.schemaVersion)) {
    // Refusing an unknown version is the point of having one: a newer adapter
    // on an older base should say so rather than half-work.
    errors.push(
      `unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)}; this base understands ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
    );
  }
  if (typeof raw.name !== 'string' || raw.name.trim() === '') {
    errors.push('name is required and must be a non-empty string');
  }
  if (raw.role !== undefined && !ROLES.includes(raw.role)) {
    errors.push(`role must be one of ${ROLES.join(', ')}`);
  }

  const serve = raw.serve;
  if (serve !== undefined) {
    if (!isMapping(serve)) {
      errors.push('serve must be an object');
    } else {
      if (serve.surface !== undefined && !SURFACES.includes(serve.surface)) {
        errors.push(`serve.surface must be one of ${SURFACES.join(', ')}`);
      }
      if (serve.port !== undefined && !Number.isInteger(serve.port)) {
        errors.push('serve.port must be an integer');
      }
      if (serve.surface === 'none' && serve.exec !== undefined && !Array.isArray(serve.exec)) {
        errors.push('serve.exec must be an array of strings');
      }
    }
  }

  if (raw.serve?.surface === 'terminal') {
    const terminal = raw.terminal;
    if (!isMapping(terminal)) {
      errors.push('surface "terminal" requires a terminal block');
    } else if (!Array.isArray(terminal.launch) || terminal.launch.length === 0) {
      errors.push('terminal.launch must be a non-empty array — the base has no default command to run');
    }
  }

  const emitter = raw.config?.emitter;
  if (emitter !== undefined) {
    if (!isMapping(emitter)) errors.push('config.emitter must be an object');
    else if (!['module', 'none'].includes(emitter.type)) errors.push('config.emitter.type must be "module" or "none"');
    else if (emitter.type === 'module' && typeof emitter.path !== 'string') {
      errors.push('config.emitter.path is required when type is "module"');
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Resolve the manifest into fully concrete values.
 *
 * Interpolation runs in two passes because the path block defines variables the
 * rest of the manifest uses: `${STATE_DIR}` in an env value can only resolve
 * once `paths.stateDir` itself has resolved against `${WORKSPACE}`.
 */
export function resolveManifest(raw, { env = {}, version = null } = {}) {
  const warnings = [];

  const workspace = env.WORKSPACE_DIR?.trim() || '/workspace';
  const repoDir = env.AGENT_REPO_DIR?.trim() || null;
  const baseVars = {
    ...env,
    WORKSPACE: workspace,
    REPO_DIR: repoDir ?? '',
    WORKDIR: repoDir ?? workspace,
  };

  const defaultPaths = {
    home: '${WORKSPACE}/.home',
    stateDir: '${WORKSPACE}/.coding-runtime',
    tmpDir: '${WORKSPACE}/.tmp',
    cacheHome: '${WORKSPACE}/.cache',
    dataHome: '${WORKSPACE}/.local/share',
    configHome: '${WORKSPACE}/.config',
    // Overridable so the suite can point at a fixture instead of the real mount.
    agentConfigPath: '/etc/agent/config.yaml',
  };
  const paths = interpolate({ ...defaultPaths, ...(isMapping(raw.paths) ? raw.paths : {}) }, baseVars);

  const port = Number(env.PORT) || raw.serve?.port || DEFAULT_PORT;
  const vars = {
    ...baseVars,
    HOME: paths.home,
    STATE_DIR: paths.stateDir,
    TMPDIR: paths.tmpDir,
    PORT: String(port),
  };

  const resolved = interpolate({ ...raw, paths }, vars);

  if (raw.requires?.codingRuntime && version && !satisfiesRange(version, raw.requires.codingRuntime)) {
    // A warning, never a failure: refusing to start a running agent over a
    // version string trades a working pod for a tidy one.
    warnings.push({
      code: 'BASE_VERSION_MISMATCH',
      path: 'requires.codingRuntime',
      message: `adapter '${raw.name}' wants coding-runtime ${raw.requires.codingRuntime} but this base is ${version}`,
    });
  }

  return {
    manifest: {
      ...resolved,
      role: resolved.role ?? 'main',
      paths: { ...paths, workspace, repoDir, workDir: repoDir ?? workspace },
      serve: { surface: 'none', originGuard: true, exposeManifest: false, ...(resolved.serve ?? {}), port },
    },
    warnings,
  };
}

/** Read, validate and resolve the manifest. Throws when it is unusable. */
export function loadManifest({ path = MANIFEST_PATH, env = {}, version = null } = {}) {
  if (!existsSync(path)) {
    throw new Error(
      `no runtime manifest at ${path}. Every adapter image must ship one; see docs/authoring-an-adapter.md`,
    );
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`runtime manifest at ${path} is not valid JSON: ${err.message}`);
  }

  const errors = validateManifest(raw);
  if (errors.length > 0) {
    throw new Error(`runtime manifest at ${path} is invalid:\n  - ${errors.join('\n  - ')}`);
  }

  return resolveManifest(raw, { env, version });
}

/**
 * The manifest as served over HTTP.
 *
 * With `auth.enabled: false` this endpoint is public, and the full manifest
 * names internal paths and the exact command line the agent runs. Only the
 * fields a client could legitimately want are exposed.
 */
export function publicManifest(manifest) {
  if (manifest.serve?.exposeManifest) return manifest;
  return {
    schemaVersion: manifest.schemaVersion,
    name: manifest.name,
    displayName: manifest.displayName ?? manifest.name,
    role: manifest.role,
    serve: { surface: manifest.serve.surface, port: manifest.serve.port },
  };
}

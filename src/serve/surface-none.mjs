/**
 * No serving surface: the adapter owns its own port.
 *
 * Used by harnesses whose own process is the agent — deepagents serves FastAPI
 * on the agent port, openclaw's gateway is an upstream image — and by init-role
 * images that only seed config and exit. The base still runs the ETL and the
 * environment setup; it simply hands the port over.
 */

export function createNoneSurface({ manifest }) {
  return {
    name: 'none',
    wsPath: null,
    exec: manifest.serve?.exec ?? null,
    async ready() {
      return { ready: true };
    },
    attach() {
      return null;
    },
    async close() {},
  };
}

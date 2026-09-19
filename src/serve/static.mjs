/**
 * The xterm.js assets the terminal page loads.
 *
 * Served out of the base image's own node_modules rather than a CDN: agent pods
 * sit behind a NetworkPolicy that admits the ingress and little else, so a page
 * that reaches out to unpkg simply renders a blank screen.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));

const JS = 'application/javascript; charset=utf-8';

export function staticAssets() {
  const xterm = pkgDir('@xterm/xterm');
  const fit = pkgDir('@xterm/addon-fit');
  const clipboard = pkgDir('@xterm/addon-clipboard');

  return {
    'xterm.js': { file: join(xterm, 'lib/xterm.js'), type: JS },
    'xterm.css': { file: join(xterm, 'css/xterm.css'), type: 'text/css; charset=utf-8' },
    'addon-fit.js': { file: join(fit, 'lib/addon-fit.js'), type: JS },
    'addon-clipboard.js': { file: join(clipboard, 'lib/addon-clipboard.js'), type: JS },
  };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkOrigin, parseAllowedOrigins } from '../src/serve/origin.mjs';

const allowed = (args) => checkOrigin(args).allowed;

test('a same-origin browser request is accepted', () => {
  assert.ok(allowed({ origin: 'https://agent.example.com', host: 'agent.example.com' }));
  assert.ok(allowed({ origin: 'http://127.0.0.1:8099', host: '127.0.0.1:8099' }));
});

test('a cross-origin request is rejected — this is the whole attack', () => {
  assert.ok(!allowed({ origin: 'https://evil.example', host: 'agent.example.com' }));
  assert.ok(!allowed({ origin: 'http://127.0.0.1:9999', host: '127.0.0.1:8099' }), 'a different port is a different origin');
});

test('a request with no Origin is allowed through as a non-browser client', () => {
  // curl, kubelet probes and in-cluster clients never send Origin, and they are
  // not the threat this guards against.
  assert.ok(allowed({ host: 'agent.example.com' }));
  assert.ok(allowed({ origin: '', host: 'agent.example.com' }));
});

test('an unparseable Origin is rejected', () => {
  assert.ok(!allowed({ origin: 'not a url', host: 'agent.example.com' }));
  assert.ok(!allowed({ origin: '://', host: 'agent.example.com' }));
});

test('host comparison is case-insensitive', () => {
  assert.ok(allowed({ origin: 'https://Agent.Example.COM', host: 'agent.example.com' }));
  assert.ok(allowed({ origin: 'https://agent.example.com', host: 'AGENT.EXAMPLE.COM' }));
});

test('a port implied by the scheme does not cause a spurious mismatch', () => {
  // Some proxies pass Host with the default port spelled out; the origin never
  // carries it. Treating those as different origins breaks the terminal for no
  // security benefit.
  assert.ok(allowed({ origin: 'https://agent.example.com', host: 'agent.example.com:443' }));
  assert.ok(allowed({ origin: 'http://agent.example.com', host: 'agent.example.com:80' }));
  assert.ok(!allowed({ origin: 'https://agent.example.com', host: 'agent.example.com:8443' }), 'a non-default port still matters');
});

test('an explicit allowlist replaces the host comparison', () => {
  const allowedOrigins = ['https://console.example.com'];
  assert.ok(allowed({ origin: 'https://console.example.com', host: 'agent.example.com', allowedOrigins }));
  assert.ok(
    !allowed({ origin: 'https://agent.example.com', host: 'agent.example.com', allowedOrigins }),
    'once set, ALLOWED_ORIGINS is the whole policy — same-origin is no longer implicitly trusted',
  );
});

test('rejections explain themselves, because a Host-rewriting proxy looks like a dead terminal', () => {
  const { reason } = checkOrigin({ origin: 'https://evil.example', host: 'agent.example.com' });
  assert.match(reason, /does not match request host/);
});

test('ALLOWED_ORIGINS parsing tolerates spacing and empties', () => {
  assert.deepEqual(parseAllowedOrigins(' https://a.example , ,https://b.example '), ['https://a.example', 'https://b.example']);
  assert.deepEqual(parseAllowedOrigins(undefined), []);
});

# Examples

These are not illustrations. Each directory holds the **real** `runtime.json` and
`emit.mjs` that the corresponding adapter ships:

| here | adapter |
|---|---|
| `claude-code/` | [`claude-code-adapter`](https://github.com/language-operator/claude-code-adapter) |
| `opencode/` | [`opencode-adapter`](https://github.com/language-operator/opencode-adapter) |
| `pi/` | [`pi-adapter`](https://github.com/language-operator/pi-adapter) |

They are kept byte-identical to each adapter's `main`, and
`.github/workflows/example-drift.yaml` fails when they are not.

Three things in this repository read them, which is why they are worth keeping here
rather than only in the adapters:

- `docs/authoring-an-adapter.md` and `README.md` point at them as the reference for
  writing an adapter — real working files rather than a sketch.
- `test/fixture-adapter/` builds an image from `claude-code/`, so adapter-mode
  conformance exercises the documented path rather than a contrived fixture.
- `test/fixtures/golden/emitted/` is generated from all of them, so a change to the
  normalizer shows up as a diff in what each harness would actually be configured
  with.

Changing an emitter therefore means changing it in two places, here and in its adapter. The drift check is
what stops one of them being forgotten.

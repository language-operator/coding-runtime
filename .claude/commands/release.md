---
description: Cut a release — bump the version, tag, and push to trigger the image publish
argument-hint: major|minor|patch
allowed-tools: Bash(git:*), Bash(npm:*), Bash(node:*), Bash(gh:*), Read, Edit
---

Cut a new release of `coding-runtime`. The bump type is: **$ARGUMENTS**

## Background (how releases work here)

A release is triggered by pushing a `vX.Y.Z` git tag. `.github/workflows/build-image.yaml`
fires on `tags: ['v*']` and builds both variants from the one Dockerfile:

| target | tags pushed to `ghcr.io/language-operator/coding-runtime` |
|---|---|
| `thick` | `X.Y.Z`, `X.Y`, `X`, `sha-<commit>`, and `latest` on the default branch |
| `thin` | the same set with a `-python` suffix |

`docker/metadata-action` strips the leading `v`, so the git tag `v1.2.3` produces
the image tag `1.2.3`.

Unlike the adapter repos, there is **no Helm chart here** — nothing to package and
no `appVersion` to keep in step. The only version of record is `version` in
`package.json`, which matters in two places:

- It is baked into the image as `/opt/coding-runtime/VERSION` via the `VERSION`
  build arg, and is what `coding-runtime version` reports and what
  `requires.codingRuntime` in an adapter manifest is checked against.
- `make build` derives its tag from it.

## Steps

Perform these in order. If any precondition fails, stop and report it — do not continue.

**0. Validate the argument.** `$ARGUMENTS` must be exactly one of `major`, `minor`
or `patch`. If it is missing or anything else, print usage
(`/release major|minor|patch`) and stop.

**1. Preconditions.**
- Current branch is `main` (`git rev-parse --abbrev-ref HEAD`). If not, stop.
- Working tree is clean (`git status --porcelain` is empty). The release commit
  must contain only the version bump.
- `git fetch origin`, then confirm `main` is not behind `origin/main`.
- CI is green on the commit being released: `gh run list --branch main --limit 5`.
  Releasing a red commit publishes a broken base image to every adapter that
  later pins it. If CI is failing, stop and say so.

**2. Determine the baseline.** The highest semver among: the latest tag
(`git describe --tags --match 'v*' --abbrev=0`, which may be empty), and
`version` in `package.json`.

**3. Compute the next version** — `patch` → `X.Y.(Z+1)`, `minor` → `X.(Y+1).0`,
`major` → `(X+1).0.0`. Print `Releasing vX.Y.Z (was <baseline>)`.

**4. Check the compatibility ranges.** Each `examples/*/runtime.json` declares a
`requires.codingRuntime` range. On a **major** bump those ranges will stop
matching the new base, so update them in the same commit and mention it in the
release notes — every adapter in the wild will need the same edit. On a minor or
patch bump, confirm the ranges still admit the new version and leave them alone.

**5. Bump the version.** `npm version <type> --no-git-tag-version`, which updates
`package.json` and `package-lock.json` together. Do not let npm create the commit
or tag; this command owns both.

**6. Verify.** Run `npm test`. Confirm `node -p "require('./package.json').version"`
matches the computed version.

**7. Commit and tag.**
- `git commit -am "chore(release): vX.Y.Z"` — check the diff touches only
  `package.json`, `package-lock.json`, and any `runtime.json` ranges from step 4.
- `git tag -a vX.Y.Z -m "Release vX.Y.Z"`.

**8. Confirm, then push.** Show the new version, `git show --stat HEAD`, the tag,
and state plainly that pushing publishes images to `ghcr.io`. Ask the user to
confirm explicitly.
- On **yes**: `git push --follow-tags origin main`.
- On **no**: leave the commit and tag local. Tell them how to undo
  (`git tag -d vX.Y.Z && git reset --soft HEAD~1`) or push later.

**9. Report.** After pushing:
- Watch the run (`gh run watch`) and report whether the publish succeeded.
- Print the resulting image references, both variants.
- Resolve and print the **digests**, since adapters pin the base by tag *and*
  digest:

  ```bash
  docker buildx imagetools inspect ghcr.io/language-operator/coding-runtime:X.Y.Z --format '{{.Manifest.Digest}}'
  docker buildx imagetools inspect ghcr.io/language-operator/coding-runtime:X.Y.Z-python --format '{{.Manifest.Digest}}'
  ```

- Remind the user that nothing updates the adapters automatically yet: each one
  needs its `ARG BASE=…@sha256:…` bumped by hand until the fan-out workflow
  exists. List which adapters currently build on this base.

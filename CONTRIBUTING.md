# Contributing to POI Toolkit

Thank you for contributing. Please keep changes focused, reproducible, and
consistent with the file-first pipeline.

## Development setup

POI Toolkit requires Node.js 22 (see `package.json`) and pnpm 9.15.4.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

The lockfile is part of the dependency contract. Commit `pnpm-lock.yaml` with
any intentional dependency change; do not hand-edit it. Do not commit generated
`dist/`, `workspace/`, input data, credentials, or `.env` files.

## Submitting a change

1. Open an issue or discussion first for changes that alter public contracts,
   data semantics, or release/handoff behavior.
2. Make the smallest change that addresses the problem and include tests for
   changed behavior where practical.
3. Run build, typecheck, and tests from the repository root.
4. Open a pull request describing the problem, validation performed, and any
   data or compatibility effects. Keep commits and pull requests focused.

Changes to release artifacts, manifests, provenance, or importer compatibility
must preserve the producer boundary documented in
[`docs/nearventure-handoff.md`](docs/nearventure-handoff.md). The toolkit does
not operate the consumer importer or database.

## Reporting problems

Use GitHub issues for reproducible bugs and documentation improvements. For
security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening
a public issue.

## Code of conduct

By participating, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

# Releasing CodeModeKit

CodeModeKit publishes six packages independently from one tested workspace:

1. `@codemodekit/core`
2. `@codemodekit/mcp`
3. `@codemodekit/sandbox-quickjs`
4. `codemodekit`
5. `@codemodekit/skills`
6. `create-codemodekit`

## One-time npm setup

Configure an npm [trusted publisher](https://docs.npmjs.com/trusted-publishers/) for each package:

- Provider: GitHub Actions
- Organization or user: `stjbrown`
- Repository: `codemodekit`
- Workflow filename: `release.yml`
- Allowed action: `npm publish`

No long-lived npm write token is required. The workflow uses GitHub OIDC and npm generates provenance automatically for public packages from the public repository.

## Prepare a release

1. Bump every changed package version. Package versions may differ.
2. When a dependency package changes, update affected internal dependency ranges and bump its consumers as needed.
3. Update release notes or the changelog.
4. Run:

   ```sh
   pnpm install --frozen-lockfile
   pnpm run typecheck
   pnpm test
   pnpm run test:package
   pnpm run test:skills
   ```

5. Merge the release commit to `main` and wait for CI.
6. Publish a GitHub Release from that commit.

The `release.yml` workflow repeats all verification, packs each package, skips versions already present on npm, and publishes new versions in dependency order. It fails if the release contains no unpublished package version, which catches forgotten version bumps.

After a successful publish, `registry-canary.yml` runs the public `npm create codemodekit@latest` weather path, builds its Agent Plugin, and composes both generated Local Tools against deterministic local endpoints. It also asks the latest Vercel skills CLI to install both skills separately and together from the public `stjbrown/codemodekit` GitHub shorthand. The same canary runs weekly and can be dispatched manually. It verifies the registry and public repository experience rather than workspace tarballs.

`pnpm run test:skills` uses the pinned `skills@1.5.22` compatibility baseline against the local checkout. Set `CODEMODEKIT_SKILLS_SOURCE=stjbrown/codemodekit` to test GitHub discovery or `CODEMODEKIT_SKILLS_CLI_VERSION=latest` to probe the current CLI release.

Publishing is deliberately blocked outside GitHub Actions. To inspect package contents locally, use `pnpm pack --dry-run` in an individual package or run the full `pnpm run test:package` consumer smoke test.

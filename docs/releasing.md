# Releasing CodeModeKit

CodeModeKit publishes five packages independently from one tested workspace:

1. `@codemodekit/core`
2. `@codemodekit/mcp`
3. `@codemodekit/sandbox-quickjs`
4. `codemodekit`
5. `create-codemodekit`

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
   ```

5. Merge the release commit to `main` and wait for CI.
6. Publish a GitHub Release from that commit.

The `release.yml` workflow repeats all verification, packs each package, skips versions already present on npm, and publishes new versions in dependency order. It fails if the release contains no unpublished package version, which catches forgotten version bumps.

Publishing is deliberately blocked outside GitHub Actions. To inspect package contents locally, use `pnpm pack --dry-run` in an individual package or run the full `pnpm run test:package` consumer smoke test.

# Releasing Pi Switchyard

Pi Switchyard is distributed as the public npm package `pi-switchyard`. Publication is always a deliberate maintainer action; CI does not publish automatically.

## Prepare

1. Choose the version and update `package.json` and `CHANGELOG.md`.
2. Confirm the changelog date and release notes.
3. Run:

   ```bash
   pnpm install --frozen-lockfile
   pnpm check
   pnpm check:package-load
   pnpm audit --prod
   npm publish --dry-run
   ```

4. Verify the package file list contains no tests, repository metadata, credentials, local configuration, or session data.
5. Review the complete diff and scan the complete Git history for secrets.
6. Recheck that the package name is available or owned by the intended npm account:

   ```bash
   npm view pi-switchyard name version
   npm whoami
   ```

7. Confirm CI succeeds on the release commit.

## Publish

Perform these steps manually from the reviewed release commit:

1. Move `main` to the reviewed release commit and push it.
2. Enable GitHub private vulnerability reporting and branch protection for `main`.
3. Make the GitHub repository public, if it is still private.
4. Create and push an annotated `vX.Y.Z` tag on that commit.
5. Confirm npm two-factor authentication or a trusted publisher is configured.
6. From a clean checkout of the tag, publish to the public registry:

   ```bash
   npm publish --access public
   ```

   `prepublishOnly` reruns the test suite and package-load smoke test. Never publish using a token stored in the repository or `.npmrc`.

7. Create a GitHub release from the tag using the matching changelog entry.
8. From a clean environment, install the exact npm release:

   ```bash
   pi install npm:pi-switchyard@X.Y.Z
   ```

9. Run `/switchyard show`, configure disposable test tiers, and exercise one origin and one temp route.

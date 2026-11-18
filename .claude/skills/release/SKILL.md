---
name: release
description: Cut a Mongo Studio release (bump the version, build, check, test, test a real install, commit and tag). Use when asked to release, ship, publish or tag a new version of the plugin.
disable-model-invocation: true
---

# Release Mongo Studio

The Orca plugin directory lists the newest `vX.Y.Z` tag of the GitHub repository, and installs
clone that tag as is. Whatever is committed in `dist/` at the tag is what users run.

Argument: the new version, or `patch`/`minor`/`major`. If none is given, ask.

Read the "Never uninstall" rule in `CLAUDE.md` first. Nothing in this skill uninstalls a plugin.

## Steps

1. **Start clean, on an up-to-date `main`.** `git status` shows no changes, the branch is `main`
   and `git fetch && git status` says it matches `origin/main`. If not, stop and say why.

2. **Check `dist/` was already current.** Before touching anything:
   ```sh
   npm run build && git status --porcelain dist/
   ```
   Any output means a commit on `main` shipped source without its build (or this machine's
   esbuild differs). Show the diff and ask the user how to proceed; don't fold it silently into
   the release.

3. **Bump the version in both files**, to the same value: `"version"` in `orca-plugin.json` and
   `package.json`, then `npm install --package-lock-only` so `package-lock.json` follows.

4. **Check and test**, and stop at the first failure (`check` builds):
   ```sh
   npm run typecheck && npm run check && npm test
   ```
   Then `git diff orca-plugin.json` must show only the version (`npm test` rewrites `main` during
   the run and must have put back `dist/worker.mjs`).

5. **Commit locally:**
   ```sh
   git commit -am "Mongo Studio X.Y.Z: <headline for users>"
   ```

6. **Test the real install.** A dev folder hides failures an installed plugin hits (the frame's
   32-request limit). The test installs the release commit over the user's catalog copy,
   `leobessin.mongo-studio`, in place; it never uninstalls. Ask the user before each of these,
   since they push and replace their installed copy:
   - `git push origin HEAD:refs/heads/release/vX.Y.Z`
   - If the dev plugin is enabled (`orca plugin list`), `orca plugin disable local.mongo-studio`;
     its keybindings clash with the installed copy's.
   - `orca plugin install LeoBessin/orca-mongo-studio@release/vX.Y.Z`. Exit 3 means approval:
     show the user the fingerprint and let them approve. If Orca refuses because it's already
     installed, stop and ask; do not uninstall to get around it.
   - `orca plugin open leobessin.mongo-studio`, then
     `orca plugin shot leobessin.mongo-studio --width 420 --out .orca/shots/release.png --json`.
     Read the PNG; the JSON's `errors` must be empty and `settled` true. Check
     `orca plugin logs leobessin.mongo-studio` for errors.
   - Afterwards: `git push origin --delete release/vX.Y.Z`, and re-enable the dev plugin if you
     disabled it. The installed copy can stay; it's the release commit.

   The user may skip this step for a release that doesn't touch the panel, the editor, `src/shared/`
   modules the editor imports, or the build. Say that it was skipped.

7. **Tag:** `git tag -a vX.Y.Z -m vX.Y.Z`.

8. **Stop before pushing.** Show the commit, the tag and the `dist/` sizes, and ask the user to
   confirm `git push origin main vX.Y.Z`. Pushing the tag publishes the release to everyone.
   After the push, point them to https://orca.dev/plugins/leobessin/orca-mongo-studio for the
   listing's status.

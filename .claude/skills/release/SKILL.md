---
name: release
description: Cut a Mongo Studio release (bump the version, build, check, test, test a real install, commit and tag). Use when asked to release, ship, publish or tag a new version of the plugin.
disable-model-invocation: true
---

# Release Mongo Studio

The Orca plugin directory lists the newest `vX.Y.Z` tag of the GitHub repository, and installs
clone that tag as is. Whatever is committed in `dist/` at the tag is what users run.

Argument: the new version, or `patch`/`minor`/`major`. If none is given, ask.

## Steps

1. **Start clean, on `main`.** `git status` must show no unrelated changes, and the branch must be
   `main` and up to date with `origin/main`. If not, stop and say why.

2. **Bump the version in both files**, to the same value:
   - `orca-plugin.json` → `"version"`
   - `package.json` → `"version"` (and run `npm install --package-lock-only` so
     `package-lock.json` follows)

3. **Build, check, test**, and stop at the first failure:
   ```sh
   npm run build && npm run typecheck && npm run check && npm test
   ```
   Then confirm `git status` shows no change under `dist/` other than what the build just made,
   and `git diff orca-plugin.json` shows only the version (`main` must still be
   `dist/worker.mjs`; `npm test` rewrites it during the run).

4. **Test a real install.** Dev folders hide failures installed plugins hit (the frame's
   32-request limit). Ask the user which way:
   - **GitHub install (safe):** push the release commit to a branch first (ask before pushing),
     unload the dev folder (`orca plugin dev unload .`; their keybindings clash), then
     `orca plugin install LeoBessin/orca-mongo-studio@<branch>`, `orca plugin open
     leobessin.mongo-studio`, `orca plugin shot leobessin.mongo-studio`, read the PNG and
     `orca plugin logs leobessin.mongo-studio`. Uninstall it and `orca plugin dev load .` again
     afterwards.
   - **Folder install:** it uses the dev folder's storage key `local.mongo-studio`, and
     uninstalling it **wipes the dev connections**. First export them:
     `orca plugin dev request . connections.export --data '{"tasks":true}' --json > .orca/connections-backup.json`
     and confirm the file has the connections. Never run `orca plugin uninstall local.mongo-studio`
     without that backup.
   - The user may skip this step for a release that doesn't touch the panel, editor or bundling;
     say that it was skipped.

5. **Commit and tag**, with a message headline for users:
   ```sh
   git commit -am "Mongo Studio X.Y.Z: <headline>"
   git tag -a vX.Y.Z -m vX.Y.Z
   ```

6. **Stop before pushing.** Show the commit, the tag and the `dist/` size, and ask the user to
   confirm `git push origin main vX.Y.Z`. Pushing the tag publishes the release to everyone.
   After the push, point them to https://orca.dev/plugins/leobessin/orca-mongo-studio for the
   listing's status.

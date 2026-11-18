---
name: test
description: Run Mongo Studio's tests at the right level - typecheck, unit/panel tests, integration tests against the Docker databases, or the Kerberos/LDAP enterprise tests - and start the databases each level needs. Use after a change, before committing, or when asked to test.
---

# Test Mongo Studio

Pick the lowest level that covers the change, then go up only when it touches what the next
level tests.

| Level | Command | Covers | Needs |
|---|---|---|---|
| Types | `npm run typecheck` | Panel and worker separately | Nothing |
| Unit | `npm test` | `src/**/*.test.ts(x)`: shared, worker units, `src/worker.test.ts` (protocol over a mock host), `src/panel.test.tsx` and `src/panel-*.test.tsx` | Nothing |
| Render | `npm run check` | Builds, renders the panel scenarios, validates the manifest | Nothing |
| Integration | `npm run test:it` | `test/*.test.ts` against real servers | Dev replica set (seeded) **and** the `test` profile with its certificates |
| Enterprise | `npm run test:enterprise` | `test/enterprise.test.ts`: Kerberos and LDAP | The `enterprise` profile |

Always run **Types + Unit** after a change. Add **Render** when the panel, the manifest or the
build changed. Add **Integration** when worker code that talks to the server changed (queries,
writes, aggregation, import/export, admin, shell, SSH, TLS, auth). Run **Enterprise** only when
Kerberos or LDAP code changed, and say it's slow.

`orca plugin test` has no filter: each command runs its whole suite. After any test run,
`git diff orca-plugin.json` must be empty; if a run was killed, put
`"main": "dist/worker.mjs"` back (`npm test` rewrites it during the run).

## Databases

The commands for each set (dev replica set and seed, the `test` profile with
`dev/test-env/make-certs.sh` and `setup.sh`, the `enterprise` profile) are in the header of
`dev/docker-compose.yml`. Before starting any of them:

1. See what's already running: `docker compose -f dev/docker-compose.yml ps`.
2. Check the ports the level needs aren't held by something else:
   `docker ps --format '{{.Names}} {{.Ports}}'` and look for 27017 (dev), 27018, 27019, 2222
   (test), 27020 (enterprise). If a container that isn't `mongo-studio-*` holds one (e.g.
   `waplanner-mongo-dev` on 27017), **stop and ask the user**. Don't run the integration tests:
   they would create and drop scratch databases in that other project's MongoDB.
3. Start what's missing. `make-certs.sh` only needs running once (it writes
   `dev/test-env/out/`, gitignored).

Integration tests write only to scratch databases and expect the seed data from
`dev/seed.mongodb.js`; reseed if a test reports unexpected counts. Leave the containers running
when done unless the user asks to stop them.

## Reporting

Report each level run with pass/fail counts, the failing test names and their first error lines.
Say which levels were skipped and why.

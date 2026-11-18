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
| Unit | `npm test` | `src/shared/*.test.ts`, `src/worker/*.test.ts`, panel tests `src/panel-*.test.tsx`, protocol | Nothing |
| Render | `npm run check` | Builds, renders the panel scenarios, validates the manifest | Nothing |
| Integration | `npm run test:it` | `test/*.test.ts` against real servers | Test databases |
| Enterprise | `npm run test:enterprise` | `test/enterprise.test.ts`: Kerberos and LDAP | Enterprise profile |

Always run **Types + Unit** after a change. Add **Render** when the panel, the manifest or the
build changed. Add **Integration** when worker code that talks to the server changed (queries,
writes, aggregation, import/export, admin, shell, SSH, TLS, auth). Run **Enterprise** only when
Kerberos or LDAP code changed, and say it's slow.

`npm test` points `orca-plugin.json`'s `main` at `src/worker.ts` for the run and restores it.
After any test run, `git diff orca-plugin.json` must be empty; if a run was killed, put
`"main": "dist/worker.mjs"` back.

Filter tests with the arguments `orca plugin test` takes, e.g.
`node dev/with-source-main.mjs plugin test . --help` to see them.

## Databases

Check what's up first: `docker compose -f dev/docker-compose.yml ps`.

```sh
# Replica set with demo data, for test:it
docker compose -f dev/docker-compose.yml up -d --wait
docker compose -f dev/docker-compose.yml exec mongo mongosh --quiet /seed/seed.mongodb.js

# SCRAM (27019), TLS + X.509 (27018), SSH bastion (2222), also for test:it
dev/test-env/make-certs.sh                       # once; writes dev/test-env/out/ (gitignored)
docker compose -f dev/docker-compose.yml --profile test up -d --wait --build
dev/test-env/setup.sh

# MongoDB Enterprise (27020), MIT KDC, OpenLDAP, for test:enterprise
docker compose -f dev/docker-compose.yml --profile enterprise up -d --wait --build
dev/test-env/setup-enterprise.sh
```

Integration tests write only to scratch databases; they expect the seed data as loaded by
`dev/seed.mongodb.js`, so reseed if a test reports unexpected counts. Leave the containers
running when done unless the user asks to stop them.

## Reporting

Report each level run with pass/fail counts, the failing test names and their first error lines.
Say which levels were skipped and why.

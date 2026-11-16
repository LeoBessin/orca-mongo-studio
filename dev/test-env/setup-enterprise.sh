#!/usr/bin/env bash
# After `--profile enterprise up`: an admin, the Kerberos user and the LDAP user in $external
# (created through the localhost exception), and a Kerberos ticket for the tests on this machine.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out
docker exec mongo-studio-enterprise mongosh --quiet --eval '
const admin = db.getSiblingDB("admin")
try { admin.createUser({ user: "root", pwd: "root-dev-only", roles: ["root"] }) } catch (e) { print(`root: ${e.message}`) }' || true
docker exec mongo-studio-enterprise mongosh --quiet -u root -p root-dev-only --eval '
const ext = db.getSiblingDB("$external")
for (const user of ["alice@STUDIO.TEST", "bob"]) {
  if (!ext.getUser(user)) ext.createUser({ user, roles: [{ role: "readAnyDatabase", db: "admin" }] })
}
db.getSiblingDB("enterprise_demo").things.insertOne({ hello: "kerberos and ldap" })
print("enterprise users ready")'
export KRB5_CONFIG="$PWD/krb5-client.conf" KRB5CCNAME="FILE:$PWD/out/krb5cc"
echo alice-krb-dev | kinit alice@STUDIO.TEST >/dev/null
klist | head -3

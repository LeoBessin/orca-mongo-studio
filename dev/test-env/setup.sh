#!/usr/bin/env bash
# One-time setup after `--profile test up`: the X.509 user on mongo-tls (localhost exception).
set -euo pipefail
docker exec mongo-studio-tls mongosh --quiet --tls --tlsCAFile /certs/ca.pem --tlsCertificateKeyFile /certs/client.pem --host localhost --eval '
const ext = db.getSiblingDB("$external")
const user = "CN=studio-client,OU=clients,O=MongoStudioClients"
// The localhost exception allows only createUser (no lookups); a second run reports it exists.
const res = ext.runCommand({ createUser: user, roles: [{ role: "readAnyDatabase", db: "admin" }] })
print(res.ok ? "x509 user created" : `x509 user: ${res.errmsg}`)'

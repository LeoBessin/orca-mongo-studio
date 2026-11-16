#!/usr/bin/env bash
# Throwaway CA, server and X.509 client certificates plus SSH keys for the integration tests.
# Writes dev/test-env/out (git-ignored). Safe to re-run; it overwrites everything.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out && cd out
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 365 -subj "/CN=Mongo Studio Test CA" 2>/dev/null
# Server: valid for the names tests use to reach it, directly and through the SSH tunnel.
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=localhost/O=MongoStudioDev" 2>/dev/null
printf "subjectAltName=DNS:localhost,DNS:mongo-tls,IP:127.0.0.1\n" > server.ext
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out server.crt -days 365 -extfile server.ext 2>/dev/null
cat server.crt server.key > server.pem
# X.509 client: its subject is the MongoDB user name in $external. Its O must differ from the
# server's, or MongoDB treats it as a cluster member and refuses it as a user.
openssl req -newkey rsa:2048 -nodes -keyout client.key -out client.csr -subj "/O=MongoStudioClients/OU=clients/CN=studio-client" 2>/dev/null
printf "extendedKeyUsage=clientAuth\n" > client.ext
openssl x509 -req -in client.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out client.crt -days 365 -extfile client.ext 2>/dev/null
cat client.crt client.key > client.pem
# Same client key, encrypted, to test the key password.
openssl pkcs8 -topk8 -in client.key -out client-enc.key -passout pass:key-pass-dev 2>/dev/null
cat client.crt client-enc.key > client-encrypted.pem
# SSH keys: plain and with a passphrase.
rm -f id_ed25519 id_ed25519.pub id_ed25519_pass id_ed25519_pass.pub
ssh-keygen -q -t ed25519 -N "" -C studio-test -f id_ed25519
ssh-keygen -q -t ed25519 -N "ssh-pass-dev" -C studio-test-pass -f id_ed25519_pass
cat id_ed25519.pub id_ed25519_pass.pub > authorized_keys
chmod 644 ./*.pem ./*.key ./*.pub authorized_keys
echo "Wrote $(pwd)"

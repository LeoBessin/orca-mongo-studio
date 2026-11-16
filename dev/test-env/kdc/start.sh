#!/bin/sh
set -e
if [ ! -f /var/lib/krb5kdc/principal ]; then
  kdb5_util create -s -r STUDIO.TEST -P kdc-master-dev
  kadmin.local -q "addprinc -pw alice-krb-dev alice@STUDIO.TEST"
  kadmin.local -q "addprinc -randkey mongodb/localhost@STUDIO.TEST"
fi
rm -f /keytabs/mongodb.keytab
kadmin.local -q "ktadd -k /keytabs/mongodb.keytab mongodb/localhost@STUDIO.TEST"
chmod 644 /keytabs/mongodb.keytab
exec krb5kdc -n

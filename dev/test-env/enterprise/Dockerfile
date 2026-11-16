# MongoDB Enterprise ships without Cyrus SASL's GSSAPI module, which Kerberos sign-in needs.
FROM mongodb/mongodb-enterprise-server:8.0-ubuntu2204
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libsasl2-modules-gssapi-mit && rm -rf /var/lib/apt/lists/*
USER mongodb

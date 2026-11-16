# MIT Kerberos KDC for the GSSAPI tests: realm STUDIO.TEST, user alice, and a keytab for
# mongodb/localhost that the Enterprise mongod reads from the shared /keytabs volume.
FROM alpine:3.20
RUN apk add --no-cache krb5-server krb5
COPY krb5.conf /etc/krb5.conf
COPY kdc.conf /var/lib/krb5kdc/kdc.conf
COPY start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 88
CMD ["/start.sh"]

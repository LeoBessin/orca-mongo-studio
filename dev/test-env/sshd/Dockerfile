# A minimal SSH bastion for tunnel tests: password and key login, TCP forwarding on.
FROM alpine:3.20
RUN apk add --no-cache openssh-server && ssh-keygen -A \
 && adduser -D -s /bin/sh studio && echo 'studio:studio-ssh-pw' | chpasswd \
 && mkdir -p /etc/ssh/keys /home/studio/.ssh && chown studio:studio /home/studio/.ssh && chmod 700 /home/studio/.ssh \
 && sed -i -E '/^#?(AllowTcpForwarding|PasswordAuthentication|PermitRootLogin|AuthorizedKeysFile)/d' /etc/ssh/sshd_config \
 && printf 'PasswordAuthentication yes\nAllowTcpForwarding yes\nPermitRootLogin no\nAuthorizedKeysFile /etc/ssh/keys/authorized_keys\n' >> /etc/ssh/sshd_config
EXPOSE 22
# authorized_keys is bind-mounted with its host owner, which sshd's StrictModes refuses unless it
# is root or studio (uid 1000): it passes on a laptop and fails on a CI runner (uid 1001). Copy it
# to a root-owned file first.
CMD ["/bin/sh", "-c", "install -o root -g root -m 644 /keys/authorized_keys /etc/ssh/keys/authorized_keys && exec /usr/sbin/sshd -D -e"]

#!/bin/sh
set -e
# Fixed host key per container image run unless /keys has one (lets tests pin or swap it).
if [ -f /keys/host_ed25519 ]; then
  cp /keys/host_ed25519 /etc/ssh/ssh_host_ed25519_key
  chmod 600 /etc/ssh/ssh_host_ed25519_key
else
  ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key
fi
# Authorized client keys (all *.pub in /keys).
: > /home/tunnel/.ssh/authorized_keys
for k in /keys/*.pub; do [ -f "$k" ] && cat "$k" >> /home/tunnel/.ssh/authorized_keys; done
chown tunnel:tunnel /home/tunnel/.ssh/authorized_keys
chmod 600 /home/tunnel/.ssh/authorized_keys
exec /usr/sbin/sshd -D -e

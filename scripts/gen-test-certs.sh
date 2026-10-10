#!/bin/sh
# Generates throwaway TLS certificates and SSH keys for the integration tests.
# Output is gitignored: docker/postgres-tls/certs, docker/bastion/keys.
set -e
cd "$(dirname "$0")/.."

certs=docker/postgres-tls/certs
keys=docker/bastion/keys
mkdir -p "$certs" "$keys"

if [ ! -f "$certs/ca.crt" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=Clew Test CA" \
    -keyout "$certs/ca.key" -out "$certs/ca.crt" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" \
    -keyout "$certs/server.key" -out "$certs/server.csr" 2>/dev/null
  printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' > "$certs/san.cnf"
  openssl x509 -req -in "$certs/server.csr" -CA "$certs/ca.crt" -CAkey "$certs/ca.key" \
    -CAcreateserial -days 30 -extfile "$certs/san.cnf" -out "$certs/server.crt" 2>/dev/null
  # A second server cert whose name does NOT match localhost (for verify-full failures).
  openssl req -newkey rsa:2048 -nodes -subj "/CN=wrong.example.test" \
    -keyout "$certs/wrong.key" -out "$certs/wrong.csr" 2>/dev/null
  printf 'subjectAltName=DNS:wrong.example.test\n' > "$certs/wrong-san.cnf"
  openssl x509 -req -in "$certs/wrong.csr" -CA "$certs/ca.crt" -CAkey "$certs/ca.key" \
    -CAcreateserial -days 30 -extfile "$certs/wrong-san.cnf" -out "$certs/wrong.crt" 2>/dev/null
  # Client certificate for mutual TLS tests.
  openssl req -newkey rsa:2048 -nodes -subj "/CN=clew" \
    -keyout "$certs/client.key" -out "$certs/client.csr" 2>/dev/null
  openssl x509 -req -in "$certs/client.csr" -CA "$certs/ca.crt" -CAkey "$certs/ca.key" \
    -CAcreateserial -days 30 -out "$certs/client.crt" 2>/dev/null
fi

[ -f "$keys/client_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C clew-test -f "$keys/client_ed25519"
[ -f "$keys/client_pass_ed25519" ] || ssh-keygen -q -t ed25519 -N 'testpass' -C clew-test-pass -f "$keys/client_pass_ed25519"
[ -f "$keys/host_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C clew-test-host -f "$keys/host_ed25519"
echo "test certificates and keys ready"

FROM postgres:16
# CERT selects which server certificate this image serves (server = valid for localhost,
# wrong = valid only for wrong.example.test, used to prove verify-full rejects a mismatch).
ARG CERT=server
COPY certs/${CERT}.crt /var/lib/postgresql/server.crt
COPY certs/${CERT}.key /var/lib/postgresql/server.key
RUN chown postgres:postgres /var/lib/postgresql/server.* && chmod 600 /var/lib/postgresql/server.key
CMD ["postgres", "-c", "ssl=on", "-c", "ssl_cert_file=/var/lib/postgresql/server.crt", "-c", "ssl_key_file=/var/lib/postgresql/server.key"]

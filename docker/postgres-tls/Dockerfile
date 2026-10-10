FROM postgres:16
COPY certs/server.crt /var/lib/postgresql/server.crt
COPY certs/server.key /var/lib/postgresql/server.key
RUN chown postgres:postgres /var/lib/postgresql/server.* && chmod 600 /var/lib/postgresql/server.key
CMD ["postgres", "-c", "ssl=on", "-c", "ssl_cert_file=/var/lib/postgresql/server.crt", "-c", "ssl_key_file=/var/lib/postgresql/server.key"]

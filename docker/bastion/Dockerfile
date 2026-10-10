FROM alpine:3.20
RUN apk add --no-cache openssh-server \
 && adduser -D -s /bin/sh tunnel \
 && echo 'tunnel:tunnelpw' | chpasswd \
 && mkdir -p /home/tunnel/.ssh \
 && chmod 700 /home/tunnel/.ssh \
 && chown -R tunnel:tunnel /home/tunnel/.ssh
COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]

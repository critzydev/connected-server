# Portable BRB supervisor image — the "never cut out" engine, self-contained.
# Bakes in ffmpeg + a font so it runs on any VPS with no host-font mount
# (the prod shared-box deploy historically mounted host DejaVu; this doesn't need to).
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      fonts-dejavu-core \
      curl \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Default font path inside this image (overridable via FONT env).
ENV FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf

COPY supervisor.sh /usr/local/bin/supervisor.sh
RUN chmod +x /usr/local/bin/supervisor.sh

ENTRYPOINT ["/usr/local/bin/supervisor.sh"]

# BELABOX srtla receiver — the bonding front door (Phase 2/3).
# Multiple network paths (streamer phone wifi+cellular, crew phones) carry ONE
# SRT stream as an SRTLA group; srtla_rec reassembles and feeds MediaMTX's SRT
# listener. Run: srtla_rec <SRTLA_PORT> 127.0.0.1 <MTX_SRT_PORT>
FROM debian:bookworm-slim AS build
RUN apt-get update -qq && apt-get install -y -qq git build-essential >/dev/null
RUN git clone --depth 1 https://github.com/BELABOX/srtla.git /src && cd /src && make
FROM debian:bookworm-slim
COPY --from=build /src/srtla_rec /src/srtla_send /usr/local/bin/
ENTRYPOINT ["srtla_rec"]
CMD ["8895", "127.0.0.1", "8890"]

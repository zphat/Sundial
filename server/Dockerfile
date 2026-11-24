# Build, with exactly the dependency versions in Cargo.lock
FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

# Run: a tiny image with just the binary; data lives in /data
FROM debian:bookworm-slim
# /data is made and handed to the server's user before VOLUME, so a new named volume starts out writable by it
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd -r -u 10001 sundial && mkdir /data && chown sundial: /data
COPY --from=build /src/target/release/sundial-sync /usr/local/bin/sundial-sync
VOLUME /data
ENV SUNDIAL_BIND=0.0.0.0:8768 SUNDIAL_DB=/data/sundial-sync.sqlite
EXPOSE 8768
USER sundial
ENTRYPOINT ["/usr/local/bin/sundial-sync"]

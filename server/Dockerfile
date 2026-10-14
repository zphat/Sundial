# Build
FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release

# Run: a tiny image with just the binary; data lives in /data
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* && useradd -r -u 10001 sundial
COPY --from=build /src/target/release/sundial-sync /usr/local/bin/sundial-sync
VOLUME /data
ENV SUNDIAL_BIND=0.0.0.0:8768 SUNDIAL_DB=/data/sundial-sync.sqlite
EXPOSE 8768
USER sundial
ENTRYPOINT ["/usr/local/bin/sundial-sync"]

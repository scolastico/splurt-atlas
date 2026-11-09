FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /opt/atlas
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN mkdir -p /output /opt/atlas/.cache
ENTRYPOINT ["node", "/opt/atlas/scripts/cli.mjs"]
CMD ["--help"]

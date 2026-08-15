FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends osmium-tool gdal-bin && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
ENTRYPOINT ["node", "--stack-size=65536", "packages/cli/dist/index.js"]

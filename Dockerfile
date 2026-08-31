# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
COPY ops ./ops
COPY scripts ./scripts

RUN npm run check \
    && rm -rf dist/tests \
    && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates pandoc \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    OUTPUT_DIR=/app/data/public/daily \
    HOST=0.0.0.0 \
    PORT=8787

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/rendering/assets ./src/rendering/assets

RUN mkdir -p /app/data \
    && chown node:node /app/data

USER node

VOLUME ["/app/data"]
EXPOSE 8787
STOPSIGNAL SIGTERM

ENTRYPOINT ["node", "dist/src/index.js"]
CMD ["serve"]

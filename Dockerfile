FROM node:22-bookworm-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/package*.json ./server/
COPY web/package*.json ./web/
RUN npm --prefix server install --no-audit --no-fund \
    && npm --prefix web install --no-audit --no-fund

COPY server ./server
COPY web ./web
RUN npm --prefix web run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=./data/database.db

COPY --from=builder /app/server ./server
COPY --from=builder /app/web/dist ./web/dist

RUN mkdir -p /app/server/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/auth/check').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "--prefix", "server", "start"]

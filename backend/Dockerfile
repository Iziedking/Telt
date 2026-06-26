# Telt backend. Runs on tsx directly (no build step) so the container is the same
# code that runs in dev. On boot it applies the database schema, then serves.
FROM node:22-slim

WORKDIR /app

# Install dependencies first for layer caching. dev deps are needed because tsx
# runs the TypeScript sources directly.
COPY package.json package-lock.json* ./
RUN npm install

COPY . .

ENV NODE_ENV=production
EXPOSE 8787

# Apply the schema (idempotent), then start the server. Postgres readiness is
# gated by the compose healthcheck, so migrate will not race the database.
CMD ["sh", "-c", "npm run db:migrate && npm run start"]

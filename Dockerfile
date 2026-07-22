FROM node:20-alpine

WORKDIR /app

# Install deps first for better layer caching. Use the lockfile (npm ci) for
# reproducible installs across machines/CI. No native build toolchain needed
# any more - the Postgres driver (`pg`) is pure JS, unlike the old SQLite
# setup.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY api ./api

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]

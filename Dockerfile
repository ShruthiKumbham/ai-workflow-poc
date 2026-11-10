# Container image for the AI engineering workflow POC portal.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=10000 \
    AI_ENGINE=rules \
    POC_SKIP_ENV_FILE=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY config ./config
COPY public ./public
COPY src ./src

# The DuckDB platform (src/bronze/silver/gold/meta) is seeded on first start
# with synthetic data, so the image contains no data files.
RUN mkdir -p data && chown -R node:node /app
USER node

EXPOSE 10000
CMD ["node", "src/server.js"]

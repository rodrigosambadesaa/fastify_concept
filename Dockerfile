FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY sql ./sql
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/sql ./sql
USER node
EXPOSE 3000
CMD ["node", "dist/src/main.js"]

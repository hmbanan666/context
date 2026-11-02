FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
RUN npm install --global npm@11.19.1
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && node dist/scripts/download-search-model.js /app/models && npm prune --omit=dev

FROM node:24.22.1-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/models ./models
COPY THIRD_PARTY_NOTICES ./THIRD_PARTY_NOTICES
RUN mkdir /app/data /app/backups && chown node:node /app/data /app/backups \
    && chmod +x /app/dist/scripts/context.js \
    && ln -s /app/dist/scripts/context.js /usr/local/bin/context
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["node", "--input-type=module", "-e", "const r=await fetch('http://127.0.0.1:3000/health');process.exit(r.ok?0:1)"]
CMD ["node", "dist/src/main.js"]

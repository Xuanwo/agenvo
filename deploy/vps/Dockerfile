FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts/build.mjs scripts/release-packages.ts ./scripts/
COPY LICENSE NOTICE ./
RUN npm ci && npm pack --workspace @agenvo/server --pack-destination /tmp
RUN mkdir /release && cd /release && npm init -y && npm install --omit=dev /tmp/agenvo-server-*.tgz

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /release/node_modules ./node_modules
USER node
EXPOSE 8080
ENTRYPOINT ["node", "node_modules/@agenvo/server/dist/cli.js"]
CMD ["serve", "--config", "/config/relay.json"]

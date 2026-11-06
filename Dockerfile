FROM oven/bun:1.3.12 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.3.12-slim
WORKDIR /app
ARG RELEASE_SHA
ARG RENDER_GIT_COMMIT
ENV NODE_ENV=production
RUN bun -e 'const sha=process.env.RELEASE_SHA || process.env.RENDER_GIT_COMMIT; if (!/^[a-f0-9]{40}$/.test(sha || "")) process.exit(1); require("node:fs").writeFileSync("/app/release-sha",sha)'
COPY --from=build /app/dist ./dist
USER bun
EXPOSE 8000
CMD ["sh", "-c", "export RELEASE_SHA=\"$(cat /app/release-sha)\"; exec bun dist/index.js"]

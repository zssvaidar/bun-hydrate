# One image, two processes: `bun dist/index.js` (web) and `bun dist/worker.js` (worker).
# Build from the repository root: docker build -f docs/deploy/Dockerfile -t bun-hydrate .
FROM oven/bun:1.3.11 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile && bun run build

# dist/ is self-contained (no node_modules): the runtime image carries only the build output.
FROM oven/bun:1.3.11-slim
WORKDIR /app
COPY --from=build /src/dist ./dist
RUN mkdir -p /app/data && chown bun:bun /app/data
USER bun
ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "dist/index.js"]

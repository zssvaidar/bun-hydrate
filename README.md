Bun installation link: https://bun.sh/

Dev run: bun --watch index.tsx

Build for deploy: bun run build (bundles the server to dist/index.js and the
client assets to dist/public/, using Bun.build)

Run a built artifact: bun dist/index.js

Health check: GET /health

Description: boilerplate project for bun + react ssr for future microservice base

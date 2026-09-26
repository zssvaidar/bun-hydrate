#!/bin/bash
set -euo pipefail

VERSION="$1"
BUILD_DIR="build_output"

echo "Building version ${VERSION}..."

# 1. Install exactly what the lockfile pins, then bundle server + client into dist/.
#    `hydrate build` sets NODE_ENV=production itself while bundling (Bun picks the JSX runtime at
#    build time) and bundles every dependency, so dist/ needs no node_modules on the instance.
bun install --frozen-lockfile
bun run build

# 2. Ship only the self-contained dist/ — deploy.sh checks for dist/index.js and the systemd unit runs it.
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"
cp -r dist "${BUILD_DIR}/"

# 3. Package into the exact filename deploy.sh will look for
tar -czf "node-app-${VERSION}.tar.gz" -C "${BUILD_DIR}" .

echo "Built artifact: node-app-${VERSION}.tar.gz"

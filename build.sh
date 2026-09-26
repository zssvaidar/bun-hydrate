#!/bin/bash
set -euo pipefail

VERSION="$1"
BUILD_DIR="build_output"

echo "Building version ${VERSION}..."

# 1. Install dependencies and bundle the server + client assets into dist/
bun install
# NODE_ENV must be production here, at build time - Bun's bundler picks the JSX runtime
# (jsxDEV vs jsx/jsxs) based on this env var during the build itself, independent of
# tsconfig's "jsx" setting. Setting NODE_ENV=production only on the deployed systemd unit
# is too late: it doesn't affect how the code was already transpiled and bundled here,
# and the dev runtime (react/jsx-dev-runtime) breaks once inlined and minified.
NODE_ENV=production bun run build --sourcemap

# 2. Assemble only what actually needs to ship — not source, dev deps, tests, etc.
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"
cp -r dist package.json bun.lockb "${BUILD_DIR}/"
cd "${BUILD_DIR}" && bun install --production && cd ..

# 3. Package into the exact filename deploy.sh will look for
tar -czf "node-app-${VERSION}.tar.gz" -C "${BUILD_DIR}" .

echo "Built artifact: node-app-${VERSION}.tar.gz"
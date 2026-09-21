#!/bin/bash
set -euo pipefail

VERSION="$1"
BUILD_DIR="build_output"

echo "Building version ${VERSION}..."

# 1. Install dependencies and bundle the server + client assets into dist/
bun install
bun run build

# 2. Assemble only what actually needs to ship — not source, dev deps, tests, etc.
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"
cp -r dist package.json bun.lockb "${BUILD_DIR}/"
cd "${BUILD_DIR}" && bun install --production && cd ..

# 3. Package into the exact filename deploy.sh will look for
tar -czf "myapp-${VERSION}.tar.gz" -C "${BUILD_DIR}" .

echo "Built artifact: myapp-${VERSION}.tar.gz"
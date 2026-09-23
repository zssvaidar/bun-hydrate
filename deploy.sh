#!/bin/bash
set -euo pipefail

VERSION="$1"
APP_ROOT="/opt/myapp"
RELEASES_DIR="${APP_ROOT}/releases"
RELEASE_DIR="${RELEASES_DIR}/${VERSION}"
CURRENT_LINK="${APP_ROOT}/current"
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:?set ARTIFACT_BUCKET, my-build-artifacts}"
SERVICE_NAME="myapp"
KEEP_RELEASES=5

echo "Deploying version ${VERSION}..."

# 1. Pull the artifact and extract into its own versioned directory
mkdir -p "${RELEASE_DIR}"
aws s3 cp "s3://${ARTIFACT_BUCKET}/myapp-${VERSION}.tar.gz" /tmp/myapp-${VERSION}.tar.gz
tar -xzf /tmp/myapp-${VERSION}.tar.gz -C "${RELEASE_DIR}"

# 2. Remember what "current" points to right now, in case we need to roll back
PREVIOUS_TARGET=$(readlink -f "${CURRENT_LINK}" 2>/dev/null || echo "")

# 3. Atomically repoint the symlink — this is the key difference from before.
#    `ln -sfn` replaces the symlink in a single filesystem operation, so there's
#    no window where "current" points to a half-written or missing directory,
#    unlike the old mv-based swap.
ln -sfn "${RELEASE_DIR}" "${CURRENT_LINK}"

# 4. Restart the service — it should always be configured to run from
#    ${CURRENT_LINK}, never a version-specific path, so this restart is all it takes.
sudo systemctl restart "${SERVICE_NAME}"

# 5. Health check before declaring success
sleep 5
if curl -sf http://localhost:8080/health > /dev/null; then
  echo "Deploy of ${VERSION} succeeded"
else
  echo "Health check failed after deploying ${VERSION} — rolling back"
  if [ -n "${PREVIOUS_TARGET}" ]; then
    ln -sfn "${PREVIOUS_TARGET}" "${CURRENT_LINK}"
    sudo systemctl restart "${SERVICE_NAME}"
  fi
  exit 1
fi

# 6. Prune old releases, keeping the most recent N
cd "${RELEASES_DIR}"
ls -t | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf

exit 0
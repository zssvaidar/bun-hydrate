#!/bin/bash
set -euo pipefail

# Deploys into the exact layout cd-stack-gen/project-11/ami-scripts/bun.sh (and
# bun_cloudflared.sh) bakes onto the AMI: releases/<version>/ under APP_ROOT, a "current"
# symlink pointing at whichever one is live, and a systemd unit named after SERVICE_NAME whose
# WorkingDirectory is that symlink - never a version path directly, so re-pointing it and
# restarting the unit is a complete deploy. APP_USER/PORT/SERVICE_NAME below must keep matching
# whatever that script actually creates (bunapp / 80 / myapp.service today).

VERSION="$1"
APP_ROOT="/opt/myapp"
APP_USER="bunapp"
SERVICE_NAME="myapp"
PORT=80
RELEASES_DIR="${APP_ROOT}/releases"
RELEASE_DIR="${RELEASES_DIR}/${VERSION}"
CURRENT_LINK="${APP_ROOT}/current"
# set by the Jenkinsfile as ARTIFACT_BUCKET=$DEPLOY_BUCKET on the SSM command - required rather
# than defaulted, since a wrong silent default here means deploying from the wrong bucket
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:?set ARTIFACT_BUCKET (the bucket the build artifact was uploaded to)}"
KEEP_RELEASES=5

echo "Deploying version ${VERSION}..."

# 1. Pull the artifact and extract into its own versioned directory
mkdir -p "${RELEASE_DIR}"
aws s3 cp "s3://${ARTIFACT_BUCKET}/myapp-${VERSION}.tar.gz" "/tmp/myapp-${VERSION}.tar.gz"
tar -xzf "/tmp/myapp-${VERSION}.tar.gz" -C "${RELEASE_DIR}"

# 2. Sanity-check the release before it's ever symlinked live - a broken or empty artifact
#    should fail here, not after the swap has already pointed "current" at it.
[ -f "${RELEASE_DIR}/index.ts" ] || { echo "index.ts missing from extracted release ${VERSION} - not deploying" >&2; exit 1; }

# SSM runs this as root, but ${SERVICE_NAME}.service runs the app as the unprivileged
# ${APP_USER} - without this it can't read/execute what was just extracted.
chown -R "${APP_USER}:${APP_USER}" "${RELEASE_DIR}"

# 3. Remember what "current" points to right now, in case we need to roll back
PREVIOUS_TARGET=$(readlink -f "${CURRENT_LINK}" 2>/dev/null || echo "")

# 4. Atomically repoint the symlink - `ln -sfn` replaces it in a single filesystem operation,
#    so there's no window where "current" points to a half-written or missing directory.
ln -sfn "${RELEASE_DIR}" "${CURRENT_LINK}"

# 5. Restart the service - it always runs from ${CURRENT_LINK}, never a version-specific path,
#    so this restart is all it takes.
sudo systemctl restart "${SERVICE_NAME}"

# 6. Health check before declaring success
sleep 5
if curl -sf "http://localhost:${PORT}/health" > /dev/null; then
  echo "Deploy of ${VERSION} succeeded"
else
  echo "Health check failed after deploying ${VERSION} — rolling back"
  if [ -n "${PREVIOUS_TARGET}" ]; then
    ln -sfn "${PREVIOUS_TARGET}" "${CURRENT_LINK}"
    sudo systemctl restart "${SERVICE_NAME}"
  fi
  exit 1
fi

# 7. Prune old releases, keeping the most recent N
cd "${RELEASES_DIR}"
ls -t | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf

exit 0

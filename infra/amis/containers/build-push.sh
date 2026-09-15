#!/usr/bin/env bash
# build-push.sh — build a spore.host app container and push it to a public ECR
# repository (#290 container catalog).
#
# Replaces the retired per-app Packer AMI build: instead of baking the app onto a
# per-region AMI, we publish ONE container image that spawn runs on the
# SSM-resolved AWS GPU DLAMI (AL2023) in every region (spore-host#286/#389).
#
# Usage:
#   ./build-push.sh <app> <version> [registry]
#   ./build-push.sh paraview 5.13.2
#   ./build-push.sh paraview 5.13.2 public.ecr.aws/f8g1e7l5
#
# Environment:
#   SPORE_ECR_REGISTRY   default registry (default: public.ecr.aws/f8g1e7l5 — the
#                        build account's default ECR Public alias; a vanity
#                        "spore-host" alias needs async AWS approval)
#   SPORE_ECR_REGION     region for ECR Public auth (always us-east-1 for public)
#   SPORE_BUILD_DRYRUN   "true" → build only, do not push
#
# Prerequisites:
#   - docker (with buildx) and AWS CLI v2
#   - AWS creds for the registry's account (the dedicated infra account 812107987990)
#   - The per-app Dockerfile at containers/<app>/Dockerfile
#
# Public ECR is auth'd in us-east-1 regardless of where the registry "lives".
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP="${1:-}"
VERSION="${2:-}"
REGISTRY="${3:-${SPORE_ECR_REGISTRY:-public.ecr.aws/f8g1e7l5}}"
DRYRUN="${SPORE_BUILD_DRYRUN:-false}"
ECR_REGION="${SPORE_ECR_REGION:-us-east-1}"

if [[ -z "$APP" || -z "$VERSION" ]]; then
  echo "Usage: $0 <app> <version> [registry]" >&2
  exit 2
fi

DOCKERFILE="${SCRIPT_DIR}/${APP}/Dockerfile"
if [[ ! -f "$DOCKERFILE" ]]; then
  echo "ERROR: no Dockerfile for '${APP}' at ${DOCKERFILE}" >&2
  echo "Available: $(ls -d "${SCRIPT_DIR}"/*/ 2>/dev/null | xargs -n1 basename | tr '\n' ' ')" >&2
  exit 1
fi

IMAGE="${REGISTRY}/${APP}"
TAG="${IMAGE}:${VERSION}"

# Per-app build-args + preconditions.
BUILD_ARGS=()
case "$APP" in
  paraview)
    # ParaView needs PV_MAJOR_MINOR derived from the version.
    BUILD_ARGS+=(--build-arg "PV_VERSION=${VERSION}")
    BUILD_ARGS+=(--build-arg "PV_MAJOR_MINOR=$(echo "$VERSION" | cut -d. -f1,2)")
    ;;
  chimerax)
    # LICENSE GATE: ChimeraX has no unattended download (UCSF requires accepting a
    # non-commercial license per download). The .deb must be placed in the app dir
    # by a human who accepted the license. Fail clearly if it's missing.
    DEB_GLOB=("${SCRIPT_DIR}/${APP}"/ucsf-chimerax_*.deb)
    if [[ ! -e "${DEB_GLOB[0]}" ]]; then
      echo "ERROR: no ChimeraX .deb in ${SCRIPT_DIR}/${APP}/" >&2
      echo "  ChimeraX requires accepting a non-commercial license to download." >&2
      echo "  1) Visit https://www.cgl.ucsf.edu/chimerax/download.html, accept the license," >&2
      echo "     and download the Ubuntu 24.04 .deb (ucsf-chimerax_${VERSION}ubuntu24.04_amd64.deb)." >&2
      echo "  2) Place it in ${SCRIPT_DIR}/${APP}/ and re-run this script." >&2
      exit 1
    fi
    BUILD_ARGS+=(--build-arg "CHIMERAX_DEB=$(basename "${DEB_GLOB[0]}")")
    ;;
esac

# Always build linux/amd64 — the base AMI and the app binaries are x86_64. On an
# arm64 host this cross-builds via buildx+QEMU. --load (dry-run) imports the
# single-arch image locally; the push path builds and pushes in one step.
PLATFORM="linux/amd64"

echo "==> Building ${TAG} (${PLATFORM})"
if [[ "$DRYRUN" == "true" ]]; then
  docker buildx build --platform "$PLATFORM" --load \
    "${BUILD_ARGS[@]}" \
    -t "$TAG" -f "$DOCKERFILE" "${SCRIPT_DIR}/${APP}"
  echo "==> DRYRUN — built ${TAG}, not pushing"
  exit 0
fi

echo "==> Authenticating to ECR Public (${ECR_REGION})"
aws ecr-public get-login-password --region "$ECR_REGION" \
  | docker login --username AWS --password-stdin public.ecr.aws

# Ensure the public repository exists (idempotent). The ECR Public repo name is
# just the app (the registry namespace is the public.ecr.aws/<alias> prefix).
aws ecr-public describe-repositories --region "$ECR_REGION" \
  --repository-names "$APP" >/dev/null 2>&1 \
  || aws ecr-public create-repository --region "$ECR_REGION" \
       --repository-name "$APP" >/dev/null

echo "==> Building + pushing ${TAG} (${PLATFORM})"
# buildx --push builds the amd64 image and pushes it in one step (so an arm64
# host publishes a correct x86_64 image, not its native arch).
docker buildx build --platform "$PLATFORM" --push \
  "${BUILD_ARGS[@]}" \
  -t "$TAG" -f "$DOCKERFILE" "${SCRIPT_DIR}/${APP}"

echo "==> Done: ${TAG}"
echo "    Add to catalog (libs/catalog/catalog.yaml):"
echo "      image: ${IMAGE}"
echo "      tag_default: \"${VERSION}\""

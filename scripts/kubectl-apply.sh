#!/usr/bin/env bash
set -euo pipefail

# Non-interactive kubectl deployment helper.
# Optional env vars:
#   NAMESPACE=restaurant
#   MANIFEST_FILE=kube-deployment.yml
#   GITLAB_REGISTRY=registry.shitlab.dev
#   GITLAB_SECRET_NAME=gitlab-registry-key
#   GITLAB_USER=<user>
#   GITLAB_TOKEN=<token>

NAMESPACE="${NAMESPACE:-restaurant}"
MANIFEST_FILE="${MANIFEST_FILE:-kube-deployment.yml}"
GITLAB_REGISTRY="${GITLAB_REGISTRY:-registry.shitlab.dev}"
GITLAB_SECRET_NAME="${GITLAB_SECRET_NAME:-gitlab-registry-key}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if ! command -v kubectl >/dev/null 2>&1; then
  echo "Fehler: kubectl wurde nicht gefunden." >&2
  exit 1
fi

if [[ "${MANIFEST_FILE}" != /* ]]; then
  MANIFEST_FILE="${REPO_ROOT}/${MANIFEST_FILE}"
fi

if [[ ! -f "${MANIFEST_FILE}" ]]; then
  echo "Fehler: Manifest nicht gefunden: ${MANIFEST_FILE}" >&2
  exit 1
fi

echo "==> Namespace sicherstellen: ${NAMESPACE}"
kubectl get namespace "${NAMESPACE}" >/dev/null 2>&1 || kubectl create namespace "${NAMESPACE}"

if [[ -n "${GITLAB_USER:-}" && -n "${GITLAB_TOKEN:-}" ]]; then
  echo "==> GitLab Pull Secret anwenden: ${GITLAB_SECRET_NAME}"
  kubectl -n "${NAMESPACE}" create secret docker-registry "${GITLAB_SECRET_NAME}" \
    --docker-server="${GITLAB_REGISTRY}" \
    --docker-username="${GITLAB_USER}" \
    --docker-password="${GITLAB_TOKEN}" \
    --dry-run=client -o yaml | kubectl apply -f -
else
  echo "==> Kein GitLab Secret gesetzt (GITLAB_USER/GITLAB_TOKEN fehlen)."
fi

echo "==> Manifest anwenden: ${MANIFEST_FILE}"
kubectl apply -f "${MANIFEST_FILE}"

echo "==> Status:"
kubectl -n "${NAMESPACE}" get pods,svc,ingress

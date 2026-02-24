#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="restaurant"
MANIFEST_FILE="kube-deployment.yml"
DEFAULT_REGISTRY="registry.shitlab.dev"
DEFAULT_SECRET_NAME="gitlab-registry-key"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/apply-k8s.sh [--manifest PATH] [--namespace NAME]

Options:
  -f, --manifest    Kubernetes manifest file (default: kube-deployment.yml)
  -n, --namespace   Namespace to ensure exists (default: restaurant)
  -h, --help        Show this help
EOF
}

prompt_yes_no() {
  local prompt="$1"
  local default_answer="${2:-n}"
  local input

  while true; do
    if [[ "${default_answer}" == "y" ]]; then
      read -r -p "${prompt} [Y/n]: " input || true
      input="${input:-y}"
    else
      read -r -p "${prompt} [y/N]: " input || true
      input="${input:-n}"
    fi

    case "${input,,}" in
      y|yes|j|ja) return 0 ;;
      n|no|nein) return 1 ;;
      *) echo "Bitte mit 'y' oder 'n' antworten." ;;
    esac
  done
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--manifest)
      MANIFEST_FILE="$2"
      shift 2
      ;;
    -n|--namespace)
      NAMESPACE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unbekannter Parameter: $1" >&2
      usage
      exit 1
      ;;
  esac
done

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

echo "Namespace sicherstellen: ${NAMESPACE}"
kubectl get namespace "${NAMESPACE}" >/dev/null 2>&1 || kubectl create namespace "${NAMESPACE}"

if prompt_yes_no "GitLab Pull Secret anlegen/aktualisieren?" "n"; then
  read -r -p "Registry Server [${DEFAULT_REGISTRY}]: " registry_input
  registry_input="${registry_input:-${DEFAULT_REGISTRY}}"

  read -r -p "Secret Name [${DEFAULT_SECRET_NAME}]: " secret_name_input
  secret_name_input="${secret_name_input:-${DEFAULT_SECRET_NAME}}"

  read -r -p "GitLab Benutzername: " gitlab_user
  if [[ -z "${gitlab_user}" ]]; then
    echo "Fehler: Benutzername darf nicht leer sein." >&2
    exit 1
  fi

  read -r -s -p "GitLab Token/Passwort: " gitlab_password
  echo ""
  if [[ -z "${gitlab_password}" ]]; then
    echo "Fehler: Token/Passwort darf nicht leer sein." >&2
    exit 1
  fi

  kubectl -n "${NAMESPACE}" create secret docker-registry "${secret_name_input}" \
    --docker-server="${registry_input}" \
    --docker-username="${gitlab_user}" \
    --docker-password="${gitlab_password}" \
    --dry-run=client -o yaml | kubectl apply -f -

  if prompt_yes_no "Secret als imagePullSecret im default ServiceAccount setzen?" "y"; then
    existing_pull_secrets="$(kubectl get serviceaccount default -n "${NAMESPACE}" -o jsonpath='{range .imagePullSecrets[*]}{.name}{"\n"}{end}' 2>/dev/null || true)"

    if grep -qx "${secret_name_input}" <<<"${existing_pull_secrets}"; then
      echo "imagePullSecret ist bereits gesetzt."
    else
      pull_secret_json=""
      while IFS= read -r existing_name; do
        [[ -z "${existing_name}" ]] && continue
        pull_secret_json="${pull_secret_json}{\"name\":\"${existing_name}\"},"
      done <<<"${existing_pull_secrets}"
      pull_secret_json="${pull_secret_json}{\"name\":\"${secret_name_input}\"}"

      kubectl patch serviceaccount default -n "${NAMESPACE}" --type merge \
        -p "{\"imagePullSecrets\":[${pull_secret_json}]}"
      echo "default ServiceAccount aktualisiert."
    fi
  fi
fi

echo "Manifest anwenden: ${MANIFEST_FILE}"
kubectl apply -f "${MANIFEST_FILE}"

echo "Fertig."

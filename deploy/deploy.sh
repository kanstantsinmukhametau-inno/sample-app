#!/usr/bin/env bash
# Deploys one image to the lab k3s cluster as a Knative Service. Run by the self-hosted
# runner (namespace-scoped `deployer` kubeconfig); runnable by hand with the same inputs.
#
#   IMAGE            image reference to deploy, ideally by digest (…@sha256:…)   required
#   GHCR_USER        registry user for the pull secret        (skip secret if unset)
#   GHCR_PULL_TOKEN  read:packages token for the pull secret  (skip secret if unset)
#   NAMESPACE        default: apps        SERVICE  default: sample-app
#   DOMAIN           default: lab.test    RUN_ID   default: epoch seconds
set -euo pipefail

: "${IMAGE:?IMAGE is required}"
NAMESPACE="${NAMESPACE:-apps}"
SERVICE="${SERVICE:-sample-app}"
DOMAIN="${DOMAIN:-lab.test}"
RUN_ID="${RUN_ID:-$(date +%s)}"
PULL_SECRET_ARGS=()
PULL_SECRETS_YAML="[]"

if [[ -n "${GHCR_PULL_TOKEN:-}" ]]; then
  echo "::group::Registry pull secret"
  : "${GHCR_USER:?GHCR_USER is required with GHCR_PULL_TOKEN}"
  # Built with shell builtins and piped via stdin: the token never appears on a
  # process command line (visible in `ps` on the runner VM).
  auth="$(printf '%s:%s' "$GHCR_USER" "$GHCR_PULL_TOKEN" | base64 -w0)"
  printf '{"auths":{"ghcr.io":{"auth":"%s"}}}' "$auth" \
    | kubectl -n "$NAMESPACE" create secret generic ghcr-pull \
        --type=kubernetes.io/dockerconfigjson \
        --from-file=.dockerconfigjson=/dev/stdin \
        --dry-run=client -o yaml \
    | kubectl apply -f -
  unset auth
  PULL_SECRET_ARGS=(--pull-secret ghcr-pull)
  PULL_SECRETS_YAML="[{ name: ghcr-pull }]"
  echo "::endgroup::"
fi

echo "::group::Database migrations"
job="${SERVICE}-migrate-${RUN_ID}"
kubectl -n "$NAMESPACE" apply -f - <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: ${job}
  labels: { app: ${SERVICE}, component: migrate }
spec:
  backoffLimit: 1
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels: { app: ${SERVICE}, component: migrate }
    spec:
      restartPolicy: Never
      imagePullSecrets: ${PULL_SECRETS_YAML}
      containers:
        - name: migrate
          image: ${IMAGE}
          command: [/app/node_modules/.bin/prisma, migrate, deploy]
          envFrom: [{ secretRef: { name: ${SERVICE}-env } }]
EOF
if ! kubectl -n "$NAMESPACE" wait --for=condition=complete "job/${job}" --timeout=300s; then
  kubectl -n "$NAMESPACE" logs "job/${job}" --all-containers || true
  echo "::error::migration job ${job} did not complete"
  exit 1
fi
kubectl -n "$NAMESPACE" logs "job/${job}" --all-containers | tail -n 5
echo "::endgroup::"

echo "::group::Knative Service"
kn service apply "$SERVICE" -n "$NAMESPACE" \
  --image "$IMAGE" \
  --port 8080 \
  "${PULL_SECRET_ARGS[@]}" \
  --env-from "secret:${SERVICE}-env" \
  --env NODE_ENV=production \
  --env "FRONTEND_URL=https://${SERVICE}.${DOMAIN}" \
  --probe-readiness "http:::/api/health" \
  --scale-min 0 \
  --wait-timeout 300
# `kn service apply` returns success on "No changes to apply" even when the current
# revision is not Ready, so readiness is asserted separately.
if ! kubectl -n "$NAMESPACE" wait "ksvc/${SERVICE}" --for=condition=Ready --timeout=300s; then
  kn service describe "$SERVICE" -n "$NAMESPACE" || true
  kubectl -n "$NAMESPACE" get pods -l "serving.knative.dev/service=${SERVICE}" || true
  echo "::error::Knative Service ${SERVICE} is not Ready"
  exit 1
fi
kn service describe "$SERVICE" -n "$NAMESPACE"
echo "::endgroup::"

echo "::group::Smoke test through the TLS edge"
url="https://${SERVICE}.${DOMAIN}"
curl -fsS --retry 5 --retry-delay 3 --retry-all-errors "${url}/api/health"
echo
curl -fsS -o /dev/null -w "SPA shell: %{http_code}\n" "${url}/login"
echo "::endgroup::"
echo "Deployed ${IMAGE} → ${url}"

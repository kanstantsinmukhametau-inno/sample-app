# Deployment (lab k3s + Knative)

`sample-app` runs as a single Knative Service: one image serves the API under `/api` and the
built SPA from the same origin, so auth cookies stay first-party.
The service is at **https://sample-app.lab.test**.

```
browser ──TLS──▶ nginx-vm :443 ──▶ Kourier NodePort 31080 ──▶ Knative Service "sample-app" (ns apps)
                                                           └─▶ Postgres 16 StatefulSet (ns apps)
```
The cluster and edge are provisioned by `lab-terraform` (VMs) and `lab-ansible` (k3s, Knative/Kourier, Postgres, nginx, runner).

## Pipeline — `.github/workflows/ci-cd.yml`
| Job | When | What |
|---|---|---|
| lint | PR + main | eslint (backend, no `--fix`), oxlint (frontend) |
| test | PR + main | jest + vitest unit suites |
| e2e | PR + main | backend e2e against a `postgres:16` service container |
| build | PR + main | `nest build`, `tsc -b && vite build` |
| sast | PR + main | Semgrep OSS (`p/typescript`, `p/nodejs`) + Trivy on `package-lock.json` |
| image | main | build → **Trivy image scan (fixable HIGH/CRITICAL fail)** → push `ghcr.io/<owner>/sample-app:{sha,latest}` |
| deploy | main | self-hosted runner `lab`: `deploy/deploy.sh` with the pushed digest |

`deploy/deploy.sh` runs these steps:
1. Refreshes the `ghcr-pull` secret.
2. Runs `prisma migrate deploy` as a one-off Job from the same image.
3. Runs `kn service apply` (port 8080, readiness `/api/health`, env from Secret `sample-app-env`, scale-to-zero).
4. Waits for `Ready`, then smoke-tests `https://sample-app.lab.test/api/health` through nginx.

You can run it by hand on the runner: `IMAGE=<ref> ./deploy/deploy.sh`.

## Required GitHub settings
- **Runner:** a self-hosted runner registered with label `lab`. `lab-ansible` installs it; it needs a registration token.
- **Secret `GHCR_PULL_TOKEN`:** a classic PAT with `read:packages`. It must be long-lived, because every cold start may pull the image again.
- **Environment `lab`:** created automatically on the first deploy. Add protection rules there if wanted.

## Accepted findings
`.trivyignore.yaml` lists scanner exceptions. Each one is scoped to a single package version, has a reason, and expires, and both Trivy steps use it.

## Known limits
- Uploads (`/uploads`, local disk) and in-memory camp-conversion drafts are lost on scale-to-zero or a new revision.
- A single Postgres replica on k3s `local-path` storage, pinned to one node.
- The TLS certificate comes from the lab's self-signed CA (`lab-ansible/artifacts/lab-ca.crt`).
- `npm run start:prod` (`node dist/main`) predates this change and points at a path `nest build` doesn't produce (`dist/src/main.js`). The image runs the real path.

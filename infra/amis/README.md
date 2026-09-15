# spore.host application images

App-catalog build assets for spore.host's **container-based** application
streaming. Each streamable app ships as a Docker image that spawn pulls at
launch — there is **no owned or shared per-app AMI, and no Packer build**.

> **The Packer/owned-base-AMI model was retired** (spawn v0.106.0/v0.107.0,
> libs v0.44.0/v0.45.0 — see spore-host#286/#389). The old per-app, per-region
> `*.pkr.hcl` builds, the `dcv-*-base` AMIs, `build.sh`, `catalog-update.sh`,
> `share-base-ami.sh`, and the AWS Marketplace publishing track are **gone**.
> Owning the base AMI was the *cause* of the dangling/unshared-AMI drift in
> #389, not the fix. If you are looking for those files, they were deleted in
> the PR for #546.

## How an app launch works today

`spawn app launch <app>` (e.g. `spawn app launch paraview`):

1. **Base image** — spawn resolves the AWS-maintained **GPU Deep Learning Base
   AMI (Amazon Linux 2023)** — NVIDIA driver preinstalled, published by AWS in
   **every region** — via an **SSM public parameter at launch time**. Nothing is
   owned, copied, or shared. (CPU-only apps use the standard AL2023 AMI.)
2. **DCV at boot** — for `application`/`desktop` apps, spawn installs the free,
   self-licensing **Amazon DCV** server at first boot and starts a virtual
   session. `web` apps skip DCV entirely (see below).
3. **App image** — spawn pulls the app's container image from public ECR and
   runs it as the session (bind-mounting the host X socket for GUI apps).

The catalog *may* carry an optional `base_amis:` pin to a custom pre-baked image,
but should not — the SSM-resolved DLAMI is the default and covers every region by
construction.

## Launch kinds

Each catalog entry has a `kind`:

| kind | What it is | DCV? |
|------|------------|------|
| `application` (default) | A single GUI app streamed over a DCV virtual session (what `dcv: true` means). | yes |
| `desktop` | A bare Linux desktop over DCV — open a terminal and run anything. | yes |
| `web` | An app that serves its own web UI on `port` (Jupyter, code-server, …), fronted by a spored TLS reverse proxy. | **no** |

## The catalog

The application catalog lives in the **libs** repo at
**`libs/catalog/catalog.yaml`** (it was previously `pkg/catalog/catalog.yaml`;
that path no longer exists). An entry describes the app's resource requirements
and its image reference:

```yaml
- name: paraview
  description: "Scientific visualization — CFD, FEA, large mesh"
  instance_families: [g6, g5, g4dn]
  gpu: true
  dcv: true
  # Recipe, not cake (#392): spore.host ships the public build recipe; the
  # image itself is BYO. Build it with the recipe below and bind it in
  # ~/.spawn/catalog.yaml (image:/tag_default:), or launch with --image.
  recipe: infra/amis/containers/paraview
  # image: public.ecr.aws/f8g1e7l5/paraview   # optional, when a public image exists
  # tag_default: "5.13.2"
```

- **`recipe:`** points at a build recipe under `infra/amis/containers/<app>/`
  (Dockerfile + entrypoint). spore.host ships the recipe; the built image is
  bring-your-own unless a public one is published.
- **`image:` / `tag_default:`** name a container image in public ECR. There is
  **no `amis:` / `base_amis:` table to author** — the base is SSM-resolved. (An
  `amis: {}` entry is rejected by the catalog validator.)

## Building an app image

See **[`containers/README.md`](containers/README.md)** for the full build-and-push
flow (`containers/build-push.sh` → public ECR → bind via overlay or `--image`).

## What's in this directory

```
infra/amis/
  containers/            ← app image build recipes + build-push.sh (see its README)
    build-push.sh
    paraview/            ← Dockerfile + entrypoint
    chimerax/
  kiosk-wm/              ← minimal fullscreen X11 window manager used inside
                           GUI app sessions
  cleanup-orphan-amis.sh ← one-shot remediation: deregisters the leftover
                           per-app AMIs (and their snapshots) from the retired
                           model. Dry-run by default. Not part of any launch.
```

# spore.host container catalog (#290)

App images for the **container-based** app catalog. Each streamable app is a
Docker image; spawn pulls it at launch and runs it as the streaming session.
There is **no per-app AMI and no owned/shared base AMI** — spawn resolves the
AWS-maintained GPU Deep Learning Base AMI (Amazon Linux 2023, NVIDIA driver
preinstalled, present in every region) via an SSM public parameter at launch and
installs the free Amazon DCV server at boot.

This replaced the old per-app, per-region Packer AMI builds whose IDs drifted
into dangling/unshared state (#389). **Owning the base AMI was the cause of that
drift, not the fix** — the SSM-resolved DLAMI removes the owned-AMI table by
construction (spore-host#286/#389).

## Why containers

| | Old (AMI per app per region) | Container catalog (today) |
|---|---|---|
| Base image | owned `dcv-*-base` AMI, copied + shared per region | AWS DLAMI, SSM-resolved at launch (every region, nothing to own) |
| Add an app | ~20 min Packer build × 9 regions | write a Dockerfile, `build-push.sh` once |
| Update a version | rebuild + reshare every region | `docker push` a new tag |
| Drift risk | 9 × N AMI IDs to keep shared (#389) | none — no owned AMIs |
| Multi-version | full rebuild | image tags (`paraview:5.13.2`, `5.12.1`) |

## Layout

```
containers/
├── build-push.sh        # build <app>:<version> and push to public ECR
├── paraview/
│   ├── Dockerfile        # ParaView + metacity + fullscreen entrypoint
│   └── entrypoint.sh      # the container CMD = the DCV session
└── <app>/ ...
```

## How a launch works

`spawn app launch paraview` →

1. resolves the AWS **GPU DLAMI (AL2023)** for the region via an SSM public
   parameter — nothing owned or shared; installs the free Amazon DCV server at
   boot,
2. pre-pulls the app image `public.ecr.aws/f8g1e7l5/paraview:<tag>`,
3. creates the DCV session with the container as its init:
   ```sh
   docker run --rm --gpus all --network host -e DISPLAY=:0 \
     -v /tmp/.X11-unix:/tmp/.X11-unix public.ecr.aws/f8g1e7l5/paraview:<tag>
   ```

The DLAMI provides the NVIDIA driver; DCV (installed at boot) provides the X
server on `:0` and the stream. The container provides the app, its window
manager, and the fullscreen launcher, drawing into the host's DCV display via the
bind-mounted X socket. (`web` apps skip DCV and serve their own UI on a port
behind a spored TLS proxy.)

## Registry / public ECR alias

App images live under **`public.ecr.aws/f8g1e7l5`** — the build account's default
ECR Public alias — and that is what `libs/catalog/catalog.yaml` references. A
vanity `public.ecr.aws/spore-host` alias needs an asynchronous AWS approval; if
and when it's granted, switch the `image:` prefixes in the catalog and pass the
new registry to `build-push.sh`. Until then, use `f8g1e7l5`.

## Build & publish an app image/version

`build-push.sh` builds a `linux/amd64` image (the DLAMI base and app binaries are
x86_64) and pushes it to public ECR. On an arm64 host (Apple Silicon) it
cross-builds under QEMU via buildx — correct, but slow.

**Preferred: build natively on a throwaway x86 EC2 instance (via spawn).** No
emulation, native speed, and an instance role avoids local credential expiry.
Run in the ECR/infra account (812107987990):

```sh
spawn launch --instance-type c7i.2xlarge --region us-east-1 \
  --ttl 1h --terminate-on-complete \
  --command 'set -e; dnf install -y docker git && systemctl start docker &&
    git clone https://github.com/spore-host/spore-host &&
    cd spore-host/infra/amis/containers &&
    ./build-push.sh paraview 5.13.2'
# the instance has an instance role with ecr-public:* push perms.
```

**Local fallback** (no AWS / for a quick check; cross-builds on arm64):

```sh
./build-push.sh paraview 5.13.2            # build + push from your workstation
SPORE_BUILD_DRYRUN=true ./build-push.sh paraview 5.13.2   # build only, no push

# default registry is public.ecr.aws/f8g1e7l5; override if the vanity alias lands:
SPORE_ECR_REGISTRY=public.ecr.aws/spore-host ./build-push.sh paraview 5.13.2
```

> **ChimeraX license gate:** ChimeraX has no unattended download (UCSF requires
> accepting a non-commercial license per download). Place the `.deb` in
> `chimerax/` by hand first; `build-push.sh` fails clearly if it's missing.

Then bind the image into the catalog. Because images are **recipe, not cake**
(#392) — spore.host ships the recipe, the image is BYO — you either:

- add `image:`/`tag_default:`/`tags_available:` to `libs/catalog/catalog.yaml`
  and cut a libs release (for a published, first-party image), **or**
- bind it locally in `~/.spawn/catalog.yaml` (`image:`/`tag_default:`), **or**
- launch with `--image public.ecr.aws/<alias>/<app>:<tag>` directly.

There is **no base-AMI step** — the base is the SSM-resolved AWS DLAMI.

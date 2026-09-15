# ParaView application container for the spore.host container catalog (#290).
#
# Runs on the AWS GPU DLAMI (AL2023) that spawn resolves via SSM at launch (which
# provides the NVIDIA driver); DCV is installed at boot and provides the X server
# on :0. The container brings ParaView + a minimal window manager + the
# fullscreen launcher; it draws into the host's DCV display via the bind-mounted X
# socket. spawn launches it as the DCV session init with:
#
#   docker run --rm --gpus all --network host -e DISPLAY=:0 \
#     -v /tmp/.X11-unix:/tmp/.X11-unix public.ecr.aws/f8g1e7l5/paraview:<tag>
#
# Build/push: infra/amis/containers/build-push.sh paraview <version>
#
# Pinned to linux/amd64: the ParaView tarball below is x86_64, and the DLAMI base
# runs on x86_64 GPU instances (g6/g5/g4dn). Without this
# pin, building on an arm64 host (e.g. Apple Silicon) produces an arm64 image
# wrapping an x86_64 binary that cannot exec.
FROM --platform=linux/amd64 ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# ParaView runtime libs + a minimal WM (metacity) + X utilities the launcher uses
# to maximize the window after DCV resizes the display to the browser viewport.
# (ParaView bundles its own Python/Qt, so the base distro version is not load-bearing.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglx-mesa0 \
    libglu1-mesa \
    libxt6 libxrender1 libxext6 libxcursor1 \
    libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 \
    libxcb-render-util0 libxcb-xinerama0 libxcb-xkb1 libxcb-shape0 libxcb-xinput0 \
    libxkbcommon-x11-0 libxkbcommon0 libgomp1 libgcc-s1 \
    libxrandr2 libxi6 libxinerama1 \
    metacity \
    x11-utils x11-xserver-utils \
    fontconfig fonts-dejavu-core \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG PV_VERSION=5.13.2
ARG PV_MAJOR_MINOR=5.13

RUN curl -fsSL \
    "https://www.paraview.org/files/v${PV_MAJOR_MINOR}/ParaView-${PV_VERSION}-MPI-Linux-Python3.10-x86_64.tar.gz" \
    -o /tmp/pv.tar.gz && \
    tar -xzf /tmp/pv.tar.gz -C /opt/ && \
    ln -sf /opt/ParaView-${PV_VERSION}-MPI-Linux-Python3.10-x86_64/bin/paraview \
           /usr/local/bin/paraview && \
    rm /tmp/pv.tar.gz && \
    # VisRTX needs the NVIDIA OptiX SDK (not in the driver); ParaView still GPU-renders via OpenGL.
    rm -f /opt/ParaView-${PV_VERSION}-MPI-Linux-Python3.10-x86_64/lib/libVisRTX.so \
          /opt/ParaView-${PV_VERSION}-MPI-Linux-Python3.10-x86_64/lib/libVisRTX.so.0.1.6

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Ubuntu 24.04 ships a default 'ubuntu' user at uid 1000; remove it so we can own
# 1000 (matches the DCV session's ec2-user uid). 22.04 had no such user.
RUN userdel -r ubuntu 2>/dev/null || true; useradd -m -u 1000 paraview
USER paraview
# The container's job IS the DCV session: launch the WM + ParaView fullscreen and
# block until ParaView exits (then DCV closes the session → spored sees idle).
CMD ["/usr/local/bin/entrypoint.sh"]

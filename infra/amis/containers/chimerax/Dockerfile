# UCSF ChimeraX application container for the spore.host container catalog (#290).
#
# LICENSE GATE: ChimeraX is distributed under a non-commercial license that must
# be ACCEPTED interactively before download (POST choice=Accept to UCSF's
# chimerax-get.py — there is no unattended download URL). This Dockerfile does NOT
# bypass that. You must download the .deb yourself after accepting the license at
# https://www.cgl.ucsf.edu/chimerax/download.html and place it in THIS directory
# (infra/amis/containers/chimerax/) before building. build-push.sh checks for it.
#
# Runs on the AWS GPU DLAMI (AL2023) that spawn resolves via SSM at launch (NVIDIA
# driver preinstalled); DCV is installed at boot (X server, the stream). The
# container brings ChimeraX + a minimal WM + the fullscreen launcher and draws
# into the host's DCV session display.
#
# Build/push: infra/amis/containers/build-push.sh chimerax 1.12   (after placing the .deb)
#
# Pinned linux/amd64: the .deb is amd64 and the DLAMI base runs x86_64 GPU instances.
FROM --platform=linux/amd64 ubuntu:25.10

ENV DEBIAN_FRONTEND=noninteractive

# The ChimeraX .deb you downloaded after accepting the UCSF license. Default is
# the 1.12 Ubuntu 24.04 package name; override with --build-arg CHIMERAX_DEB=...
ARG CHIMERAX_DEB=ucsf-chimerax_1.12ubuntu24.04_amd64.deb

# Minimal WM (metacity) + X utilities for the fullscreen launcher, matching the
# paraview image. ChimeraX's own deps are resolved by apt from the .deb.
RUN apt-get update && apt-get install -y --no-install-recommends \
    metacity \
    x11-utils x11-xserver-utils \
    libgl1 libglx-mesa0 libglu1-mesa libxrender1 libxtst6 \
    fontconfig fonts-dejavu-core \
    ca-certificates \
    `# ChimeraX 1.12 uses Qt6, whose xcb platform plugin needs libxcb-cursor0` \
    `# (+ the xcb helper libs); without it Qt aborts: "no Qt platform plugin".` \
    libxcb-cursor0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 \
    libxcb-render-util0 libxcb-shape0 libxcb-xinerama0 libxcb-xkb1 \
    libxkbcommon-x11-0 \
    && rm -rf /var/lib/apt/lists/*

# Install ChimeraX from the human-provided .deb. apt resolves its dependencies.
COPY ${CHIMERAX_DEB} /tmp/chimerax.deb
RUN apt-get update && apt-get install -y --no-install-recommends /tmp/chimerax.deb \
    && rm -f /tmp/chimerax.deb \
    && rm -rf /var/lib/apt/lists/* \
    && test -x /usr/bin/chimerax

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Ubuntu 24.04 ships a default 'ubuntu' user at uid 1000; remove it so we can own
# 1000 (matches the DCV session's ec2-user uid). 22.04 had no such user.
RUN userdel -r ubuntu 2>/dev/null || true; useradd -m -u 1000 chimerax
USER chimerax
# The container CMD IS the DCV session: launch the WM + ChimeraX fullscreen.
CMD ["/usr/local/bin/entrypoint.sh"]

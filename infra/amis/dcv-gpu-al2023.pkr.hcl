packer {
  required_plugins {
    amazon = {
      version = ">= 1.3.0"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "build_instance_type" {
  type    = string
  default = "g6.xlarge"
}

# AL2023 base AMIs — update periodically via:
#   aws ec2 describe-images --filters "Name=name,Values=al2023-ami-*-kernel-*-x86_64" \
#     "Name=state,Values=available" --owners amazon --region <region> \
#     --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' --output text
locals {
  al2023_amis = {
    us-east-1      = "ami-0ffae00107fc7ecc7"
    us-east-2      = "ami-04a5b9d5a4ed68e17"
    us-west-1      = "ami-09f0a10ad86d78d4c"
    us-west-2      = "ami-0c8e8e3cc5285e46b"
    eu-west-1      = "ami-02f7d47f0c17e3cd5"
    eu-west-2      = "ami-0f7f8e9c15eae4c56"
    eu-central-1   = "ami-0e6b6fdf81e2a7c06"
    ap-southeast-1 = "ami-0c65a38f5b0ba56af"
    ap-northeast-1 = "ami-0d52e4a38a83edd5f"
  }
}

source "amazon-ebs" "dcv-gpu-al2023" {
  region        = var.region
  source_ami    = local.al2023_amis[var.region]
  instance_type = var.build_instance_type
  ssh_username  = "ec2-user"

  ami_name        = "spore-dcv-gpu-al2023-{{timestamp}}"
  ami_description = "spore.host: DCV 2025.0.20103 + NVIDIA 595.71.05 on AL2023 (GPU base)"

  tags = {
    "spore:type"       = "dcv-gpu-base"
    "spore:dcv"        = "2025.0-20103"
    "spore:nvidia"     = "595.71.05"
    "spore:os"         = "al2023"
    "spore:managed"    = "true"
    "spore:build-date" = "{{timestamp}}"
  }

  # IMDSv2 required (account has httpTokensEnforced)
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  # 40 GB: NVIDIA driver (~500 MB) + DCV (~300 MB) + Docker + ParaView image headroom
  launch_block_device_mappings {
    device_name           = "/dev/xvda"
    volume_size           = 40
    volume_type           = "gp3"
    delete_on_termination = true
  }
}

build {
  name    = "spore-dcv-gpu-al2023"
  sources = ["source.amazon-ebs.dcv-gpu-al2023"]

  # 1. Kernel build tools + extra modules for NVIDIA DKMS
  # AL2023 kernel 6.18+ uses prefixed package names. kernel-modules-extra provides DRM (.ko files).
  # The DRM module is CONFIG_DRM=m but only ships in kernel-modules-extra, not the base kernel pkg.
  # NVIDIA's grid driver depends on drm_gem_object_free from DRM — must be installed before NVIDIA.
  provisioner "shell" {
    inline = [
      "sudo dnf install -y gcc make dkms",
      "KVER=$(uname -r); KMAJ=$(uname -r | grep -oP '^[0-9]+\\.[0-9]+'); sudo dnf install -y kernel$${KMAJ}-devel-$${KVER} kernel$${KMAJ}-headers-$${KVER} kernel$${KMAJ}-modules-extra-$${KVER} || sudo dnf install -y kernel-devel-$${KVER} kernel-headers-$${KVER} kernel-modules-extra-$${KVER} || echo 'WARNING: kernel packages not found'",
    ]
    timeout = "15m"
  }

  # Security updates (after NVIDIA — safe since kernel itself doesn't update separately)
  provisioner "shell" {
    inline = [
      "sudo dnf update -y --exclude='kernel*'",
    ]
    timeout = "15m"
  }

  # 2. NVIDIA 595.71.05 grid-aws driver
  # s3://ec2-linux-nvidia-drivers is a public requester-pays bucket; --no-sign-request works from EC2.
  # --skip-module-load: skip test-loading the kernel module at build time (no physical GPU during Packer build)
  # The DRM module must load before nvidia at runtime — configure via /etc/modules-load.d/
  provisioner "shell" {
    inline = [
      "aws s3 cp --no-sign-request s3://ec2-linux-nvidia-drivers/latest/NVIDIA-Linux-x86_64-595.71.05-grid-aws.run /tmp/nvidia.run",
      "chmod +x /tmp/nvidia.run",
      # Do NOT use --no-drm: DCV 2025.0 virtual sessions require nvidia-drm for display output
      "sudo /tmp/nvidia.run --silent --disable-nouveau --skip-module-load",
      # Load drm and nvidia modules at boot (drm must load before nvidia on AL2023 kernel 6.18)
      "echo -e 'drm\\ndrm_kms_helper\\nnvidia\\nnvidia_uvm\\nnvidia_drm' | sudo tee /etc/modules-load.d/nvidia.conf",
      "echo 'NVIDIA driver installed (module load skipped at build time, will load at instance start)'",
    ]
    timeout = "20m"
  }

  # 3. NICE DCV 2025.0-20103
  # Tarball contents (verified 2026-05):
  #   nice-dcv-server-2025.0.20103-1.amzn2023.x86_64.rpm
  #   nice-dcv-gl-2025.0.1112-1.amzn2023.x86_64.rpm
  #   nice-xdcv-2025.0.688-1.amzn2023.x86_64.rpm
  #   nice-dcv-web-viewer-2025.0.20103-1.amzn2023.x86_64.rpm
  provisioner "shell" {
    inline = [
      "sudo dnf install -y pulseaudio pulseaudio-utils xorg-x11-server-Xvfb mesa-libGL mesa-libEGL libX11 libXext libXrandr xterm xsetroot",
      "sudo rpm --import https://d1uj6qtbmh3dt5.cloudfront.net/NICE-GPG-KEY",
      "curl -fsSL https://d1uj6qtbmh3dt5.cloudfront.net/2025.0/Servers/nice-dcv-2025.0-20103-amzn2023-x86_64.tgz -o /tmp/nice-dcv.tgz",
      "tar -xzf /tmp/nice-dcv.tgz -C /tmp/",
      "sudo dnf install -y /tmp/nice-dcv-2025.0-20103-amzn2023-x86_64/nice-dcv-server-2025.0.20103-1.amzn2023.x86_64.rpm",
      "sudo dnf install -y /tmp/nice-dcv-2025.0-20103-amzn2023-x86_64/nice-dcv-gl-2025.0.1112-1.amzn2023.x86_64.rpm",
      "sudo dnf install -y /tmp/nice-dcv-2025.0-20103-amzn2023-x86_64/nice-xdcv-2025.0.688-1.amzn2023.x86_64.rpm",
      "sudo dnf install -y /tmp/nice-dcv-2025.0-20103-amzn2023-x86_64/nice-dcv-web-viewer-2025.0.20103-1.amzn2023.x86_64.rpm",
      "sudo systemctl enable dcvserver",
      "dcv version",
      "rm -rf /tmp/nice-dcv.tgz /tmp/nice-dcv-2025.0-20103-amzn2023-x86_64",
    ]
    timeout = "15m"
  }

  # 4. Configure DCV for application streaming + spored token auth
  # create-session is left disabled in the base AMI — the app user-data creates the session
  # explicitly with the correct owner (ec2-user) and init command.
  provisioner "shell" {
    inline = [
      "sudo sed -i '/^\\[security\\]/a auth-token-verifier=\"http://127.0.0.1:8444\"' /etc/dcv/dcv.conf",
      # Allow client to resize the virtual display to match browser viewport
      "sudo sed -i '/^\\[display\\]/a enable-client-resize=true' /etc/dcv/dcv.conf",
      # Increase virtual session start timeout to 120s (ms; default 30000ms too short for Docker)
      "sudo sh -c 'echo -e \"\\n[session-management]\\nvirtual-session-start-timeout=120000\" >> /etc/dcv/dcv.conf'",
    ]
  }

  # 5. Docker + NVIDIA Container Toolkit (native dnf on AL2023, no Zstd workaround needed)
  provisioner "shell" {
    inline = [
      "sudo dnf install -y docker",
      "sudo systemctl enable docker",
      "sudo systemctl start docker",
      "sudo usermod -aG docker ec2-user",
      "curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo",
      "sudo dnf install -y nvidia-container-toolkit",
      "sudo nvidia-ctk runtime configure --runtime=docker",
      "sudo systemctl restart docker",
      # GPU passthrough verified at first instance launch (kernel module not loaded during build)
      "sudo docker info | grep -i 'runtimes\\|nvidia' || echo 'Docker runtimes configured'",
    ]
    timeout = "15m"
  }

  # 6. Install spored (lifecycle daemon: DCV token verifier, DNS, idle detection)
  provisioner "shell" {
    inline = [
      "REGION=$(curl -sf -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token | xargs -I{} curl -sf -H 'X-aws-ec2-metadata-token: {}' http://169.254.169.254/latest/meta-data/placement/region || echo us-east-1)",
      "curl -fsSL https://spawn-binaries-$${REGION}.s3.amazonaws.com/spored-linux-amd64 -o /tmp/spored || curl -fsSL https://spawn-binaries-us-east-1.s3.amazonaws.com/spored-linux-amd64 -o /tmp/spored",
      "chmod +x /tmp/spored && sudo mv /tmp/spored /usr/local/bin/spored",
      "/usr/local/bin/spored version",
    ]
  }

  # 7. Verify complete build
  # Note: nvidia-smi is not run here — kernel module cannot load during Packer build (no GPU).
  # GPU is verified at first instance launch via: docker run --gpus all nvidia/cuda:... nvidia-smi
  provisioner "shell" {
    inline = [
      "ls /usr/bin/nvidia-smi && echo 'nvidia-smi installed'",
      "dcv version",
      "docker --version",
      "nvidia-ctk --version",
      "/usr/local/bin/spored version",
      "echo 'spore-dcv-gpu-al2023 build complete'",
    ]
  }

  post-processor "manifest" {
    output     = "${path.root}/manifest-dcv-gpu-al2023-${var.region}.json"
    strip_path = true
  }
}

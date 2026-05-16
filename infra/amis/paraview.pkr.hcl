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

variable "base_ami" {
  type        = string
  description = "spore-dcv-gpu-al2023 AMI ID — build with dcv-gpu-al2023.pkr.hcl first"
  default     = ""
}

variable "paraview_version" {
  type    = string
  default = "5.13.2"
}

locals {
  pv_major_minor = join(".", slice(split(".", var.paraview_version), 0, 2))
  pv_archive     = "ParaView-${var.paraview_version}-MPI-Linux-Python3.10-x86_64.tar.gz"
  pv_url         = "https://www.paraview.org/files/v${local.pv_major_minor}/${local.pv_archive}"
  pv_dir         = "ParaView-${var.paraview_version}-MPI-Linux-Python3.10-x86_64"
}

source "amazon-ebs" "paraview" {
  region        = var.region
  source_ami    = var.base_ami
  instance_type = var.build_instance_type
  ssh_username  = "ec2-user"

  ami_name        = "spore-paraview-${var.paraview_version}-dcv-{{timestamp}}"
  ami_description = "spore.host: ParaView ${var.paraview_version} on DCV 2025.0 + NVIDIA 595 (AL2023)"

  tags = {
    "spore:app"         = "paraview"
    "spore:app-version" = var.paraview_version
    "spore:dcv-version" = "2025.0-20103"
    "spore:managed"     = "true"
    "spore:build-date"  = "{{timestamp}}"
  }

  # IMDSv2 required
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  # Base is already 40 GB; keep at 40 GB (ParaView Docker image ~3 GB fits)
  launch_block_device_mappings {
    device_name           = "/dev/xvda"
    volume_size           = 40
    volume_type           = "gp3"
    delete_on_termination = true
  }
}

build {
  name    = "spore-paraview"
  sources = ["source.amazon-ebs.paraview"]

  # Update spored from S3 so latest version is baked in
  provisioner "shell" {
    inline = [
      "REGION=$(curl -sf -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token | xargs -I{} curl -sf -H 'X-aws-ec2-metadata-token: {}' http://169.254.169.254/latest/meta-data/placement/region || echo us-east-1)",
      "curl -fsSL https://spawn-binaries-$${REGION}.s3.amazonaws.com/spored-linux-amd64 -o /tmp/spored && chmod +x /tmp/spored && sudo mv /tmp/spored /usr/local/bin/spored || true",
      "/usr/local/bin/spored version",
    ]
  }

  # Upload Dockerfile and build ParaView Docker image
  provisioner "file" {
    source      = "${path.root}/Dockerfile.paraview"
    destination = "/tmp/Dockerfile.paraview"
  }

  provisioner "shell" {
    inline = [
      "sudo docker build --build-arg PV_VERSION=${var.paraview_version} -f /tmp/Dockerfile.paraview -t spore-paraview:${var.paraview_version} /tmp/",
      "sudo docker images spore-paraview:${var.paraview_version}",
      "echo 'ParaView Docker image built and cached'",
    ]
    timeout = "20m"
  }

  # Create wrapper that runs ParaView in Docker using DCV's virtual display
  # Key: DCV 2025.0 init script runs concurrently with Xdcv startup.
  # We wait for the X11 socket, then build a host-network xauth file so
  # Docker's paraview user can connect to the DCV virtual display.
  provisioner "shell" {
    inline = [
      "sudo tee /usr/local/bin/start-paraview-dcv > /dev/null << 'WRAPPER'",
      "#!/bin/bash",
      "# Wait for X11 socket (Xdcv starts it as part of session init)",
      "for i in $(seq 1 30); do",
      "  [ -S /tmp/.X11-unix/X0 ] && break",
      "  sleep 1",
      "done",
      "# Wait for xauth file (created by Xdcv once display is ready)",
      "XAUTH=/run/user/1000/dcv/console.xauth",
      "for i in $(seq 1 10); do",
      "  [ -f \"$XAUTH\" ] && break",
      "  sleep 1",
      "done",
      "# Build a Docker-compatible xauth (--network=host requires matching hostname cookie)",
      "DOCKER_XAUTH=/tmp/paraview.xauth",
      "COOKIE=$(XAUTHORITY=$XAUTH xauth list 2>/dev/null | head -1 | awk '{print $3}')",
      "rm -f $DOCKER_XAUTH && touch $DOCKER_XAUTH",
      "xauth -f $DOCKER_XAUTH add 'localhost/unix:0' MIT-MAGIC-COOKIE-1 $COOKIE",
      "xauth -f $DOCKER_XAUTH add ':0' MIT-MAGIC-COOKIE-1 $COOKIE",
      "# Run ParaView in Ubuntu 22.04 container with GPU + DCV virtual display",
      "exec docker run --rm --gpus all --network=host \\",
      "  -e DISPLAY=:0 \\",
      "  -e XAUTHORITY=/tmp/.xauth \\",
      "  -v /tmp/.X11-unix:/tmp/.X11-unix \\",
      "  -v $DOCKER_XAUTH:/tmp/.xauth:ro \\",
      "  spore-paraview:${var.paraview_version}",
      "WRAPPER",
      "sudo chmod +x /usr/local/bin/start-paraview-dcv",
      "echo 'Docker wrapper script created'",
    ]
  }

  # Verify
  provisioner "shell" {
    inline = [
      "test -f /usr/local/bin/start-paraview-dcv && echo 'Wrapper script: OK'",
      "sudo docker images spore-paraview:${var.paraview_version}",
      "ls /usr/bin/nvidia-smi && echo 'nvidia-smi present (GPU verified at runtime)'",
      "echo 'ParaView build verification complete'",
    ]
  }

  post-processor "manifest" {
    output     = "${path.root}/manifest-paraview-${var.region}.json"
    strip_path = true
  }
}

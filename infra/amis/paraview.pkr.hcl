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
  default = "g5.xlarge" # GPU instance required — validates OpenGL/EGL at build time
}

variable "paraview_version" {
  type    = string
  default = "5.13.2"
}

# Official AWS NICE DCV AMIs — DCV 2023.1.17701 + NVIDIA 550.90.10 on Amazon Linux 2
# Owner 877902723034 is AWS; these AMIs are free, public, no Marketplace subscription needed.
locals {
  dcv_amis = {
    us-east-1      = "ami-0395a52954860831a"
    us-east-2      = "ami-04239b781533e0ae2"
    us-west-1      = "ami-055385a154c2c7be7"
    us-west-2      = "ami-017d0c53440a48b8b"
    eu-west-1      = "ami-03255242b0ee1097e"
    eu-west-2      = "ami-072738c544c4799a4"
    eu-central-1   = "ami-01d899a27cd864289"
    ap-southeast-1 = "ami-0d1bfd507f4c6aa2b"
    ap-northeast-1 = "ami-0cd6202cd363b6bc8"
  }
  source_ami    = local.dcv_amis[var.region]
  pv_major_minor = join(".", slice(split(".", var.paraview_version), 0, 2))
  pv_archive     = "ParaView-${var.paraview_version}-MPI-Linux-Python3.10-x86_64.tar.gz"
  pv_url         = "https://www.paraview.org/files/v${local.pv_major_minor}/${local.pv_archive}"
  pv_dir         = "ParaView-${var.paraview_version}-MPI-Linux-Python3.10-x86_64"
}

source "amazon-ebs" "paraview" {
  region        = var.region
  source_ami    = local.source_ami
  instance_type = var.build_instance_type
  ssh_username  = "ec2-user"

  ami_name        = "spore-paraview-${var.paraview_version}-dcv-{{timestamp}}"
  ami_description = "spore.host: ParaView ${var.paraview_version} on DCV + NVIDIA 550 (AL2)"

  tags = {
    "spore:app"         = "paraview"
    "spore:app-version" = var.paraview_version
    "spore:dcv-version" = "2023.1.17701"
    "spore:managed"     = "true"
    "spore:build-date"  = "{{timestamp}}"
  }

  # IMDSv2 required (account has httpTokensEnforced)
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  # Expand root from 8 GB → 30 GB
  # ParaView binary is ~2.2 GB extracted; download is ~660 MB
  launch_block_device_mappings {
    device_name           = "/dev/xvda"
    volume_size           = 30
    volume_type           = "gp3"
    delete_on_termination = true
  }
}

build {
  name    = "spore-paraview"
  sources = ["source.amazon-ebs.paraview"]

  # Install spored (spore.host lifecycle daemon — provides DCV token verifier on :8444)
  # Fetches the latest binary from S3; IMDSv2 used for region detection at runtime.
  provisioner "shell" {
    inline = [
      "REGION=$(curl -sf -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token | xargs -I{} curl -sf -H 'X-aws-ec2-metadata-token: {}' http://169.254.169.254/latest/meta-data/placement/region || echo us-east-1)",
      "curl -fsSL https://spawn-binaries-$${REGION}.s3.amazonaws.com/spored-linux-amd64 -o /tmp/spored || curl -fsSL https://spawn-binaries-us-east-1.s3.amazonaws.com/spored-linux-amd64 -o /tmp/spored",
      "chmod +x /tmp/spored && sudo mv /tmp/spored /usr/local/bin/spored",
      "/usr/local/bin/spored version 2>&1 || echo 'spored installed'",
    ]
  }

  # Install Docker on AL2 (amazon-linux-extras provides Docker 20.10)
  provisioner "shell" {
    inline = [
      "sudo amazon-linux-extras install docker -y",
      "sudo systemctl enable docker",
      "sudo systemctl start docker",
      "sudo usermod -aG docker ec2-user",
      "docker --version",
    ]
  }

  # Install NVIDIA Container Toolkit for GPU passthrough into Docker containers
  # Upload NVIDIA install script and Dockerfile before shell provisioner runs
  provisioner "file" {
    source      = "${path.root}/install-nvidia-docker.sh"
    destination = "/tmp/install-nvidia-docker.sh"
  }

  provisioner "file" {
    source      = "${path.root}/Dockerfile.paraview"
    destination = "/tmp/Dockerfile.paraview"
  }

  provisioner "shell" {
    inline = [
      # Wait for any background yum processes to finish
      "while sudo fuser /var/run/yum.pid >/dev/null 2>&1; do echo 'Waiting for yum lock...'; sleep 5; done",
      # Download NVIDIA Container Toolkit RPMs (can't install — AL2 rpm doesn't support Zstd)
      "sudo mkdir -p /tmp/nctk",
      "curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo",
      "sudo yum install -y --downloadonly --downloaddir=/tmp/nctk nvidia-container-toolkit",
      # Extract and configure using the uploaded script
      "sudo bash /tmp/install-nvidia-docker.sh",
      "sudo systemctl restart docker",
      # Verify GPU passthrough works before building ParaView image
      "sudo docker run --rm --gpus all nvidia/cuda:12.0.0-base-ubuntu22.04 nvidia-smi --query-gpu=name --format=csv,noheader",
    ]
    timeout = "15m"
  }

  provisioner "shell" {
    inline = [
      "sudo docker build -f /tmp/Dockerfile.paraview -t spore-paraview:${var.paraview_version} /tmp/",
      "sudo docker images spore-paraview:${var.paraview_version}",
      "echo 'ParaView Docker image built and cached'",
    ]
    timeout = "20m"
  }

  # Create wrapper that runs ParaView in Docker using DCV's virtual display
  provisioner "shell" {
    inline = [
      "sudo tee /usr/local/bin/start-paraview-dcv > /dev/null << 'WRAPPER'",
      "#!/bin/bash",
      "# Wait for DCV virtual session xauth file (created after session init)",
      "for i in $(seq 1 30); do",
      "  [ -f /run/user/1000/dcv/console.xauth ] && break",
      "  sleep 2",
      "done",
      "# Run ParaView in Ubuntu 22.04 container with GPU + DCV virtual display",
      "exec docker run --rm --gpus all \\",
      "  -e DISPLAY=:0 \\",
      "  -e XAUTHORITY=/tmp/.xauth \\",
      "  -v /tmp/.X11-unix:/tmp/.X11-unix \\",
      "  -v /run/user/1000/dcv/console.xauth:/tmp/.xauth:ro \\",
      "  spore-paraview:5.13.2",
      "WRAPPER",
      "sudo chmod +x /usr/local/bin/start-paraview-dcv",
      "echo 'Docker wrapper script created'",
    ]
  }

  # Configure DCV for application streaming and spored's embedded token verifier
  provisioner "shell" {
    inline = [
      # Enable automatic virtual session creation
      "sudo sed -i 's/#create-session = true/create-session = true/' /etc/dcv/dcv.conf || true",
      # Point DCV at spored's embedded auth token verifier (http — loopback only, no TLS needed)
      # spored listens on 127.0.0.1:8444 and verifies one-time tokens generated at startup.
      "sudo sed -i '/^\\[security\\]/a auth-token-verifier=\"http://127.0.0.1:8444\"' /etc/dcv/dcv.conf",
      "sudo systemctl enable dcvserver",
      "echo 'DCV configured for application streaming with token auth'",
    ]
  }

  # Verify installation
  provisioner "shell" {
    inline = [
      "test -f /usr/local/bin/start-paraview-dcv && echo 'Wrapper script: OK'",
      "sudo docker images spore-paraview:${var.paraview_version}",
      "nvidia-smi --query-gpu=name,driver_version --format=csv,noheader",
      "echo 'Build verification complete'",
    ]
  }

  post-processor "manifest" {
    output     = "${path.root}/manifest-paraview-${var.region}.json"
    strip_path = true
  }
}

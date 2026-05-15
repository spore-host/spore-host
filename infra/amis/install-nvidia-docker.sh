#!/bin/bash
set -e

# Extract NVIDIA Container Toolkit RPMs (already downloaded to /tmp/nctk/)
# rpm2cpio + cpio bypasses AL2's rpm which doesn't support Zstd compression
# used in nvidia-container-toolkit >= 1.14
for f in /tmp/nctk/*.rpm; do
  echo "Extracting $f"
  rpm2cpio "$f" | (cd / && cpio -idmu --no-absolute-filenames 2>/dev/null) || true
done

ldconfig

# Verify binaries landed correctly
echo "nvidia-container-runtime: $(which nvidia-container-runtime 2>/dev/null || find / -name nvidia-container-runtime -type f 2>/dev/null | head -1)"
echo "nvidia-ctk: $(which nvidia-ctk 2>/dev/null || find / -name nvidia-ctk -type f 2>/dev/null | head -1)"

# Ensure binaries are in PATH
for bin in nvidia-ctk nvidia-container-runtime nvidia-container-hook; do
  found=$(find /usr /opt -name "$bin" -type f 2>/dev/null | head -1)
  if [ -n "$found" ] && [ ! -f "/usr/bin/$bin" ]; then
    ln -sf "$found" "/usr/bin/$bin"
    echo "Linked $bin -> $found"
  fi
done

# Configure Docker to use NVIDIA runtime
mkdir -p /etc/docker
cat > /etc/docker/daemon.json << 'JSON'
{
  "default-runtime": "nvidia",
  "runtimes": {
    "nvidia": {
      "path": "/usr/bin/nvidia-container-runtime",
      "runtimeArgs": []
    }
  }
}
JSON

echo "NVIDIA Container Toolkit installed and Docker configured"

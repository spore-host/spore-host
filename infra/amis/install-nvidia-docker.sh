#!/bin/bash
set -e

# Extract NVIDIA Container Toolkit RPMs (already downloaded to /tmp/nctk/)
# rpm2cpio + cpio bypasses AL2's rpm which doesn't support Zstd compression
# used in nvidia-container-toolkit >= 1.14
# Check if rpm2cpio supports the RPMs (they use Zstd compression)
echo "Testing rpm2cpio on first RPM..."
FIRST_RPM=$(ls /tmp/nctk/*.rpm | head -1)
rpm2cpio "$FIRST_RPM" | wc -c
if [ $? -ne 0 ] || [ $(rpm2cpio "$FIRST_RPM" 2>/dev/null | wc -c) -eq 0 ]; then
  echo "rpm2cpio failed (likely Zstd), trying bsdtar..."
  yum install -y bsdtar 2>/dev/null || yum install -y libarchive 2>/dev/null
fi

for f in /tmp/nctk/*.rpm; do
  echo "Extracting $f"
  # Try bsdtar first (handles Zstd), fall back to rpm2cpio
  if command -v bsdtar >/dev/null 2>&1; then
    bsdtar -xf "$f" -C / 2>/dev/null || true
  else
    rpm2cpio "$f" | (cd / && cpio -idmu 2>/dev/null) || true
  fi
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

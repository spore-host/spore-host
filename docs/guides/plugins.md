# Plugins

Plugins extend instances at launch time — installing software, configuring services, or setting up data movement before your job starts. They run once during startup and are defined either in your launch command or in a config file.

## Using a plugin at launch

```sh
spawn launch \
  --name analysis \
  --instance-type r6i.4xlarge \
  --plugin rclone \
  --plugin-config rclone.remote=my-gdrive,rclone.path=/data \
  --ttl 8h
```

The `rclone` plugin installs rclone and configures the remote, so your data is mounted and ready before your job starts.

## Available plugins

| Plugin | What it does |
|--------|-------------|
| `rclone` | Mount cloud storage (Google Drive, Dropbox, S3, etc.) |
| `conda` | Install a Conda environment from an `environment.yml` |
| `pip` | Install Python packages from a `requirements.txt` |
| `r-packages` | Install R packages from a `packages.txt` |
| `docker` | Install Docker and pull specified images |
| `aws-cli` | Install/configure the AWS CLI |
| `s3-sync` | Sync an S3 prefix to a local path at startup |
| `efs-mount` | Mount an EFS filesystem (alternative to `--efs-id`) |

## Plugin configuration

Each plugin accepts key-value configuration:

```sh
# Sync S3 data before starting
spawn launch \
  --name training \
  --plugin s3-sync \
  --plugin-config "s3-sync.source=s3://my-bucket/datasets/imagenet,s3-sync.dest=/data/imagenet" \
  --command "python train.py --data /data/imagenet"
```

For complex configuration, use a YAML file:

```yaml
# launch.yaml
instance_type: p4d.24xlarge
ttl: 24h
plugins:
  - ref: s3-sync
    config:
      source: s3://my-bucket/datasets/imagenet
      dest: /data/imagenet
  - ref: conda
    config:
      environment_file: s3://my-bucket/envs/torch-2.yml
```

```sh
spawn launch --config launch.yaml --name training
```

## Writing a custom plugin

A plugin is a shell script with a standard interface. Create a file at `~/.spawn/plugins/my-plugin.sh`:

```sh
#!/bin/bash
# Plugin: my-setup
# Installs my custom analysis environment

set -euo pipefail

# Configuration is passed as environment variables
# PLUGIN_MY_SETUP_VERSION=${PLUGIN_MY_SETUP_VERSION:-latest}

apt-get install -y my-dependency
pip install my-package==${PLUGIN_MY_SETUP_VERSION:-latest}
```

Use it:

```sh
spawn launch \
  --plugin my-setup \
  --plugin-config "my-setup.version=2.1.0" \
  --ttl 8h
```

## Plugin registry

Custom plugins can be shared via a URL or Git repository:

```sh
spawn plugin install https://github.com/myorg/spawn-plugins/raw/main/bioinformatics.sh
spawn plugin install github.com/myorg/spawn-plugins/bioinformatics

# List installed plugins
spawn plugin list

# Remove a plugin
spawn plugin remove bioinformatics
```

## Data movement patterns

The most common use for plugins is getting data onto the instance before work starts and getting results off before it terminates.

**Pre-job data setup:**

```sh
spawn launch \
  --plugin s3-sync \
  --plugin-config "s3-sync.source=s3://my-bucket/input,s3-sync.dest=/data/input" \
  --pre-stop "aws s3 sync /data/output s3://my-bucket/output/" \
  --command "python process.py --input /data/input --output /data/output"
```

The `--pre-stop` hook syncs output to S3 before any shutdown — whether that's TTL expiry, idle stop, or Spot interruption.

**Using EFS for persistent shared storage:**

```sh
spawn launch \
  --name analysis \
  --efs-id fs-0abc123 \
  --efs-mount /shared \
  --command "python analyze.py --data /shared/datasets --output /shared/results"
```

Data written to `/shared` persists after the instance terminates and is accessible from other instances or a future launch.

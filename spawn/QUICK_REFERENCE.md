# spawn Quick Reference

**Quick command reference for spawn - EC2 instance launcher and parameter sweep orchestrator.**

## Installation

```bash
# Download latest release
curl -L https://github.com/spore-host/spore-host/releases/latest/download/spawn-$(uname -s)-$(uname -m) -o spawn
chmod +x spawn
sudo mv spawn /usr/local/bin/
```

## Launch Commands

### Basic Launch

```bash
# Simple launch
spawn launch --instance-type m7i.large --region us-east-1

# With TTL (auto-termination)
spawn launch --instance-type t3.medium --ttl 2h

# With idle timeout
spawn launch --instance-type t3.medium --idle-timeout 30m

# Spot instance
spawn launch --instance-type m7i.large --spot
```

### Parameter Sweeps

```bash
# Launch parameter sweep
spawn launch --params sweep.yaml

# Multi-region sweep
spawn launch --params sweep.yaml --regions us-east-1,us-west-2,eu-west-1

# With concurrency limits
spawn launch --params sweep.yaml --max-concurrent 10
spawn launch --params sweep.yaml --max-concurrent-per-region 5

# With staged data
spawn launch --params sweep.yaml --stage-id stage-20260123-140532
```

### Batch Queue Mode

```bash
# Launch sequential job pipeline
spawn launch --instance-type g5.2xlarge --batch-queue pipeline.json

# With spot instance
spawn launch --instance-type t3.medium --batch-queue jobs.json --spot
```

### Completion Signals

```bash
# Terminate when workload signals completion
spawn launch --on-complete terminate --ttl 4h

# Stop (preserve state) on completion
spawn launch --on-complete stop --ttl 8h

# Hibernate for cost savings
spawn launch --on-complete hibernate --ttl 12h
```

## Instance Management

### List Instances

```bash
# List all spawn-managed instances
spawn list

# Filter by region
spawn list --region us-east-1

# Filter by state
spawn list --state running
spawn list --state stopped

# Filter by instance type/family
spawn list --instance-type m7i.large
spawn list --family m7i

# Filter by tag
spawn list --tag env=prod
spawn list --tag Name=my-instance

# Combine filters
spawn list --region us-east-1 --state running --family m7i

# JSON/YAML output
spawn list --format json
spawn list --format yaml
```

### Extend TTL

```bash
# Extend by instance ID
spawn extend i-0123456789abcdef 2h

# Extend by instance name
spawn extend my-instance 1d

# Various time formats
spawn extend i-xxx 30m      # 30 minutes
spawn extend i-xxx 2h       # 2 hours
spawn extend i-xxx 1d       # 1 day
spawn extend i-xxx 3h30m    # 3 hours 30 minutes
```

### Connect (SSH)

```bash
# Connect by instance ID
spawn connect i-0123456789abcdef
spawn ssh i-0123456789abcdef  # Alias

# Connect by instance name
spawn connect my-instance
spawn ssh my-instance

# Custom user
spawn connect i-xxx --user ubuntu

# Custom port
spawn connect i-xxx --port 2222

# Force Session Manager
spawn connect i-xxx --session-manager

# Custom SSH key
spawn connect i-xxx --key ~/.ssh/my-key.pem
```

## Scheduled Executions

### Create Schedules

```bash
# One-time schedule
spawn schedule create params.yaml \
  --at "2026-01-24T02:00:00" \
  --timezone "America/New_York" \
  --name "nightly-training"

# Recurring schedule (cron)
spawn schedule create params.yaml \
  --cron "0 2 * * *" \
  --timezone "America/New_York" \
  --name "daily-sweep"

# With execution limits
spawn schedule create params.yaml \
  --cron "0 */6 * * *" \
  --max-executions 30

# With end date
spawn schedule create params.yaml \
  --cron "0 2 * * *" \
  --end-after "2026-03-01T00:00:00Z"
```

### Manage Schedules

```bash
# List all schedules
spawn schedule list
spawn schedule list --status active

# View schedule details
spawn schedule describe <schedule-id>

# Pause/resume
spawn schedule pause <schedule-id>
spawn schedule resume <schedule-id>

# Cancel (prevents future executions)
spawn schedule cancel <schedule-id>
```

### Common Cron Patterns

```
0 2 * * *       # Daily at 2 AM
0 */6 * * *     # Every 6 hours
0 0 * * 0       # Weekly on Sunday at midnight
0 9 * * 1-5     # Weekdays at 9 AM
*/30 * * * *    # Every 30 minutes
0 0 1 * *       # Monthly on the 1st at midnight
```

## Batch Job Queues

### Queue Status

```bash
# Check queue execution status
spawn queue status <instance-id>

# Monitor running queue
watch -n 10 spawn queue status i-0123456789abcdef
```

### Queue Results

```bash
# Download all results
spawn queue results <queue-id> --output ./results/

# Results are organized by job ID
# ./results/job1/stdout.log
# ./results/job1/stderr.log
# ./results/job1/output.txt
```

## Slurm Migration

### Convert Slurm Scripts

```bash
# Convert Slurm batch script to spawn parameters
spawn slurm convert job.sbatch --output params.yaml

# With cloud-specific overrides
spawn slurm convert job.sbatch --output params.yaml --spot

# Preview without saving
spawn slurm convert job.sbatch
```

### Cost Estimation

```bash
# Estimate cost for Slurm script
spawn slurm estimate job.sbatch

# With spot instances
spawn slurm estimate job.sbatch --spot

# Specific region
spawn slurm estimate job.sbatch --region us-east-1
```

### Submit Slurm Jobs

```bash
# Submit Slurm script directly
spawn slurm submit job.sbatch

# With spot instances
spawn slurm submit job.sbatch --spot

# To specific region
spawn slurm submit job.sbatch --region us-east-1
```

## Data Staging

### Upload Data

```bash
# Stage data to single region
spawn stage upload dataset.tar.gz /mnt/data/dataset.tar.gz

# Stage to multiple regions
spawn stage upload dataset.tar.gz /mnt/data/dataset.tar.gz \
  --regions us-east-1,us-west-2,eu-west-1

# With custom retention
spawn stage upload data.tar.gz /mnt/data/data.tar.gz \
  --retention 30
```

### List Staged Data

```bash
# List all staged datasets
spawn stage list

# List for specific region
spawn stage list --region us-east-1

# Show detailed information
spawn stage list --verbose
```

### Cost Estimation

```bash
# Estimate staging cost
spawn stage estimate dataset.tar.gz \
  --regions us-east-1,us-west-2 \
  --instances 20
```

### Delete Staged Data

```bash
# Delete staged dataset
spawn stage delete <stage-id>

# Delete from specific regions only
spawn stage delete <stage-id> --regions us-east-1,us-west-2
```

## Sweep Management

### Status and Monitoring

```bash
# Show sweep status
spawn status <sweep-id>

# Show detailed instance information
spawn status <sweep-id> --verbose

# Watch sweep progress
watch -n 10 spawn status <sweep-id>

# JSON output for automation
spawn status <sweep-id> --format json
```

### Logs

```bash
# Fetch logs from all instances
spawn logs <sweep-id>

# Fetch logs from specific instance
spawn logs <sweep-id> --instance-id i-0123456789abcdef

# Download logs to files
spawn logs <sweep-id> --output ./logs/
```

### Cancellation

```bash
# Cancel running sweep (terminates all instances)
spawn cancel <sweep-id>

# Cancel with confirmation prompt
spawn cancel <sweep-id> --confirm
```

## Parameter File Format

### Basic Sweep

```yaml
sweep_name: my-experiment
count: 10
regions:
  - us-east-1
  - us-west-2
instance_type: t3.medium
ami: ami-0c55b159cbfafe1f0

base_command: |
  #!/bin/bash
  python train.py --epochs 10

defaults:
  learning_rate: 0.001
  batch_size: 32

params:
  - model: resnet50
  - model: vgg16
  - model: inception
```

### With Staged Data

```yaml
sweep_name: training-with-data
stage_id: stage-20260123-140532
instance_type: g5.2xlarge

base_command: |
  #!/bin/bash
  python train.py \
    --data /mnt/staged-data/dataset.tar.gz \
    --model ${MODEL}

params:
  - model: resnet50
  - model: vgg16
```

### Concurrency Limits

```yaml
sweep_name: controlled-sweep
count: 100
max_concurrent: 20
max_concurrent_per_region: 8
launch_delay: 5s

regions:
  - us-east-1
  - us-west-2
  - eu-west-1
```

## Queue Configuration Format

### Basic Queue

```json
{
  "queue_id": "my-pipeline",
  "queue_name": "ML Training Pipeline",
  "jobs": [
    {
      "job_id": "preprocess",
      "command": "python preprocess.py",
      "timeout": "30m"
    },
    {
      "job_id": "train",
      "command": "python train.py",
      "timeout": "2h",
      "depends_on": ["preprocess"]
    },
    {
      "job_id": "evaluate",
      "command": "python evaluate.py",
      "timeout": "15m",
      "depends_on": ["train"]
    }
  ],
  "global_timeout": "4h",
  "on_failure": "stop"
}
```

### With Retry and Results

```json
{
  "queue_id": "robust-pipeline",
  "jobs": [
    {
      "job_id": "train",
      "command": "python train.py",
      "timeout": "2h",
      "retry": {
        "max_attempts": 3,
        "backoff": "exponential"
      },
      "env": {
        "CUDA_VISIBLE_DEVICES": "0",
        "TF_CPP_MIN_LOG_LEVEL": "2"
      },
      "result_paths": [
        "/tmp/model.h5",
        "/tmp/metrics.json"
      ]
    }
  ],
  "result_s3_bucket": "spawn-results-us-east-1",
  "result_s3_prefix": "queues/my-pipeline"
}
```

## Environment Variables

### AWS Configuration

```bash
# AWS profile
export AWS_PROFILE=spore-host-dev

# AWS region (override default)
export AWS_REGION=us-east-1

# AWS credentials (if not using profile)
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
```

### Spawn Configuration

```bash
# Default instance type
export SPAWN_INSTANCE_TYPE=t3.medium

# Default region
export SPAWN_REGION=us-east-1

# Default TTL
export SPAWN_TTL=2h
```

## Common Workflows

### ML Training Sweep

```bash
# 1. Stage training data
spawn stage upload dataset.tar.gz /mnt/data/dataset.tar.gz \
  --regions us-east-1,us-west-2

# 2. Create parameter file (sweep.yaml)
cat > sweep.yaml <<EOF
sweep_name: training-sweep
stage_id: <stage-id-from-step-1>
instance_type: g5.2xlarge
count: 12
regions: [us-east-1, us-west-2]

base_command: |
  #!/bin/bash
  tar -xzf /mnt/staged-data/dataset.tar.gz -C /tmp
  python train.py --data /tmp/dataset --lr \${LR} --bs \${BS}

params:
  - {lr: 0.001, bs: 32}
  - {lr: 0.001, bs: 64}
  - {lr: 0.01, bs: 32}
  - {lr: 0.01, bs: 64}
EOF

# 3. Launch sweep
spawn launch --params sweep.yaml --max-concurrent 6

# 4. Monitor progress
watch -n 10 spawn status <sweep-id>

# 5. Collect results
spawn logs <sweep-id> --output ./results/
```

### Scheduled Nightly Training

```bash
# 1. Create parameter file (nightly.yaml)
cat > nightly.yaml <<EOF
sweep_name: nightly-training
instance_type: g5.2xlarge
region: us-east-1
count: 8

base_command: |
  #!/bin/bash
  aws s3 sync s3://my-bucket/latest-data/ /tmp/data/
  python train.py --data /tmp/data --model \${MODEL}

params:
  - {model: resnet50}
  - {model: vgg16}
  - {model: inception}
EOF

# 2. Schedule for nightly execution at 2 AM
spawn schedule create nightly.yaml \
  --cron "0 2 * * *" \
  --timezone "America/New_York" \
  --name "nightly-training" \
  --max-executions 30

# 3. Monitor schedule
spawn schedule list
spawn schedule describe <schedule-id>
```

### Sequential ML Pipeline

```bash
# 1. Create queue file (pipeline.json)
cat > pipeline.json <<EOF
{
  "queue_id": "ml-pipeline",
  "jobs": [
    {
      "job_id": "preprocess",
      "command": "python preprocess.py --input data.csv --output processed.pkl",
      "timeout": "30m",
      "result_paths": ["/tmp/processed.pkl"]
    },
    {
      "job_id": "train",
      "command": "python train.py --data /tmp/processed.pkl --output model.h5",
      "timeout": "2h",
      "depends_on": ["preprocess"],
      "retry": {
        "max_attempts": 3,
        "backoff": "exponential"
      },
      "result_paths": ["/tmp/model.h5"]
    },
    {
      "job_id": "evaluate",
      "command": "python evaluate.py --model /tmp/model.h5 --output metrics.json",
      "timeout": "15m",
      "depends_on": ["train"],
      "result_paths": ["/tmp/metrics.json"]
    }
  ],
  "global_timeout": "4h",
  "on_failure": "stop",
  "result_s3_bucket": "spawn-results-us-east-1",
  "result_s3_prefix": "pipelines/ml-pipeline"
}
EOF

# 2. Launch pipeline
spawn launch --instance-type g5.2xlarge --batch-queue pipeline.json

# 3. Monitor execution
spawn queue status <instance-id>

# 4. Download results
spawn queue results ml-pipeline --output ./results/
```

### Slurm Migration

```bash
# 1. Convert existing Slurm script
spawn slurm convert array_job.sbatch --output params.yaml

# 2. Estimate cost
spawn slurm estimate array_job.sbatch --spot

# 3. Submit to cloud
spawn slurm submit array_job.sbatch --spot --regions us-east-1,us-west-2
```

## Troubleshooting

### Common Issues

```bash
# Check instance quota
aws service-quotas get-service-quota \
  --service-code ec2 \
  --quota-code L-1216C47A

# View CloudWatch logs
aws logs tail /aws/lambda/sweep-orchestrator --follow

# Check instance user-data
aws ec2 describe-instance-attribute \
  --instance-id i-xxx \
  --attribute userData \
  --query 'UserData.Value' \
  --output text | base64 -d

# View spored logs on instance
spawn ssh i-xxx
sudo journalctl -u spored -f
```

### Debug Mode

```bash
# Enable verbose logging
spawn launch --params sweep.yaml --verbose

# Show HTTP requests
spawn launch --params sweep.yaml --debug
```

## Documentation

- **README.md**: Complete feature overview and getting started
- **SLURM_GUIDE.md**: HPC cluster migration guide
- **DATA_STAGING_GUIDE.md**: Multi-region data distribution
- **SCHEDULED_EXECUTIONS_GUIDE.md**: Schedule management and cron syntax
- **BATCH_QUEUE_GUIDE.md**: Sequential job pipelines and dependencies
- **MPI_GUIDE.md**: Multi-node MPI job configuration
- **TROUBLESHOOTING.md**: Common issues and solutions
- **OPERATIONS_GUIDE.md**: Monitoring, alerts, and incident response
- **CHANGELOG.md**: Version history and release notes

## Support

- **GitHub Issues**: https://github.com/spore-host/spore-host/issues
- **Discussions**: https://github.com/spore-host/spore-host/discussions

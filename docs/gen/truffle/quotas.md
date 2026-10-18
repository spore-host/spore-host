## `truffle quotas`

Display current quotas, usage, and available capacity for EC2 and SageMaker instances.

Requires AWS credentials to be configured.

Checks your configured region by default: the spore config region, then
AWS_REGION / AWS_DEFAULT_REGION, then the AWS profile's region. Use --region /
--regions to choose. Only when no region is configured anywhere does it fall
back to us-east-1 (and says so). Service Quotas is a regional API, so nothing
here needs us-east-1.

Examples:
  # Show EC2 quotas for your configured region
  truffle quotas

  # Show quotas for specific regions
  truffle quotas --regions us-east-1,us-west-2

  # Show only GPU quotas
  truffle quotas --family P

  # Show SageMaker ml.* instance quotas
  truffle quotas --service sagemaker --regions us-west-2

  # Show SageMaker g5 quotas only
  truffle quotas --service sagemaker --family g5 --regions us-west-2

  # Generate quota increase requests
  truffle quotas --service sagemaker --family g5 --request

```
truffle quotas [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--family` |  | string |  | Filter by instance family (EC2: Standard/G/P/Inf/Trn; SageMaker: g5/p4d/etc.) |
| `--request` |  | bool |  | Generate quota increase request commands |
| `--service` |  | string | `ec2` | Service to query: ec2 (default) or sagemaker |


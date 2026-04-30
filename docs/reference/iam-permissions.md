# IAM Permissions

spore.host requires IAM permissions to launch, manage, and terminate EC2 instances. Use the minimal policy below and expand only as needed.

## Minimal policy

This policy covers core operations: launching instances, managing lifecycle, and querying state.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EC2Launch",
      "Effect": "Allow",
      "Action": [
        "ec2:RunInstances",
        "ec2:DescribeInstances",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeInstanceStatus",
        "ec2:DescribeImages",
        "ec2:DescribeSubnets",
        "ec2:DescribeVpcs",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeKeyPairs",
        "ec2:DescribeAvailabilityZones",
        "ec2:DescribeSpotPriceHistory",
        "ec2:DescribeServiceQuotas"
      ],
      "Resource": "*"
    },
    {
      "Sid": "EC2Manage",
      "Effect": "Allow",
      "Action": [
        "ec2:StartInstances",
        "ec2:StopInstances",
        "ec2:TerminateInstances",
        "ec2:CreateTags",
        "ec2:DeleteTags",
        "ec2:DescribeTags",
        "ec2:ModifyInstanceAttribute"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "ec2:ResourceTag/spawn:managed": "true"
        }
      }
    },
    {
      "Sid": "STS",
      "Effect": "Allow",
      "Action": ["sts:GetCallerIdentity"],
      "Resource": "*"
    }
  ]
}
```

::: tip Scope TerminateInstances
The condition on `EC2Manage` ensures you can only stop/terminate instances tagged `spawn:managed=true`. This prevents accidental termination of unrelated instances.
:::

## Spot instances

Add these actions to request Spot capacity:

```json
{
  "Action": [
    "ec2:RequestSpotInstances",
    "ec2:CancelSpotInstanceRequests",
    "ec2:DescribeSpotInstanceRequests"
  ]
}
```

## DNS integration

If you're using `--dns` (Route 53 subdomain assignment):

```json
{
  "Action": [
    "route53:ChangeResourceRecordSets",
    "route53:ListResourceRecordSets",
    "route53:GetHostedZone"
  ],
  "Resource": "arn:aws:route53:::hostedzone/YOUR_ZONE_ID"
}
```

## FSx for Lustre

For shared filesystem integration (`spawn launch --fsx`):

```json
{
  "Action": [
    "fsx:CreateFileSystem",
    "fsx:DeleteFileSystem",
    "fsx:DescribeFileSystems",
    "fsx:CreateDataRepositoryTask",
    "cloudformation:CreateStack",
    "cloudformation:DeleteStack",
    "cloudformation:DescribeStacks"
  ]
}
```

## Service quotas

truffle checks instance quotas before suggesting instance types. Add:

```json
{
  "Action": [
    "servicequotas:GetServiceQuota",
    "servicequotas:ListServiceQuotas"
  ],
  "Resource": "*"
}
```

## Quick setup

The easiest approach is to attach `PowerUserAccess` in development and tighten later:

```sh
# Attach the managed policy to your IAM user (development only)
aws iam attach-user-policy \
  --user-name your-iam-user \
  --policy-arn arn:aws:iam::aws:policy/PowerUserAccess
```

For production, use the minimal policy above with an IAM role and assume it via `AWS_PROFILE`.

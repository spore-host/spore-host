## `truffle list`

List available EC2 instance types, families, or sizes.

Queries one region: the first --region / --regions given, else your
configured region (the spore config region, then AWS_REGION /
AWS_DEFAULT_REGION, then the AWS profile's region). Only when no region is
configured anywhere does it fall back to us-east-1 (and says so). Most types
are offered everywhere, but some are region-limited, so the list is what you
can launch in that region.

Examples:
  truffle list
  truffle list --family
  truffle list --sizes
  truffle list --region us-west-2

```
truffle list [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--family` |  | bool |  | List instance families (e.g., m5, c5, r5) |
| `--sizes` |  | bool |  | List available sizes (e.g., large, xlarge, 2xlarge) |


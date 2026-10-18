---
description: "Task outputs record what they would cost to make again. spawn can report on that, tier cheap-to-regenerate outputs to cheaper storage, and let you keep anything you want kept."
---

# Keeping results: retention by regeneration cost

Results pile up. Most are cheap to make again, a few took a week of GPU time, and
in an S3 bucket they all cost the same to keep. spawn records what each task
output would cost to regenerate, so storage can follow from that: cheap outputs
move to cheaper storage on their own, expensive ones stay where they are, and you
can mark anything you want kept.

This guide covers what is recorded, how to read it, and how to turn tiering on.
The design and the decisions behind it are in
[spawn's design note](https://github.com/spore-host/spawn/blob/main/docs/recompute-tag-design.md).

::: tip What this does and doesn't do
Tiering only **moves** objects to cheaper S3 storage classes, which is
reversible. **Nothing is ever deleted.** Deleting outputs that can provably be
regenerated is planned as a separate, opt-in step, and doesn't exist yet.
:::

## What is recorded

Since spawn **v0.132.1**, every output of `spawn task run` (and of pooled task
workers) is uploaded with these tags, set in the same request as the upload:

| Tag | Example | Meaning |
|---|---|---|
| `spawn:regen-class` | `cheap` | `cheap` is under $1 **and** under 1 hour; `expensive` is $25 or more, **or** 12 hours or more; `moderate` is in between |
| `spawn:regen-usd` | `0.0500` | What the run cost, in USD |
| `spawn:regen-hours` | `0.5000` | How long it ran |
| `spawn:run-id` | `b3f…` | The run that wrote it |
| `spawn:retain` | `false` | Since v0.133.0. Every rule requires `false`; `true` keeps it out of all of them (set it with [`spawn results retain`](#keeping-outputs)) |
| `spawn:regenerable` | `true` | Only when the task spec opted in (see [below](#opting-in-to-future-deletion)) |

When the instance's hourly rate isn't known, there is **no class**, and an
unclassified output is never tiered. "We don't know what it cost" means kept,
never cheap.

Each output also carries an S3 **object annotation**, `spawn.provenance`, a JSON
record of how it was made:
- the command;
- the names (never the values) of its environment variables;
- the container image and the digest that actually ran;
- the AMI and instance type, and the spawn and spored versions;
- each input with the ETag and version it had when it was read;
- the cost, and where the rate came from (`spot`, `on-demand:live`, or
  `on-demand:static`).

The run's `completion.json` gets the same figure as `cost_estimate`.

Not covered:
- outputs written before v0.132.1;
- outputs of `spawn queue` and `spawn pipeline`;
- anything uploaded by other means.

These carry no tags and are kept. If an instance's spored can't do the tagged
upload, the output goes up untagged rather than not at all.

## See what you have: `spawn results retention`

A read-only report. By default it looks at this account's results bucket
(`spawn-results-<account>-<region>`); use `--bucket` and `--prefix` for task
outputs that went to your own bucket.

```sh
spawn results retention
spawn results retention --bucket my-lab-results --prefix project-x/ --objects
spawn results retention -o json
```

For each run it shows:
- what is stored and its monthly storage cost;
- what that would cost once the tiering rules had moved it, with the one-time
  request charge for the moves;
- whether the run could be **proven regenerable today**, with every reason it
  can't.

Proven means all of these hold:
- the spec opted in;
- the provenance record is readable;
- the recipe is pinned;
- every recorded input still exists with the same ETag and version.

An input you can't read counts as unproven, never as unchanged.

Objects with no `spawn:run-id` are listed as **untracked**: logs, completion
records and older outputs. They're kept.

## Turn on tiering: `spawn results lifecycle`

```sh
spawn results lifecycle            # dry run: the plan and what it costs
spawn results lifecycle --apply    # install the rules, then read them back to confirm
spawn results lifecycle --remove --apply   # take spawn's rules out again
```

It installs two S3 lifecycle rules:

| Rule | Matches | Moves to |
|---|---|---|
| `spawn-regen-cheap` | `spawn:regen-class=cheap` | Standard-IA at 30 days, Glacier Instant Retrieval at 90 |
| `spawn-regen-moderate` | `spawn:regen-class=moderate` | Standard-IA at 60 days |

Both rules also require `spawn:retain=false` and a size of at least 128 KiB. So
these are never moved:
- expensive and unclassified outputs;
- outputs you've marked to keep;
- outputs from before v0.133.0 (they have no `spawn:retain` tag);
- small files such as logs.

Glacier Instant Retrieval objects stay readable straight away, with no restore
step.

**Nothing installs the rules for you.** Creating a results bucket doesn't, and
neither does launching a task. Run `--apply` per account and region when you've
read a report and want it.

### It leaves the rest of the bucket alone

A bucket's lifecycle configuration is a single document that each write
replaces. So spawn:
- reads the existing configuration;
- changes only the rules whose ID starts `spawn-regen-`;
- writes every other rule back exactly as it was.

It also keeps the bucket's own transition minimum-size setting. Every call names
your account as the expected bucket owner, so a mistyped bucket name that belongs
to someone else fails instead of being changed.

::: warning Check your own rules
S3 applies **every** rule that matches an object. If the bucket already has a rule
that expires objects under some prefix, that rule still applies to spawn outputs
there. The dry run lists the bucket's other rules so you can check.
:::

### What tiering costs

The dry run prints these. They are AWS list prices for us-east-1, read from the
AWS Price List API, and **static**: truffle, spore.host's pricing source, prices
EC2 only. The date the prices were read is printed with them, and other regions
differ slightly.

- **Moving an object** is billed as a request: $0.01 per 1,000 objects into
  Standard-IA, $0.02 per 1,000 into Glacier Instant Retrieval.
- **Reading a tiered object back** costs $0.01/GB from Standard-IA and $0.03/GB
  from Glacier Instant Retrieval.
- **Minimum storage duration**: 30 days in Standard-IA and 90 in Glacier Instant
  Retrieval, billed in full if an object is deleted or moved on sooner.

S3 runs lifecycle rules about once a day, so objects move within a day or two of
reaching their age.

## On your own bucket

Most task outputs go wherever each spec's `outputs[].destination` points, which
is usually your own bucket, not spawn's. You can install the same rules there:

```sh
spawn results lifecycle --bucket my-lab-results            # dry run first
spawn results lifecycle --bucket my-lab-results --apply
```

spawn never does this on its own; you choose the bucket. Everything in the
previous section applies, including keeping your existing rules and the warning
about rules that expire objects.

If the bucket has **versioning** on, the rules move only the current version of
each object. Older versions stay where they are.

### Permissions

The identity running the commands needs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TieringRules",
      "Effect": "Allow",
      "Action": ["s3:GetLifecycleConfiguration", "s3:PutLifecycleConfiguration"],
      "Resource": "arn:aws:s3:::my-lab-results"
    },
    {
      "Sid": "ReportAndRetain",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::my-lab-results"
    },
    {
      "Sid": "ReportAndRetainObjects",
      "Effect": "Allow",
      "Action": [
        "s3:GetObjectTagging",
        "s3:GetObjectAnnotation",
        "s3:PutObjectTagging",
        "s3:PutObjectVersionTagging"
      ],
      "Resource": "arn:aws:s3:::my-lab-results/*"
    }
  ]
}
```

- `s3:PutLifecycleConfiguration` also covers removing the configuration.
- `s3:PutObjectVersionTagging` is needed only on a versioned bucket, where
  `spawn results retain` writes the tags of the exact version it read.
- For the report's input check, you also need `s3:GetObject` (and
  `s3:GetObjectVersion`) on the buckets your **inputs** came from. Without it,
  those inputs read as unproven, never as unchanged.

## Keeping outputs

```sh
spawn results retain s3://my-lab-results/project-x/final.bam     # one output
spawn results retain s3://my-lab-results/project-x/run-7/        # everything under a prefix
spawn results retain --off s3://my-lab-results/project-x/run-7/  # let the rules apply again
```

`spawn:retain=true` takes an output out of every tiering rule, and out of any
future deletion. `--off` sets it back to `false`.

::: warning Don't set the tag by hand
S3 replaces an object's **whole** tag set on every write.
`aws s3api put-object-tagging` with just `spawn:retain` would delete the
regeneration tags the rules match on. `spawn results retain` reads the existing
tags and writes them all back with only `spawn:retain` changed.
:::

It only changes spawn outputs, meaning objects tagged `spawn:run-id`. Anything
else under the prefix is listed and left alone.

### Older outputs

Outputs written by spawn v0.132.x have the regeneration tags but no
`spawn:retain`, so no rule matches them and they're kept. To let them be tiered,
opt them in:

```sh
spawn results retain --off s3://spawn-results-123456789012-us-east-1/outputs/
```

## Opting in to future deletion

Set `"regenerable": true` in a task spec to say its outputs may one day be
**deleted** once they can be proven regenerable. spawn records the opt-in only
when every input could be read at the start of the run, so the inputs can be
checked again later.

Nothing deletes outputs today. When the deletion step exists, it will be opt-in,
and it will re-check the inputs and recipe at deletion time, not trust the tag
written months earlier. `spawn results retention` already shows which runs would
pass that check now.

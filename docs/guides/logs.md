---
description: "spawn logs reads a spore's command log or spored log while it runs, and the failure log spored leaves on the serial console after it terminates."
---

# Logs and debugging: `spawn logs`

A spore's logs live on its own disk, so they go when it terminates. `spawn logs`
reads them while the instance is up. After it's gone, it reads what spored
copied to the serial console on the way out, which is enough to answer "why did
my job fail?".

This guide covers which logs there are, how `spawn logs` gets them, what's
left after termination, and spawn's own logs on your machine. For common
mistakes, see [Troubleshooting](/reference/troubleshooting).

## The logs on an instance

| Log | What's in it | Read it with |
|---|---|---|
| `/var/log/spawn-command.log` | The output of your `--command`, and the shell options it ran with | `spawn logs <name>` |
| `/var/log/spored.log` | spored, the lifecycle daemon: TTL, idle detection, completion, DNS registration | `spawn logs <name> --which spored` |
| The serial console | The boot output, and spored's copy of a failed command log | `spawn logs <name> --console`, once the instance has terminated |

`--which` takes only `command` and `spored`. For any other file on a live
instance, such as cloud-init's own log, open a shell with `spawn connect` and
read it there. The paths and the `tail` command `spawn logs` uses are Linux
ones.

## While the instance is running

```sh
spawn logs my-job                       # last 100 lines of the command log
spawn logs my-job --lines 500
spawn logs my-job --which spored        # spored's log instead
spawn logs i-0123456789abcdef0          # an instance ID works too
```

spawn runs `tail -n <lines>` on the instance:
- **over SSH**, with `sudo`, when the instance's key pair is on your machine;
- **over SSM** (`AWS-RunShellScript`, 60-second timeout) when it isn't, for
  example for keyless instances or ones another tool launched.

It's a one-off read, not a follow. Run it again to see newer lines.

If spawn finds the key but can't reach the instance over SSH, the command
fails; it doesn't retry over SSM.

The lookup searches every region for instances tagged `spawn:managed=true`.

A **stopped** instance counts as live, so `spawn logs` tries to reach it and
fails. Start it first with `spawn start`.

## After the instance has terminated

When a `--command` finishes on an instance launched with `--on-complete`,
spored checks the exit code. If the command **failed**, spored copies the last
50 lines of `/var/log/spawn-command.log` to the serial console before it acts on
`--on-complete`. EC2 keeps an instance's console output after it terminates, so
the failure reason outlives the disk.

Without `--on-complete`, spored doesn't act on the command finishing, so it
writes nothing to the console. The instance stays up until its TTL, and you can
read the log live.

`spawn logs` falls back to the console when it can't find the instance
running, pending, stopping or stopped:

```sh
spawn logs my-job                # the failed command's last 50 lines
spawn logs my-job --console      # the whole console dump, boot output included
spawn logs my-job --no-cache     # fetch again instead of using the local copy
```

It first prints the instance's state and why it changed, for example
`my-job (i-0123456789abcdef0) is terminated: User initiated (…)`. If you reuse a
name, it picks the most recent instance with that name.

**Allow about five minutes after termination.** The console capture isn't
available straight away. If you ask sooner, spawn says:

```
No log yet. The serial console capture takes about five minutes after
termination to appear, and this instance went away 1m12s ago — try again shortly.
```

If there's no block after that, spawn says there's no command log on the
console. That usually means the job **succeeded**, or there was no `--command`:
spored writes the block only for a failed command. `--console` shows the raw
boot output, which covers failures before the command started.

### What isn't kept

- **A successful command's log.** Only failures go to the console.
- **The `--lines` and `--which` choices.** They apply to live instances only.
  After termination you get the 50-line block spored wrote, or the whole console
  with `--console`. spored's own log isn't copied.
- **Instances that ended another way.** The block is written only when a
  `--command` fails and `--on-complete` is set. A TTL expiry, an idle stop, a Spot
  interruption or a terminate from outside spawn writes nothing. `--console`
  still has the boot output.
- **Long consoles.** EC2 caps console output at about 64 KB, so on a very long
  boot the block can be cut short. spawn prints whatever part of it is there.

### The local cache

Each console dump spawn fetches is saved in `~/.spawn/cache/console/<instance-id>.log`.
Repeat reads come from there, and spawn prints `(from the local cache)` when they
do. An empty dump is never saved, so an early "no log yet" doesn't get stuck.
Files older than 7 days are removed each time `spawn logs` runs. `--no-cache`
skips the cache and fetches again.

spawn still has to find the instance in EC2 before it looks in the cache. EC2
lists a terminated instance for only a while after it ends, and after that
`spawn logs` reports `no instance found matching "my-job", alive or recently
terminated`, even if a cached copy exists (spawn#1139). The file is plain text,
so you can read it directly:

```sh
cat ~/.spawn/cache/console/i-0123456789abcdef0.log
```

## Tasks, arrays and queues

- **`spawn task run`** uploads the command log to S3 when the task ends, including
  when a TTL, cost limit or idle stop ends it early. It goes to
  `<results prefix>/command.log`; by default that's
  `s3://spawn-results-<account>-<region>/tasks/<task-id>/command.log`. The task's
  `completion.json` lists it under `logs`. Read the record with
  `spawn task status <task-id>`, and get a summary of a task's state, cost and
  likely failure cause with `spawn task diagnose <name>`.
- **Job arrays:** `spawn array logs <array-name> --index <n>` reads one member's
  log. It takes the same `--which` values, and `--lines` defaults to 200. See
  [Job arrays](/guides/job-arrays).

## Permissions

| To | Your identity needs |
|---|---|
| Find the instance | `ec2:DescribeInstances`, `ec2:DescribeRegions` |
| Read a live log over SSM | `ssm:SendCommand` (the instance and the `AWS-RunShellScript` document), `ssm:GetCommandInvocation` |
| Read a terminated instance's console | `ec2:GetConsoleOutput` |

The SSM path also needs the instance to be registered with Systems Manager,
which spawn's instance role allows. The SSH path needs your key and a reachable
public IP. The [IAM baseline](/reference/iam-permissions) covers the first two
rows.

## spawn's own logs, on your machine

spawn keeps two files under `~/.spawn`, readable only by you:

| File | What's in it |
|---|---|
| `~/.spawn/audit.log` | One JSON record per security-sensitive operation, such as a launch, appended on every run. Records include your AWS account ID. |
| `~/.spawn/spawn.log` | Diagnostic lines from spawn's libraries, such as pricing lookups |

They're kept out of the terminal so they don't end up in screenshots and
screen recordings. `--verbose` (`-v`) also copies both to stderr:

```sh
spawn -v launch my-job --ttl 2h --command 'echo hello'
```

If `audit.log` can't be opened, audit records go to stderr instead of being
lost. Each file is created only when there's something to write to it.

`--verbose` also passes through the diagnostic lines older spored versions write
during `spawn status`, which spawn otherwise filters out.

## See also

- [Troubleshooting & common mistakes](/reference/troubleshooting), including why
  a failed `--command` doesn't keep the instance up.
- [Managing instances & data](/guides/managing-instances): `spawn status`,
  `spawn connect`, and what's left over.
- [Checking your account](/guides/account-health): `spawn doctor` before a first
  launch.

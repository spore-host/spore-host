---
description: "Instance plugins install and manage software on a running instance — connecting to a private network, mounting data transfer tooling, running a dev server."
---

# Instance plugins

**Instance plugins** install and manage software on a running instance —
connecting to a private network, mounting data transfer tooling, running a dev
server. A plugin is a declarative `plugin.yaml` spec describing lifecycle steps
(install, configure, start, health-check, stop) that spawn runs on the instance.

::: tip Not the same as a workflow-engine plugin
An *instance* plugin (this page) adds software to a machine. A *workflow-engine*
plugin — like the Nextflow `nf-spawn` executor — is a
[workflow adapter](/guides/workflow-engines) that plugs into an engine, not into an
instance. Different systems, despite both being called "plugins."
:::

::: warning Linux spores only
Plugin steps are POSIX shell, so spawn refuses to install a plugin on a Windows
spore (`spawn:os=windows`) before anything runs. `spawn launch` also rejects
`--plugin` and `--config` for a Windows launch.
:::

## Available plugins

The official registry lives at
[`spore-host/spore-plugins`](https://github.com/spore-host/spore-plugins). Each
plugin has a README with its setup steps:

| Plugin | What it does |
|--------|-------------|
| [`cloudwatch-agent`](https://github.com/spore-host/spore-plugins/tree/main/plugins/cloudwatch-agent) | Publish host metrics and a log file to CloudWatch |
| [`code-server`](https://github.com/spore-host/spore-plugins/tree/main/plugins/code-server) | VS Code in the browser |
| [`docker`](https://github.com/spore-host/spore-plugins/tree/main/plugins/docker) | Docker engine, with your login user in the `docker` group |
| [`github-actions-runner`](https://github.com/spore-host/spore-plugins/tree/main/plugins/github-actions-runner) | Register the instance as a self-hosted GitHub Actions runner |
| [`globus-personal-endpoint`](https://github.com/spore-host/spore-plugins/tree/main/plugins/globus-personal-endpoint) | High-speed data transfer via Globus Connect Personal |
| [`jupyterlab`](https://github.com/spore-host/spore-plugins/tree/main/plugins/jupyterlab) | Browser-based notebooks and Python |
| [`mountpoint-s3`](https://github.com/spore-host/spore-plugins/tree/main/plugins/mountpoint-s3) | Mount an S3 bucket as a local filesystem |
| [`rclone`](https://github.com/spore-host/spore-plugins/tree/main/plugins/rclone) | Mount one of your rclone remotes (config pushed from your machine) |
| [`rstudio-server`](https://github.com/spore-host/spore-plugins/tree/main/plugins/rstudio-server) | Browser-based R development environment |
| [`spore-sync`](https://github.com/spore-host/spore-plugins/tree/main/plugins/spore-sync) | Live bidirectional directory sync via mutagen |
| [`tailscale`](https://github.com/spore-host/spore-plugins/tree/main/plugins/tailscale) | Connect the instance to your Tailscale private network |
| [`vscode-tunnel`](https://github.com/spore-host/spore-plugins/tree/main/plugins/vscode-tunnel) | VS Code Remote Tunnel for desktop VS Code or vscode.dev |

## Finding a plugin

`spawn plugin search` and `spawn plugin info` read the registry's generated
index. It is cached locally, so they work offline, and the output shows how old
the listing is. Neither contacts an instance.

```sh
spawn plugin search              # everything in the registry
spawn plugin search jupyter      # match names and descriptions
spawn plugin search --refresh    # bypass the cache
spawn plugin info tailscale      # version, description, config, declared permissions
```

`search` lists what exists. For what is installed on an instance, use
`spawn plugin list --instance <id>`.

## Trust & permissions

::: warning Installing a plugin runs its author's code
A plugin can run commands **on your local machine** (the controller) and, on the
EC2 instance, **as root**. Installing one is equivalent to running code from its
author in both places. Inspect a plugin before installing it, especially a
third-party `github:` one.
:::

### What a ref resolves to

- `name` — an official registry plugin, resolved to its **latest signed
  release** (the highest non-prerelease `<name>-<version>` release tag). If spawn
  can't find a release, or can't reach the GitHub API to look, it refuses rather
  than fall back to the unverified `main` branch.
- `name@version` — a specific official release. The version is the part of the
  release tag after the plugin name, so `rstudio-server@v1.1.0` is the tag
  `rstudio-server-v1.1.0`.
- `github:org/repo/name[@ref]` — a plugin from any GitHub repo. The `@ref` is a
  git ref (tag, branch, or commit); pin to a **tag or commit** so the definition
  can't change under you. A bare `github:` ref (no `@`) tracks the default branch
  and can move. These are **not** signature-verified.
- `./path.yaml` — a local file, for development.

### Signature verification

Each official release carries a checksum manifest and a Sigstore signature over
it. For an official ref, spawn fetches `plugin.yaml` at the release tag, checks
its sha256 against the manifest, and verifies the signature was made by the
registry's own release workflow (`spore-host/spore-plugins`, `release.yml`). A
missing manifest, a checksum mismatch, a missing signature, or a signature from
any other identity is a hard failure.

`--insecure` turns those failures into warnings. It exists for local development
against unreleased plugins; don't use it otherwise.

### Inspect before you install

```sh
spawn plugin inspect tailscale
spawn plugin install tailscale --dry-run    # same preview; needs no --instance
```

Both resolve the ref (with the same verification) and print the plan without
running anything or contacting an instance: the resolved source and version,
local steps vs remote steps, the controller environment the plugin requests,
which remote steps run as root and which as your login user, downloads, health
checks, cleanup, and the plugin's declared `permissions:` block.

Two more things limit what a plugin can reach:

- **Local steps run with a minimal environment.** A plugin's controller-side steps
  see only `PATH` + `HOME` unless the plugin allowlists variables via
  `env_passthrough` (see the [field reference](#plugin-yaml-field-reference)). So a
  plugin can't silently pick up your AWS or other credentials — it must name each
  variable it needs (e.g. Tailscale's `TS_API_CLIENT_SECRET`), and `inspect` shows
  that list.
- **`spawn plugin validate`** statically checks a spec offline (schema, semver,
  step/condition types, undeclared template refs) without contacting AWS or an
  instance.

The `permissions:` block is declared by the plugin's author, not a sandbox.
spawn checks that it doesn't understate `env_passthrough`, and the registry's CI
checks it against the steps (for example, `instance.root: false` with a step
that runs as root fails). It does not stop a step from doing more.

## Installing a plugin

Install onto a running instance with `spawn plugin install <ref>`:

```sh
# From the official registry, by name (latest signed release).
# tailscale mints a short-lived key from your OAuth client, so you pass the ACL
# tag as config and the OAuth client via env — not a raw auth key.
export TS_API_CLIENT_ID=...  TS_API_CLIENT_SECRET=...
spawn plugin install tailscale --instance my-job --config tag=tag:spore

# Pin to a specific release
spawn plugin install rstudio-server@v1.1.0 --instance my-job

# From any GitHub repo
spawn plugin install github:myorg/my-plugins/my-tool@v1.0.0 --instance my-job

# From a local file (development)
spawn plugin install ./my-plugin.yaml --instance my-job
```

Per-plugin configuration is passed with repeatable `--config key=value` pairs.
`install` connects over SSH; pass `--key` and `--user` if the defaults don't fit.

Manage installed plugins:

```sh
spawn plugin list --instance my-job        # what's installed
spawn plugin status tailscale --instance my-job
spawn plugin remove tailscale --instance my-job
```

## Installing at launch

Declare plugins to install during startup with `--plugin` (repeatable; takes a
`ref[@version]`):

```sh
spawn launch analysis --instance-type r6i.4xlarge --plugin rstudio-server --ttl 8h
```

For per-plugin config, put the plugins in a file and pass it with `--config`.
Each entry takes `ref` and an optional `config` map:

```yaml
# launch.yaml
plugins:
  - ref: tailscale
    config:
      tag: tag:spore   # OAuth client via TS_API_CLIENT_ID/SECRET env (see above)
```

```sh
spawn launch analysis --instance-type r6i.4xlarge --ttl 8h --config launch.yaml
```

`spawn launch --config` reads only the `plugins:` list. Set the instance type,
TTL and everything else with flags; other keys in the file are ignored. An entry
written as `name:` instead of `ref:` is ignored too, so nothing installs.

## Writing a plugin

A plugin is a `plugin.yaml` file declaring lifecycle steps. Minimal example:

```yaml
name: my-tool                # must match the directory name
version: v1.0.0              # semver
description: "Install and run my-tool"

config:
  api_key:
    type: string             # string | int | bool
    required: true           # a required parameter can't also have a default

permissions:                 # declared capability surface (see below)
  instance:
    root: true
    network: true

conditions:
  remote:
    - type: platform         # command | platform
      os: linux

remote:                      # steps run on the instance
  install:                   # phases: install, configure, start, stop, health
    - type: run              # remote step types: run | fetch | extract
      run: curl -fsSL https://example.com/install.sh | sh
  start:
    - type: run
      run: my-tool serve --key={{ config.api_key }}
  health:
    interval: 30s
    steps:
      - type: run
        run: my-tool status
```

Template references in the `config`, `instance`, `outputs`, and `pushed`
namespaces (for example `config.api_key` or `instance.name`, written in double
braces) are substituted at run time. See
[AUTHORING.md](https://github.com/spore-host/spore-plugins/blob/main/AUTHORING.md)
for the full guide, including controller-side `local` steps and the `push` API
for moving captured values to the instance.

### `plugin.yaml` field reference

**Top level:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Required. Plugin id: letters, digits, `-` and `_`, up to 64 characters. In the registry it must match the directory name. |
| `version` | string | Required. SemVer (e.g. `v1.0.0`). |
| `description` | string | Required. One-line summary, shown and matched by `spawn plugin search`. |
| `config` | map | User-supplied parameters, keyed by name (see below). |
| `permissions` | block | Declared capability surface (see below). Optional for `spawn plugin validate`, required by `validate --strict`, which the registry's CI runs. |
| `conditions` | block | `local` / `remote` lists of preconditions checked before running. |
| `local` | block | Steps that run on **your machine** (the controller). |
| `remote` | block | Steps that run on **the instance**. |
| `outputs` | map | Output names, keyed by name (see [Outputs](#outputs)). |

spawn ignores any other top-level key. The registry's specs carry `author` and
`license` as metadata.

**`config.<name>` (a parameter):**

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `string`, `int`, or `bool`. |
| `required` | bool | Fail if the user didn't supply it. |
| `default` | any | Value used when unset. Setting both `required: true` and a `default` fails validation. |

spawn doesn't read a `description` here; it's fine as a note to readers of the
spec, but nothing displays it. A `--config` key the spec doesn't declare is
still passed through to the templates.

**`permissions`:**

| Field | Type | Description |
|-------|------|-------------|
| `controller.env` | list | Controller environment variables the plugin reads. Must include every name in `local.env_passthrough`. |
| `controller.network` | bool | Local steps make network calls. |
| `controller.commands` | list | Executables the plugin expects on your `PATH` (e.g. `jq`). |
| `instance.root` | bool | Some remote step runs as root. `false` means every remote step is an `as_user` `run` step. |
| `instance.network` | bool | Remote steps make network calls. `false` means no `fetch` step. |
| `instance.ports` | list | TCP ports the plugin listens on (1–65535). |
| `instance.files` | list | Notable paths the plugin creates or manages. |

`inspect` and `info` show this block; `search` flags `instance.root` as
`[root]`. A spec without it shows as "not declared", not as "needs nothing".

**`conditions.local[]` / `conditions.remote[]`:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `command` (a probe command must succeed) or `platform`. |
| `run` | string | Command to run for `type: command`. |
| `os` | string | Required OS for `type: platform` (e.g. `linux`). |
| `message` | string | Shown when the condition fails. |

**`remote` phases:** `install`, `configure`, `start`, `stop`, each a list of
[steps](#step-fields); plus `health` (`interval` + `steps`) for the recurring
health-check loop.

**`local` block:** `provision`, `deprovision`, and `reconcile` (re-run when the
instance's IP changes after a stop/start) step lists, plus `env_passthrough` — the
allowlist of controller env vars a local step may read. Local steps otherwise run
with a minimal environment (`PATH`+`HOME` only) so plugin scripts can't pick up
your AWS/other credentials; a plugin that needs a controller-side secret (e.g.
Tailscale's `TS_API_CLIENT_SECRET`) lists it here and spawn injects only those.

#### Step fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `run`, `fetch`, `extract`, or `push`. |
| `run` | string | Shell command (`type: run`), run with `sh -c`. |
| `url` / `dest` | string | Download source / destination (`type: fetch`). |
| `sha256` | string | Expected sha256 of a `fetch` download, 64 lowercase hex characters. On a mismatch the install fails. Only valid on `fetch`. |
| `src` / `dest` | string | Archive path / target dir (`type: extract`). |
| `key` / `value` | string | Name and value to push to the instance (`type: push`), read there as `pushed.<key>`. |
| `background` | bool | Start the command detached (`nohup`) and don't wait, e.g. a long-lived server. |
| `capture` | map | `varname` → dotted path into the step's JSON stdout (e.g. `key` or `.data.id`); the value becomes `outputs.<varname>`. |
| `env` | map | Extra environment variables for this step. Values are not templated. |
| `as_user` | bool | Run a remote `run` step as the instance's login user, not root (for tools that refuse root, e.g. Globus Connect Personal). |

Where each step type and field works:

- **Local only:** `push`, and `capture`. A `push` runs only in
  `local.provision`; `deprovision` and `reconcile` run `run` steps only.
  `capture` is read only in `local.provision`.
- **Remote only:** `fetch`, `extract`, `background`, `as_user`. `spawn plugin
  validate` rejects a `fetch` or `extract` step in `local`, and a `push` in
  `remote`. `background` and `as_user` on a local step are ignored.

#### Template variables

| Variable | Value |
|----------|-------|
| `instance.id` | EC2 instance ID |
| `instance.name` | The instance's Name tag |
| `instance.ip` | Public IP |
| `instance.login_user` | The instance's login user (the user `as_user` steps run as). Remote steps only. |
| `config.<key>` | A config parameter |
| `outputs.<key>` | A value captured by an earlier local step. Local steps only. |
| `pushed.<key>` | A value delivered by a `push` step. Remote steps only. |

Write them in double braces with spaces, as in the example above. Any other form
(such as Go's `.Config.key`) fails validation, and a reference to an undeclared
config key fails too.

In `run` steps and `command` conditions, every substituted value is
**shell-quoted** (wrapped in single quotes) so a value can't inject shell syntax.
That works for a bare word or an assignment, but adds literal quote characters
inside a larger string. Assign the value to a shell variable first and use the
variable:

```yaml
- type: run
  run: |
    NAME={{ instance.id }}
    DESC="spore-$NAME"
```

`url`, `dest`, `src` and push `value` fields are substituted without quoting.

#### Outputs

The `outputs:` block names the values a plugin produces. Each entry takes one
field, `source`: `local_capture` (captured by a `local` step) or `pushed`
(delivered via the push API). `spawn plugin inspect` lists them with their source.

```yaml
outputs:
  endpoint_id:
    source: local_capture
```

::: info Outputs aren't reported yet
spawn doesn't surface output values after install today: `spawn plugin status`
shows the plugin's name, version, state, last health check and source, not its
outputs ([spawn#1117](https://github.com/spore-host/spawn/issues/1117)). If a
user needs a value, such as a URL, print it from a step or document how to read
it in the plugin's README.
:::

### Validate before you ship

Lint a spec offline (no instance, no AWS) with `spawn plugin validate`:

```sh
spawn plugin validate ./my-tool/plugin.yaml
spawn plugin validate --strict plugins/*/plugin.yaml   # what the registry's CI runs
```

It checks schema, semver, that the directory matches the plugin name, that step
and condition types are valid for their context, that templates are well formed,
and that every config template reference points at a declared parameter.
`--strict` also requires a `permissions:` block and checks it against the steps.

## Contributing to the registry

Open a PR against [`spore-host/spore-plugins`](https://github.com/spore-host/spore-plugins)
adding `plugins/<name>/plugin.yaml` and a README. CI validates the spec with
`validate --strict` on every PR. The registry also has a gated integration
workflow (manual or nightly) meant to install plugins on a real instance, but it
hasn't run since June 2026
([spore-plugins#29](https://github.com/spore-host/spore-plugins/issues/29)), so
install your plugin on an instance yourself before opening the PR.

## Data movement patterns

A common companion to plugins is moving data on and off the instance around your
job. The `--pre-stop` hook syncs results out before any shutdown — TTL expiry,
idle stop, or Spot interruption. The instance can only write to your bucket if
you grant it with `--s3-write`:

```sh
spawn launch process --instance-type r7i.4xlarge --ttl 8h \
  --s3-write my-bucket \
  --pre-stop "aws s3 sync /data/output s3://my-bucket/output/" \
  --command "python process.py --input /data/input --output /data/output"
```

For persistent shared storage across instances, mount EFS:

```sh
spawn launch analysis --efs-id fs-0abc123 --efs-mount-point /shared \
  --command "python analyze.py --data /shared/datasets --output /shared/results"
```

Data written to `/shared` persists after the instance terminates.

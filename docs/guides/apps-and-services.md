---
description: "Run a GUI application, a Linux desktop or a web app on EC2 and open it in your browser with spawn app, or run your own long-lived HTTP service behind a private tunnel with spawn service."
---

# GUI apps and services: `spawn app` and `spawn service`

Some work needs a screen rather than a batch job: rotating a mesh in ParaView,
paging through a genome in IGV, cleaning a spreadsheet in OpenRefine, or poking
at a dashboard you wrote. spawn has two commands for this.

- **`spawn app`** launches an application from a catalog and opens it in your
  browser. A desktop application is streamed over
  [Amazon DCV](https://aws.amazon.com/hpc/dcv/), so you don't need a VNC or RDP
  client. An app with its own web UI, such as Jupyter or code-server, is served
  over HTTPS.
- **`spawn service`** runs *your* HTTP service on an instance and forwards a
  local port to it over SSH. The service is never exposed to the internet, and
  the instance is terminated when you stop.

This guide covers both, as of spawn **v0.135.0**. For the complete flag lists,
run `spawn app launch --help` and `spawn service --help`.

::: tip Which one do I want?
If the thing you want is already in `spawn app list`, or it ships as a container
image, use `spawn app`. If it's a program you wrote that serves HTTP and you only
want to reach it from your own machine, use `spawn service`. If you want a
long-running notebook server on an instance you manage yourself, see
[Interactive workstation](/guides/jupyter).
:::

## `spawn app`

`spawn app` has two subcommands:

| Command | What it does |
|---|---|
| `spawn app list` | Lists the catalog apps your account can launch, and the ones that need an image first |
| `spawn app launch <app-name>` | Launches one app and opens it in your browser |

Both take `--catalog <file>`, which points at a local catalog overlay (see
[Bring your own app](#bring-your-own-app)).

### Three kinds of app

Every catalog entry has a `kind`, which decides how it reaches your browser:

| Kind | What you get | How it's served | Port opened |
|---|---|---|---|
| `application` *(default)* | A single Linux GUI app, full-screen | An Amazon DCV virtual session; the app runs in a container drawing to the session's display | 8443 (TCP and UDP) |
| `desktop` | A bare Linux desktop (GNOME, falling back to a window manager and `xterm`) | An Amazon DCV virtual session | 8443 (TCP and UDP) |
| `web` | An app that serves its own web UI | The app's container listens on the instance's loopback; spored puts a TLS reverse proxy in front of it on 443. No DCV | 443 |

Port 22 is open as well, for SSH. Both kinds of security group allow
those ports from anywhere (`0.0.0.0/0` and `::/0`), so the access token, not the
network, is what keeps others out (see [Connecting](#connecting)). The security
groups are named `spawn-dcv` and `spawn-web`, and `spawn app launch` creates them
in the region's **default VPC**. It has no subnet or security-group flags, so a
region without a default VPC can't run `spawn app`.

### The built-in catalog

This is the catalog that ships inside spawn v0.135.0 (it comes from
`github.com/spore-host/libs` v0.51.1). `spawn app list` prints it, filtered for
your account:

```sh
spawn app list
```

| Name | Aliases | Kind | What it is | Default instance | Idle timeout | Status |
|---|---|---|---|---|---|---|
| `code-server` | `vscode` | web (port 8080) | VS Code in the browser | `c7i.xlarge` | 30m | launchable |
| `jupyter` | `jupyterlab`, `notebook` | web (port 8888) | JupyterLab | `c7i.xlarge` | 30m | launchable |
| `openrefine` | `refine` | web (port 3333) | OpenRefine 3.10.1, data cleaning | `c7i.xlarge` | 30m | launchable |
| `desktop` | `workspace` | desktop | A bare Linux desktop over DCV | `c7i.xlarge` | 30m | launchable |
| `paraview` | `pv` | application, GPU | Scientific visualization (CFD, FEA, large meshes) | `g6.xlarge` | 20m | recipe available |
| `chimerax` | `chimera` | application, GPU | UCSF ChimeraX, protein structure and cryo-EM | `g6.xlarge` | 20m | recipe available |
| `igv` | | application | Integrative Genomics Viewer | `c7i.xlarge` | 30m | recipe available |
| `qgis` | | application | GIS, remote sensing, ecology | `c7i.xlarge` | 30m | recipe available |
| `fiji` | `imagej` | application | ImageJ/Fiji image analysis | `c7i.xlarge` | 30m | recipe available |
| `ds9` | | application | SAO DS9 astronomical image display | `c7i.xlarge` | 30m | recipe available |

The default instance is the first family in the entry's `instance_families`
with `.xlarge` appended. Override it with `--instance-type`.

**Only the first four launch out of the box.** The `STATUS` column means:

- **launchable**: the app has an image your account can pull, or it's the
  `desktop`, which needs no image.
- **recipe available**: spore.host ships the app's *definition* (hardware,
  aliases, idle timeout) but not a container image. You build the image, then
  bind it (see [Bring your own app](#bring-your-own-app)). Until you do,
  `spawn app launch paraview` stops before launching anything:

  ```text
  no image configured for paraview — supply one with --image <ref>, or add a binding to ~/.spawn/catalog.yaml (see 'spawn app list')
  ```

  `igv`, `qgis`, `fiji` and `ds9` are in the same state. Their entries still
  name a binary path from the retired per-app AMIs, which no longer exist, so
  spawn refuses them rather than booting an instance that can't start the app.
- **hidden**: an app bound to a private ECR image owned by a different AWS
  account doesn't appear at all.

With no AWS credentials, `spawn app list` still works and shows the public
catalog. It prints a table only; `-o json` has no effect on it.

### Launching

```sh
spawn app launch jupyter --ttl 4h
spawn app launch desktop --ttl 2h
spawn app launch code-server --instance-type m7i.2xlarge --ttl 8h --spot
```

`spawn app launch` has no `--dry-run`. Every run launches a billable instance.

What happens, in order:

1. spawn looks the name up (aliases work) and checks `--ttl` and the idle timeout
   before any AWS call.
2. It picks the base image through AWS's public SSM parameters: the GPU Deep
   Learning Base AMI (Amazon Linux 2023, NVIDIA driver installed) for a GPU
   instance type, or standard Amazon Linux 2023 otherwise. There's no spore.host
   AMI to build or share. A catalog entry can pin its own AMI per region with
   `base_amis:`.
3. It imports your SSH key, sets up the spored instance role, and creates or
   reuses the security group.
4. It launches with a 100 GiB root volume (more if the AMI needs it). On boot
   the instance installs a verified spored. A DCV instance also installs Amazon
   DCV and pulls the app image. A web app's instance installs Docker if needed
   and starts the container.
5. spawn polls for up to **5 minutes** until spored reports the app ready, then
   opens it in your browser.

| Flag | Default | Notes |
|---|---|---|
| `--instance-type` | first catalog family + `.xlarge` | |
| `--region` | your AWS config, else `us-east-1` | |
| `--name` | `<app>-<unix-timestamp>` | Also becomes the instance's DNS name |
| `--ttl` | `8h` | Hard deadline: the instance is **terminated**. Always set; an empty `--ttl ""` is refused. See [Lifecycle](#lifecycle) |
| `--idle-timeout` | the catalog's `idle_timeout_default` | The instance is **stopped** when idle this long |
| `--spot` | off | Spot pricing |
| `--app-version` | catalog `tag_default` | Image tag; must be `tag_default` or one of `tags_available` |
| `--image` | | Use your own image for this app (see [below](#launch-with-image)) |
| `--web-port` | | Treat `--image` as a web app on this container port |
| `--health-path` | `/` | Readiness path for a web app. **Only used together with `--web-port`** |
| `--web-arg` | | Extra container argument for a web app; repeatable |
| `--no-web-auth` | off | Turn off the access-token gate on a web app. The app must then do its own auth |
| `--no-open` | off | Write the session file or print the URL, but don't open a browser |

For a web app, any `--web-arg` values go after the catalog's own `args`. For
example, `code-server` already runs with `--bind-addr 0.0.0.0:8080 --auth none`.

### Connecting

**A DCV app or desktop.** When spored has created the session, it issues a
one-time token and tags the instance with the session URL
(`https://<host>:8443/?authToken=…#console`). spawn writes a small launcher page
to `~/.spawn/sessions/<app>-<id>.html` and opens it, and the page redirects into
DCV's own browser client with the token. The instance has a DNS name under
`spore.host` when DNS registration succeeds; otherwise the URL uses the public
IP.

```text
✅  jupyter is ready
   URL:       https://jupyter-1760790000.<account>.spore.host/?spore_token=…
   Instance:  i-0123456789abcdef0
   Reconnect: spawn connect i-0123456789abcdef0
```

**A web app.** spawn prints the `https://<host>/?spore_token=…` URL, as above, and
opens it. The proxy swaps the token for a `Secure`, `HttpOnly` cookie and drops
it from the address bar. A request with neither the token nor the cookie gets a
**403**. That's why the built-in web apps run with their own login switched off:
the proxy token is the access control. `--no-web-auth` removes the gate.

**Later.** `spawn connect <instance-id>` reconnects to a DCV instance. If the
instance was stopped for being idle, `spawn connect` starts it again, waits for a
fresh token, and reopens the session page. With neither a session file nor a
session URL to go on, it opens DCV at the instance's own DNS name, built from its
`spawn:dns-name`, `spawn:account-id` (or `spawn:account-base36`) and
`spawn:dns-domain` tags, so a [custom DNS domain](/guides/custom-dns) works too.
An instance with no DNS name is opened at its public IP. (Before spawn v0.136.0 that fallback pointed at a host in another
account.) For a web app, `spawn connect` opens an SSH shell, not the browser.

::: warning The "Reconnect" line after a DCV launch starts a new instance (spawn#1153)
After a DCV app or desktop is ready, spawn prints
`Reconnect: spawn app launch <app> --name <session>`. That command doesn't
reconnect: it launches a **second instance**. To get back to an existing session,
use `spawn connect <instance-id>`, or open the session file under
`~/.spawn/sessions/` again.
:::

**TLS.** The instance looks for a wildcard certificate for your account's
`spore.host` subdomain at boot. If none has been provisioned, DCV falls back to
a self-signed certificate (your browser warns), and a web app fails with
`web-proxy-failed` because the proxy has nothing to serve.

### When a launch doesn't become ready

spored reports *why* a launch failed, and spawn stops polling as soon as it does,
rather than waiting out the 5 minutes:

| Status | Meaning | Where to look |
|---|---|---|
| `dcv-not-installed` | The boot-time DCV install didn't finish | `/var/log/cloud-init-output.log` |
| `dcvserver-not-running` | DCV is installed but its server didn't start | `systemctl status dcvserver` |
| `session-never-created` | DCV is up, but no session appeared within 4 minutes | `/var/log/spored.log` |
| `tag-write-denied` | spored couldn't tag the instance (the role lacks `ec2:CreateTags`) | Relaunch to refresh the role |
| `web-not-responding` | The web app's port didn't answer within 4 minutes | `docker ps`, `docker logs` |
| `web-proxy-failed` | The TLS proxy couldn't start, usually because there's no certificate | `/var/log/spored.log` |

For a web app, `spawn connect <instance-id>` opens a shell where you can look.
For a DCV instance it doesn't: `spawn connect` always goes back to the browser
session, even though the failure messages suggest otherwise. To get a shell on a
DCV instance, SSH to it directly (port 22 is open) with the key spawn imported at
launch. On a `desktop`, you can also open a terminal inside the session.

### Lifecycle

| | DCV app or desktop | Web app |
|---|---|---|
| **Idle** means | No DCV client connected (once DCV is up) | The standard spored checks: CPU, network, processes, logged-in users |
| **On idle** | The instance is **stopped**; `spawn connect` starts it again | The instance is **stopped** |
| **At `--ttl`** | The instance is **terminated** | The instance is **terminated** |
| **Default TTL** | `8h` | `8h` |

Points to know:

- **Every session has a TTL.** Without `--ttl`, `spawn app launch` sets `8h`
  and prints it at launch and in the ready summary. An idle session is only
  *stopped*, so it can be restarted, and a stopped instance still pays for its
  100 GiB root volume. The TTL is what ends an abandoned one. Once an instance
  is stopped, spored isn't running, so the TTL is enforced by an out-of-band
  [reaper](/guides/reaper) if you have one. There's no `--no-timeout` for apps;
  pass a longer `--ttl`, or use `spawn extend` on a running session. (Before
  spawn v0.136.0 there was no default TTL.)
- **An open DCV tab counts as use.** For DCV, "idle" is measured by connected
  clients, so a browser tab left connected keeps the instance running. Close the
  tab when you're done.
- **A DCV instance gets 8 minutes of startup grace.** If DCV never comes up,
  spored stops treating the instance as busy after 8 minutes and falls back to
  the standard idle checks, so a broken session still idles out instead of
  running until its TTL.
- spored warns 5 minutes before an idle stop. Its full idle rules are on the
  [spored page](/tools/spored#idle-detection).

### GPU apps

For an entry with `gpu: true` (`paraview`, `chimerax`), spawn runs the container
with `docker run --gpus all` on the GPU Deep Learning base image. GPU instances
need a GPU quota in the region you launch in; check it with `truffle quotas`
before you start. On x86_64, DCV's GPU-accelerated OpenGL package (`nice-dcv-gl`)
is installed as well.

Two things to know:

- `--gpus all` follows the catalog's `gpu` field, **not** the instance type. A
  CPU app launched with `--instance-type g6.xlarge` gets the GPU base image but no
  GPU inside its container. For your own GPU app, set `gpu: true` in its overlay
  entry.
- For a GPU-accelerated desktop, launch `desktop` with a GPU instance type:
  `spawn app launch desktop --instance-type g6.xlarge --ttl 2h`. The desktop runs
  directly on the instance rather than in a container.

spawn#606, the missing GPU inside `spawn task run` containers, was a task-path
issue and has been fixed. It doesn't affect `spawn app`.

### Bring your own app

There are two ways to run an image of your own: pass `--image` on the command
line, or add an entry to a **catalog overlay**.

#### Launch with `--image`

`--image` points an app *that is already in the catalog* at an image you
provide, for this launch only:

```sh
spawn app launch paraview --image public.ecr.aws/EXAMPLE/paraview:5.13.2 --ttl 4h
```

Replace `EXAMPLE` with your registry alias. Three rules:

- **The app name must already be in the catalog.** `spawn app launch myapp --image …`
  fails with `application "myapp" not found in catalog`, whatever else you pass.
  For a new app, add an overlay entry (next section).
- **Put the tag in the reference** (`repo:tag`). If you leave it off, spawn uses
  the catalog's `tag_default`. The recipe-only entries have none, so a bare
  reference fails with `app "paraview" has no default image tag`.
- **A private ECR image must be in your own account.** spawn logs the instance
  into private ECR with the instance role. It refuses to launch an image owned by
  another account (`private image owned by another account`), even if that
  account has granted you access.

Adding `--web-port <n>` turns the launch into a web app on that container port,
whatever the entry's own kind. The other settings still come from the entry,
including its `args`, so this suits an entry with no `args` (`openrefine`, `igv`
and the other recipe entries) better than `code-server` or `jupyter`.

#### Add it to a catalog overlay

An overlay is a YAML file in the catalog's format. spawn reads it from
`--catalog <file>`, then `$SPAWN_CATALOG`, then `~/.spawn/catalog.yaml`. Each
entry is merged by `name`:

- **A new name adds an app**, exactly as written, including `kind`, `port` and
  `args`.
- **An existing name rebinds that app.** Every field you set replaces the
  built-in value, and the fields you leave out keep it. This is how you give a
  recipe entry its image.

```yaml
# ~/.spawn/catalog.yaml
apps:
  # Give the paraview recipe an image you built.
  - name: paraview
    image: public.ecr.aws/EXAMPLE/paraview
    tag_default: "5.13.2"

  # A new web app of your own.
  - name: mydash
    description: "Lab dashboard"
    kind: web
    port: 8050
    instance_families: [m7i]
    idle_timeout_default: 30m
    image: ghcr.io/EXAMPLE/mydash
    tag_default: "1.0"
```

```sh
spawn app list
spawn app launch mydash --ttl 2h
```

Both entries now show as `launchable`. If the overlay file can't be read or
parsed, spawn prints a warning and carries on with the built-in catalog only.

::: warning Rebinding doesn't change `kind`, `port`, `health_path` or `args` (spawn#1153)
When an overlay entry *rebinds* a built-in app, those four fields are ignored
and the built-in values stay. To run something with a different kind, port or
arguments, give it a new name.
:::

For a **web** app's image, three rules (from
[spawn's guide](https://github.com/spore-host/spawn/blob/main/docs/bring-your-own-app.md)):

1. Listen on `0.0.0.0` inside the container, not localhost. spawn publishes
   the port on the instance's loopback for the proxy.
2. Turn the app's own login off. The proxy token gates it.
3. Serve on a known port, and set it as `port:` or `--web-port`.

A **DCV** application image runs as the session's first process, with
`DISPLAY`, the X socket and the session's X authority passed in and
`--network host`. The images are `linux/amd64`. The ParaView and ChimeraX build
recipes, and the `build-push.sh` script that builds and pushes them, are in
[`infra/amis/containers`](https://github.com/spore-host/spore-host/tree/main/infra/amis/containers).
ChimeraX has a licence-gated download that you fetch by hand first.

Every field is documented in
[spawn's catalog schema](https://github.com/spore-host/spawn/blob/main/docs/catalog-schema.md),
with a starter overlay in
[`catalog-overlay.example.yaml`](https://github.com/spore-host/spawn/blob/main/docs/catalog-overlay.example.yaml).
OpenRefine, built from upstream releases, is the worked example in
[spore-host/app-images](https://github.com/spore-host/app-images).

## `spawn service`

`spawn service` launches an instance, starts your command on it over SSH, waits
for the command to announce where it's listening, and forwards a local port to
that address. It has no subcommands:

```text
spawn service [flags] -- <command> [args...]
```

Put spawn's flags **first**, then `--`, then your command. Everything after the
`--` goes to your service unchanged. Without the separator, spawn tries to read
your command's flags as its own. For example,
`spawn service --instance-type m7i.large python3 -m app.serve` fails with
`unknown shorthand flag: 'm' in -m`, and spawn then explains the missing `--`.

```sh
spawn service --instance-type m7i.large --upload ./my-server --ttl 2h -- ./my-server
spawn service --instance-type m7i.large --ttl 1h -- python3 -m myapp.serve
spawn service --host my-box --upload ./my-server -- ./my-server
spawn service --instance-type m7i.large --ttl 1h --dry-run -- ./my-server
```

`--dry-run` prints the plan and launches nothing. If you also pass `--region`, it
looks up the hourly rate so it can print a cost bound.

```text
DRY RUN — nothing will be launched.

Instance:    m7i.large in -
Lifetime:    ttl=1h idle=- (then terminate) on-complete=terminate
Command:     './my-server' --addr 127.0.0.1:0
Readiness:   one JSON line on stdout, within 2m0s
Tunnel:      127.0.0.1:<free port> → the address the service announces
Rate:        unknown — no region resolved yet (pass --region to see the cost bound)

Re-run without --dry-run to launch.
```

### The readiness contract

Your service chooses its own port and **announces** it. spawn never guesses a
port or polls one. When the service starts serving, it prints exactly one JSON
line to **stdout**:

```json
{"event":"ready","addr":"127.0.0.1:54321","provenance":{"commit":"abc1234"}}
```

| Field | Required | Meaning |
|---|---|---|
| `event` | yes | Must be `"ready"`. Lines without it are ignored |
| `addr` | yes | The address actually bound, after `:0` was resolved (`host:port`) |
| `token` | no | An access credential. spawn adds it to the printed URL as `/?token=…` |
| `provenance` | no | Build identity in any shape. spawn prints it as `Built:` |

To make a program work with `spawn service`:

- **Take a listen address on the command line.** spawn appends
  `--addr 127.0.0.1:0` to your command. If your program spells it differently,
  use `--addr-args` (for example `--addr-args "--listen 127.0.0.1:0"`). Pass
  `--addr-args ""` to append nothing, for a program that reads its address from
  a config file.
- **Bind the loopback**, not `0.0.0.0`. The tunnel is meant to be the only way
  in.
- **Print the line after binding**, with the real port, and **flush stdout**. A
  line stuck in a buffer looks the same as a service that never started.
- **Log to stderr.** Other lines on stdout are skipped, and the service's own
  output is copied to your terminal's stderr.

spawn sends an HTTP request through the tunnel to check each announced address
before it trusts it, because a program can print a fake line. Any HTTP response
counts, including 401 or 404. The full specification, with a Go example, is
[the service readiness contract](https://github.com/spore-host/spawn/blob/main/docs/service-readiness-contract.md).

::: warning Not every server works as-is (spawn#1153)
A stock server that doesn't print the readiness line never becomes ready, and
spawn gives up after `--boot-timeout`. The service help's
`uvicorn app:app --port 0` example is one of these. spawn would also append
`--addr 127.0.0.1:0`, which uvicorn doesn't accept. Wrap such a server in a small
launcher that binds, prints the line, and then serves.
:::

### Access

spawn runs `ssh -L` from a local port (`--local-port`, or a free one) to the
announced address and prints:

```text
✅ Service ready
   URL:       http://127.0.0.1:<local-port>
   Instance:  i-0123456789abcdef0 in us-east-1
   Forward:   127.0.0.1:<local-port> → 127.0.0.1:54321 (the instance's loopback)

Press Ctrl-C to stop the service and terminate the instance.
```

`--open` also opens the URL in your browser. The service is reachable only
through this tunnel, and only while `spawn service` is running.

### Flags

| Flag | Default | Notes |
|---|---|---|
| `--instance-type` | | Required unless `--host` is given |
| `--host` | | Use an instance that's already running (name or ID). spawn doesn't terminate it afterwards |
| `--ami` | the recommended AMI for the instance type | |
| `--upload` | | One local file to copy up and make executable; usually the service binary |
| `--remote-path` | `/tmp/spawn-service-bin` | Where `--upload` lands. If your command *is* the uploaded file, spawn rewrites it to this path |
| `--ttl` | | The instance is terminated after this long |
| `--idle-timeout` | `1h` if neither this nor `--ttl` is set | See [Lifecycle](#service-lifecycle) |
| `--boot-timeout` | `2m` | How long to wait for the readiness line |
| `--addr-args` | `--addr 127.0.0.1:0` | |
| `--local-port` | a free port | |
| `--open` | off | |
| `--name` | `spawn-service` | Name tag |
| `--spot` | off | A Spot interruption ends the service |
| `--subnet-id`, `--security-group-ids` | | Network placement |
| `--user`, `--key` | the instance's `spawn:local-username` tag, else `ec2-user`; the instance's launch key | SSH identity |
| `--dry-run` | off | |

### Service lifecycle {#service-lifecycle}

- **Ctrl-C** shuts the service down and **terminates** the instance, unless you
  used `--host`. spawn terminates on every way out, including a service that
  never became ready, so a failed start costs minutes, not an hour. If the
  terminate call itself fails, spawn says so loudly and prints the
  `spawn terminate <id>` command to run.
- **The TTL is the guarantee.** If your laptop sleeps or the network drops, the
  instance keeps its TTL. With neither `--ttl` nor `--idle-timeout`, spawn
  applies a 1h idle timeout, so `spawn service` never runs unbounded.
- **An idle timeout terminates the instance.** spawn tags a service instance
  `spawn:terminate-on-idle=true`, and spored terminates it rather than stopping
  it, so nothing is left billing for a service nobody will restart. The dry run's
  `Lifetime:` line names the idle action. This needs spored v0.136.0 or later on
  the instance; with an older spored, and in spawn before v0.136.0, idle
  stopped the instance instead.
- **If the service fails to start**, spawn shows its stderr and the stdout lines
  that didn't match, and says whether the service *exited* (a bug or a bad
  argument) or *hung* (try a longer `--boot-timeout`).

## See also

- [Interactive workstation](/guides/jupyter): long-lived Jupyter and RStudio on
  an instance you manage with `spawn launch`.
- [Instance plugins](/guides/plugins): add software and services to any
  instance.
- [spored](/tools/spored): idle detection, TTL and the instance tags.
- [Spot instances](/guides/spot-instances), if you use `--spot`.

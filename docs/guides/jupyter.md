---
description: "Interactive compute environments like Jupyter and RStudio have a specific challenge with idle detection: an open browser tab doesn't count as activity…"
---

# Jupyter Notebooks and RStudio

Interactive compute environments like Jupyter and RStudio have a specific challenge with idle detection. spored judges idleness from CPU, network, disk and terminal input, and an open browser tab doesn't count. So a notebook you're reading but not running looks idle, and the instance can be stopped under you.

spore.host handles this with process-based idle detection — the instance stays alive as long as the notebook server process is running, and stops when you explicitly disconnect.

::: tip Built-in web apps
`spawn app launch jupyter` (and `code-server`, `openrefine`) starts a ready-made web app behind a TLS proxy instead. See [GUI apps & services](/guides/apps-and-services).
:::

## RStudio

RStudio's server process is named `rsession`. Tell spored to watch for it:

```sh
spawn launch \
  --name rstudio \
  --instance-type r6i.2xlarge \
  --ttl 8h \
  --active-processes rsession \
  --idle-timeout 2h \
  --slack-workspace T03NE3GTY
```

With `--active-processes rsession`, the instance is considered active whenever an R session is open. The idle timeout (`--idle-timeout 2h`) only fires if *both* conditions are true: no active R sessions AND low CPU/network activity for 2 hours.

::: warning `--active-processes` needs an idle timeout
`--active-processes` only holds off an idle timeout; on its own it does nothing.
An idle timeout applies by default only when you pass neither `--ttl` nor
`--idle-timeout`, so with `--ttl` set you must also pass `--idle-timeout` (or set
it as a default) for the process check to matter.
:::

Process names are matched exactly against the running process name (`pgrep -x`),
so check the real name on the instance with `pgrep -l <part-of-name>`.

### Save it as a default

If you always launch RStudio environments, save this once:

```sh
spawn defaults set active-processes rsession
spawn defaults set idle-timeout 2h
spawn defaults set slack-workspace T03NE3GTY
```

Then just launch with:

```sh
spawn launch --name rstudio --instance-type r6i.2xlarge --ttl 8h
```

## Jupyter

JupyterLab's server process is named `jupyter-lab` (check yours with
`pgrep -l jupyter`; the name must match exactly):

```sh
spawn launch \
  --name jupyter \
  --instance-type c6i.4xlarge \
  --ttl 8h \
  --active-processes jupyter-lab \
  --idle-timeout 1h
```

If you run multiple tools on the same instance:

```sh
spawn launch \
  --name analysis \
  --instance-type r6i.4xlarge \
  --ttl 12h \
  --idle-timeout 1h \
  --active-processes "rsession,jupyter-lab"
```

## Notifications for interactive sessions

For interactive sessions, the most useful notifications are TTL warnings — you want to know before the instance terminates so you can extend it or save your work:

With `--slack-workspace` set, you'll receive a DM 5 minutes before the TTL expires:

> *⏱️ rstudio terminates in 5 minutes*

Respond directly in Slack: `/spore extend rstudio 4h`

## Collaborative sessions

If multiple researchers share an RStudio or Jupyter instance, anyone who has been registered with spore-bot can extend the TTL from Slack without needing SSH access. See [Slack Setup](/guides/slack-setup) for how to register users.

## Hibernation for cost savings

For sessions that run overnight but aren't actively used, hibernation is a good option. The RAM state (including in-memory data) is preserved:

```sh
spawn launch \
  --name rstudio \
  --instance-type r6i.8xlarge \
  --ttl 5d \
  --on-idle hibernate \
  --idle-timeout 3h \
  --active-processes rsession
```

When idle for 3 hours with no active R sessions, the instance hibernates. Resume it with `/spore start rstudio` and pick up exactly where you left off. Hibernation stops compute billing, but the EBS volumes (including the RAM image on the root volume) keep billing, and the TTL keeps counting.

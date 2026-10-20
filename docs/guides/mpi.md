---
description: "For workloads that need to communicate across multiple nodes — large-scale simulations, distributed training, or parallel data processing — spore.host can la…"
---

# MPI Clusters

For workloads that need to communicate across multiple nodes — large-scale simulations, distributed training, or parallel data processing — spore.host can launch a multi-node MPI cluster as a single command.

## Launch a cluster

```sh
spawn launch \
  --job-array-name climate-sim \
  --instance-type hpc7g.16xlarge \
  --count 8 \
  --mpi \
  --ttl 12h \
  --mpi-command './simulate --config config.yaml'
```

`--count 8` launches 8 instances, named `climate-sim-0` to `climate-sim-7`;
`--job-array-name` is required. `--mpi` sets up passwordless SSH between all
nodes, installs OpenMPI if not present, and writes the hostfile.

`--mpi-command` is your MPI program. Once every node is ready, rank 0 runs it
through `mpirun` across the whole cohort: one process per vCPU on each node by
default (`--mpi-processes-per-node` changes that), so 8 × 64 processes here.
Don't wrap it in `mpirun` yourself. Its output goes to `/var/log/spawn-command.log`
on rank 0 (read it with `spawn array logs climate-sim --index 0`).

`--command` is different: it runs on **every** node, independently. Use it for
per-node setup, not for the MPI job.

MPI clusters launch **all-or-nothing**: spore.host waits for every node to come up and pass an MPI-readiness check (`mpirun` present, and the EFA fabric when `--efa` is set), then distributes the peer list to all nodes before the cluster is considered ready. If any node can't be placed, the whole launch fails and every already-launched node is cleaned up — so you never pay for a half-formed cluster.

## Availability Zone fallback

A cluster placement group lives in a single Availability Zone, and capacity for large HPC/GPU instance types is often available in one AZ but not another. If the primary AZ is out of capacity, spore.host automatically moves the **entire cluster** to the next AZ in the region — as a unit, so all nodes stay co-located in one placement group. This happens transparently; you'll see it noted in the launch output. No configuration is needed. (Pinning an explicit `--placement-group` fixes the cluster to that group's AZ and disables fallback.)

## EFA for high-performance networking

For workloads that saturate standard networking, enable Elastic Fabric Adapter:

```sh
spawn launch \
  --job-array-name distributed-training \
  --instance-type p4d.24xlarge \
  --count 4 \
  --mpi \
  --efa \
  --mpi-processes-per-node 8 \
  --ttl 24h \
  --mpi-command 'python train.py'
```

`--efa` requires an EFA-supported instance type (p4d, hpc7g, c5n, and others). spore.host automatically selects an EFA-enabled security group and places all instances in a cluster placement group for lowest latency.

### EFA without `--mpi`

Since spawn v0.135.2, `--efa` and `--placement-group` also take effect on a
launch without `--mpi`. That's how to build an EFA fleet of **different instance
types**, such as a GPU client and CPU proxies, which can't be one MPI job array.
(Before v0.135.2 both flags were silently ignored without `--mpi`: the instance
came up with a plain ENA interface and outside the placement group.)

Without `--mpi`, spawn doesn't create the security group EFA needs, one that
admits all traffic from itself. Create it yourself and pass it with
`--security-group-ids`, along with the same cluster placement group for every
instance. Without `--mpi`, spawn doesn't create the placement group either, so it
must already exist
([spawn#1168](https://github.com/spore-host/spawn/issues/1168) tracks having spawn
create it):

```sh
spawn launch --name efa-client --instance-type p5.48xlarge --efa --placement-group my-efa-group --security-group-ids sg-0123456789abcdef0 --ttl 4h
spawn launch --name efa-proxy --instance-type c7gn.16xlarge --efa --placement-group my-efa-group --security-group-ids sg-0123456789abcdef0 --ttl 4h
```

## Instance placement

By default, MPI clusters are placed in a cluster placement group named `spawn-mpi-<job-array-name>-<az>` for minimum latency. spawn creates it on demand in whichever AZ the cluster lands in (so [AZ fallback](#availability-zone-fallback) can pick a zone with capacity), and cleans up the groups for any AZs it tried and moved on from. If you have an existing placement group:

```sh
spawn launch \
  --job-array-name sim \
  --count 16 \
  --mpi \
  --placement-group my-hpc-group \
  --mpi-command './sim'
```

## Monitoring the cluster

```sh
spawn list --job-array-name climate-sim   # all nodes in the cluster
spawn status climate-sim-0             # status of the head node
spawn status climate-sim-1             # status of worker node 1
```

## Lifecycle

The cluster's TTL applies to all nodes. When the `--mpi-command` job exits, pass
or fail, every member is signalled, so `--on-complete terminate` takes the whole
cluster down together. There's no completion file to write yourself.

```sh
spawn launch \
  --job-array-name sim \
  --count 8 \
  --mpi \
  --ttl 12h \
  --on-complete terminate \
  --mpi-command './sim'
```

## Shared storage with FSx Lustre

For large datasets that all cluster nodes need to read, attach an FSx Lustre filesystem:

```sh
# Create a new FSx filesystem backed by S3.
# --fsx-create REQUIRES --fsx-lifecycle: 'ephemeral' (reaped when this cluster
# terminates) or 'durable' (persists; add --fsx-ttl, e.g. 7d).
spawn launch \
  --job-array-name sim \
  --count 8 --mpi --efa \
  --instance-type hpc6a.48xlarge \
  --mpi-command './sim' \
  --fsx-create \
  --fsx-lifecycle ephemeral \
  --fsx-s3-bucket my-data-bucket \
  --fsx-import-path s3://my-data-bucket/inputs/ \
  --fsx-export-path s3://my-data-bucket/outputs/ \
  --fsx-mount-point /fsx

# Or attach an existing filesystem
spawn launch \
  --job-array-name sim \
  --count 8 --mpi --efa \
  --mpi-command './sim' \
  --fsx-id fs-0abc1234 \
  --fsx-mount-point /fsx
```

FSx Lustre is mounted at `/fsx` on every node. The filesystem ID and mount point are written as instance tags (`spawn:fsx-id`, `spawn:fsx-mount-point`) so boot scripts can auto-mount without hardcoding the ID.

::: info FSx compatibility
spore.host creates FSx `PERSISTENT_2` filesystems (Lustre 2.15 server). This is compatible with the standard Amazon Linux 2023 Lustre client (`dnf install -y lustre-client`). The mount uses port 988 and dynamic ports 1018–1023 — spawn automatically opens these in the instance security group so no manual SG configuration is needed.
:::

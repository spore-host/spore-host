## `lagotto teardown`

Delete the DynamoDB tables lagotto uses (lagotto-watches and
lagotto-match-history by default).

lagotto already tears these down automatically once there are no active watches
and the tables have drained (watches and match history age out via DynamoDB TTL).
Use this to remove them explicitly.

By default it refuses to delete tables that still hold records, so you don't lose
match history; pass --force to delete regardless.

--iam-roles also deletes the two IAM roles 'lagotto setup' and 'lagotto deploy'
create (lagotto-capacity-poller-role and lagotto-capacity-poller-scheduler-invoke),
with their policies. The roles are account-global and shared by the poller in every
region, so this first checks every region enabled in the account and refuses, before
deleting anything, while a poller still exists in any of them (remove each with
'lagotto deploy --teardown --region &lt;region&gt;') or when a region cannot be checked.
--force does not override that check.

```
lagotto teardown [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--force` |  | bool |  | Delete even if the tables still contain records |
| `--iam-roles` |  | bool |  | Also delete lagotto's two account-global IAM roles; refused while a poller exists in any region |


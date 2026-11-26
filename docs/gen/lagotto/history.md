## `lagotto history`

Show match history

```
lagotto history [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--watch-id` |  | string |  | Filter by watch ID |

### `lagotto history export`

Write every row of the match-history table (--history-table, default
lagotto-match-history) in one region (--region, else your configured region),
every owner's, as JSON Lines: one JSON object per row, with every attribute
the row holds, to stdout or, with --out, to a new file (created 0600; an
existing file is never overwritten). It reads and changes nothing else.

Export before lagotto is torn down: the match history is not kept as user
data. Once nothing lagotto manages has been active in a region for the grace
period (24 h), the poller's idle teardown removes the region's tables, the
match history included, whatever they hold (in this release it only reports
what it would remove; lagotto#328 turns removal on). 'lagotto teardown --plan
... --mode reap' deletes them too, and 'lagotto teardown --force' deletes them
when they still hold records.

It makes one DynamoDB call, dynamodb:Scan on the history table, which the
lagotto-cli-user policy does not grant (its item access is owner-scoped and a
Scan reads every owner's rows), so run it as an administrator. To save only
your own history, use 'lagotto history -o json'.

Numbers are written as JSON numbers with DynamoDB's exact digits, binary
values as base64 strings, and string, number and binary sets as arrays.

```
lagotto history export [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--out` |  | string |  | Write to this new file (mode 0600) instead of stdout |


## `lagotto cancel`

Cancel an active watch. Any capacity reservation it recorded is released.

For a --action hold watch that already fired (status: matched), cancel releases
the reservation it holds. The reservation is targeted and bills at the On-Demand
rate until its 30-minute window ends, so release it as soon as you know you
won't launch into it. The watch keeps its matched status. Releasing a
reservation that already expired or was already released is not an error.

```
lagotto cancel <watch-id> [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--yes` | `-y` | bool |  | Skip the confirmation prompt |


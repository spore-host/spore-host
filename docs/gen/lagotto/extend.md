## `lagotto extend`

Extend a watch's TTL to --ttl from now. An expired watch is reactivated.

For an --until-landed watch, which has no TTL, extend is the same as
'lagotto ack': it moves the acknowledgement deadline a full window ahead and
resumes the watch if it paused. --ttl does not apply to it.

```
lagotto extend <watch-id> [flags]
```

**Flags:**

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--ttl` |  | string | `24h` | New TTL from now (e.g., 24h, 7d) |


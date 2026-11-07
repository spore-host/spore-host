## `lagotto ack`

Acknowledge an --until-landed watch.

An --until-landed watch has no TTL. Instead it pauses itself unless you
acknowledge it: its deadline is (2+1) × its --remind interval (21 days by
default) from creation or the last acknowledgement. ack moves the deadline a
full window ahead from now. A paused watch (status expired, reason
unacknowledged) is resumed and hunts again.

The hosted poller reminds you on the watch's --notify channels after each of
the first 2 intervals, and sends a final warning 24h before the pause; an ack
starts the reminders again for the new deadline. ack warns when the deployed
poller is too old to send reminders (run 'lagotto deploy' to upgrade it).

Only ack and extend count as an acknowledgement; list and status do not.

```
lagotto ack <watch-id>
```


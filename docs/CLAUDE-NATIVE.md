# Claude Code native mode

OpenKan now visualizes **native Claude Code** state — sessions, prompts,
tool calls, subagent activity, and stop signals — without depending on
the `bizar` CLI.

The board and dashboard read from the `/api/claude/events` stream and
keep a live picture of what Claude Code is doing right now. You do not
need to install Bizar or any agent SDK to use OpenKan in this mode.

## Real-time updates

The event stream is fed two ways:

1. **Transcript tail (default, always on).** OpenKan watches the local
   JSONL transcripts Claude Code writes and surfaces new entries as they
   are appended.
2. **Relay hook (opt-in, low latency).** For instant updates, install
   the relay hook — see [`HOOKS.md`](./HOOKS.md). The hook fires the
   moment a lifecycle event happens and POSTs it to OpenKan in under
   200 ms.

You can use OpenKan in native mode without the relay hook; the
transcript tail keeps the UI in sync with a small lag. Install the
hook when you want zero-delay updates.

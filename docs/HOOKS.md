# Hooks

OpenKan ships an **opt-in** Claude Code relay hook. When installed, the
hook fires the moment a Claude Code lifecycle event happens and forwards
the event to the local OpenKan server, so the UI updates in real time
without polling. The hook is **not** installed by OpenKan — you add it to
your own `~/.claude/settings.json` to keep your global config under your
control.

## What the relay hook does

For every subscribed Claude Code event, the hook reads the hook payload
from stdin, builds a small JSON envelope `{event, sessionId, payload, ts}`,
and POSTs it to `http://127.0.0.1:<port>/api/claude/events` on the
OpenKan server. The port is read from `~/.claude/openkan.json` if present
(looking for `port` or `openkan.port`), otherwise it defaults to `4040`.
The request has a hard 200 ms timeout and the script **always exits 0**,
so a slow or absent OpenKan server never blocks Claude Code.

## Install

Add the relay under each event you want streamed. The recommended set is
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStop`, `Stop`,
`SessionStart`, and `SessionEnd`.

Paste this block into `~/.claude/settings.json` under the top-level
`hooks` key (merge with any existing entries — do not overwrite them):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/home/drb0rk/projects/openkan/.claude/hooks/claude-activity-relay.mjs" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/home/drb0rk/projects/openkan/.claude/hooks/claude-activity-relay.mjs" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/home/drb0rk/projects/openkan/.claude/hooks/claude-activity-relay.mjs" }
        ]
      }
    ],
    "SubagentStop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/home/drb0rk/projects/openkan/.claude/hooks/claude-activity-relay.mjs" }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/home/drb0rk/projects/openkan/.claude/hooks/claude-activity-relay.mjs" }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/home/drb0rk/projects/openkan/.claude/hooks/claude-activity-relay.mjs" }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/home/drb0rk/projects/openkan/.claude/hooks/claude-activity-relay.mjs" }
        ]
      }
    ]
  }
}
```

Adjust the `command` path if you cloned OpenKan somewhere else.

## Disable

- Per shell: set `CLAUDE_OPENKAN_RELAY=0` in your environment. The hook
  short-circuits and exits 0 immediately.
- Globally: remove the `hooks` entries you added above from
  `~/.claude/settings.json`, or comment them out.

## Privacy

- The hook only POSTs to `127.0.0.1` on the configured port. It never
  reaches the network.
- Payloads stay on the host. The hook does not log the payload to
  stdout; only diagnostic errors go to stderr.
- No PII is collected, stored, or transmitted. The payload OpenKan sees
  is exactly the same JSON Claude Code delivers to every hook on this
  host.
- Disabling is one environment variable or a settings.json edit away.

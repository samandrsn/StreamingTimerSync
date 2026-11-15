# Streaming Timer Sync

Shows a per-venue countdown (by default, time left in the message), read from a **Streaming Timer Sync** server. The server reads each venue's Resi decoder playhead and the event's cues (by default MESSAGE START → MESSAGE END / STREAM END; configurable). It works whether a venue is live, delayed, or playing back an earlier service.

All venue setup (decoders, cue names, what to count, fallback length) is done on the server's web page. This module only reads the result.

## Configuration

| Field | Description |
|---|---|
| **Server URL** | e.g. `http://192.168.1.50:7374` |
| **This venue** | The venue's variable key from the server's web page (e.g. `north`). Fills the short variables below. |
| **Poll interval** | Default 500 ms |

## Variables

Short variables for **this venue**:

| Variable | Example |
|---|---|
| `$(streaming-timer-sync:remaining)` | `12:34`, or `-1:05` when overtime |
| `$(streaming-timer-sync:remaining_seconds)` | `754` |
| `$(streaming-timer-sync:state)` | `counting`, `overtime`, `ended`, `waiting`, `no_event`, `offline` |
| `$(streaming-timer-sync:state_label)` | `Counting` |
| `$(streaming-timer-sync:target)` | `10AM // Message End` or `45 min default` |
| `$(streaming-timer-sync:estimated)` | `1` while estimating (no target cue yet, counting the fallback length), `0` when counting to a real cue |
| `$(streaming-timer-sync:elapsed)` | Time since the start cue |
| `$(streaming-timer-sync:event)` | Event name loaded on the decoder |

`remaining` counts to the next target cue still ahead, rolling from one to the next (for example Message End → Response → Stream End) and showing done only after the last. Each **Count down to** cue type also gets its own countdown, named after the type:

| Variable | Example |
|---|---|
| `$(streaming-timer-sync:message_end_remaining)` | Time to the MESSAGE END cue |
| `$(streaming-timer-sync:stream_end_remaining)` | Time to the STREAM END cue, even after Message End has passed |
| `$(streaming-timer-sync:stream_end_remaining_seconds)`, `…_state` | Same, in seconds / as a state |

Until that cue exists, a per-type countdown counts to the start cue + the fallback length.

The same fields exist for every venue with its key as a prefix, e.g. `$(streaming-timer-sync:north_remaining)` and `$(streaming-timer-sync:north_stream_end_remaining)`.

If you renamed the connection, replace `streaming-timer-sync` with your connection label.

## Feedbacks

- **Remaining at or below (minutes)**
- **Overtime or ended**
- **Timer state is**
- **Counting to default length (no target cue yet)**

## Sending to ProPresenter

Easiest: add a **Web** element to a ProPresenter stage layout pointing at `http://<server>:7374/<venue>` (e.g. `/north`, or `/north/stream_end` for one target). It shows a white clock with a green **CUE** badge when the time comes from a real cue, and an amber `~` clock with an **ESTIMATE** badge when no target cue exists yet. Options: `?bg=transparent`, `?header=0`, `?footer=0`.

Or with variables: use the ProPresenter Companion module. For example, a trigger "on variable change" for `$(streaming-timer-sync:remaining)` that runs a ProPresenter **Stage Message** or **Set Timer** action with the variable as its value.

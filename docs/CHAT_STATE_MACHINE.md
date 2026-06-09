# Chat State Machine

> Reducer-based finite state machine that coordinates the assistant chat: in-flight requests, pending confirmations, watchdogs, and the offline → draining transition. Lives in `src/app/dashboard/lib/chat-state-machine.ts`. Replaces the implicit coordination between `inFlightRef`, `pendingConfirmation`, queue refs, and `navigator.onLine`.
>
> Tests in `tests/unit/chat-state-machine.test.cjs` enforce every transition listed below.

## States

| Kind | Meaning | Allowed inputs |
|------|---------|----------------|
| `idle` | No work in flight, ready for next submit | `submit`, `confirmation-requested`, `offline` |
| `processing` | LLM call or command parser running | `ai-resolved`, `command-resolved`, `confirmation-requested`, `watchdog-tripped`, `offline` |
| `pending-confirmation` | Card shown, waiting for user click | `user-confirmed`, `user-cancelled`, `offline` |
| `executing-confirmation` | Mutation in flight after user confirmed | `execution-completed`, `execution-failed`, `watchdog-tripped`, `offline` |
| `offline` | `navigator.onLine === false` — submits go to queue | `online` |
| `draining-offline` | Reconnect detected, queue drain in progress | `ai-resolved`, `execution-completed` (terminal: → idle) |

## Helper predicates

```ts
isBusy(state)        // false for idle + offline; true for everything else
shouldEnqueue(state) // true when work is in flight or confirmation pending or draining; not for idle/offline
```

`shouldEnqueue` is the contract the offline-queue layer respects — if it returns true, the new submit goes to the queue rather than firing immediately.

## Transition diagram

```
                  submit
              ┌──────────────┐
              ▼              │
         ┌────────┐          │
   ┌───▶ │  idle  │ ◀──┬─────┘
   │     └────┬───┘    │
   │          │        │
   │          │ submit │ ai-resolved / command-resolved
   │          ▼        │
   │     ┌────────────────┐
   │     │  processing    │
   │     └─┬──────────────┘
   │       │  │
   │       │  └──── confirmation-requested ────┐
   │       │                                    ▼
   │       │ watchdog-tripped              ┌─────────────────────┐
   │       │                               │ pending-            │
   │       └─────────────▶ idle            │ confirmation        │
   │                                       └─┬───────────────────┘
   │                                         │  │
   │                                         │  └ user-cancelled ─▶ idle
   │                                         │
   │                                         ▼ user-confirmed
   │                                       ┌─────────────────────┐
   │                                       │ executing-          │
   │                                       │ confirmation        │
   │                                       └─┬───────────────────┘
   │                                         │  │
   │                                         │  └ execution-completed / failed ─▶ idle
   │                                         │
   │                                         └ watchdog-tripped ─▶ idle
   │
   │ online (queue drain done)
   │ ┌────────────────────────┐
   │ │  draining-offline      │
   │ └────────┬───────────────┘
   │          │ ai-resolved / execution-completed
   │          ▼
   └─────── idle

   offline event from any state → offline
   online event from offline    → draining-offline
```

## Why a state machine and not ad-hoc booleans

Before this reducer, the chat layer used 4 mutable refs:

```ts
const inFlightRef = useRef(false);
const pendingConfirmation = useState(...);
const queueRef = useRef([]);
const offlineRef = useRef(false);
```

Bugs that landed in production with that approach (each fixed during the refactor):

1. **Double-submit race.** User clicked submit twice quickly while AI call was in flight; both calls landed, second one's response overwrote the first. Fixed by `isBusy(state)` gate at submit-time.
2. **Confirmation card stuck after watchdog.** AI watchdog timeout fired, but `pendingConfirmation` was set; the card stayed forever. Fixed by `watchdog-tripped` event clearing `pending-confirmation` and `executing-confirmation`.
3. **Offline submits lost.** When `navigator.onLine` flipped during a submit, the submit fired before the state caught up; the response failed silently. Fixed by `offline` event being a terminal state regardless of current kind.

## Watchdog interaction

A 30-second timeout is armed when entering `processing` or `executing-confirmation`. If the response or execution doesn't fire within window, `watchdog-tripped` event fires and the state returns to `idle`. The user sees a soft "no anduvo, probá de nuevo" message. The dropped request is logged to Cloud Logging as `action: ASSISTANT_WATCHDOG_FIRED` for auditability.

## Offline queue interaction

`shouldEnqueue(state)` returning true tells the dispatch layer to push the action onto `offline-queue` (localStorage-backed, see `src/app/dashboard/lib/offline-queue.ts`) rather than firing now. The drain (`useOfflineQueueDrain`) is invoked when the state machine enters `draining-offline`, processes the queue serially with `dispatchQueuedMutation`, and emits `ai-resolved` or `execution-completed` per item — the reducer collapses both back to `idle` once the queue is empty.

## Closing thoughts

The state machine is intentionally small (6 states, 9 events). Adding more states is almost always wrong — instead, extend the reducer's `case` arms with conditional behavior. Two states would have been ideal but `processing` and `executing-confirmation` need to be distinct because the watchdog message differs ("estamos pensando" vs. "registrando").

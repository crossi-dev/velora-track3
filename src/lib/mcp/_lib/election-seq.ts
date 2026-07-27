// src/lib/mcp/_lib/election-seq.ts — monotonic tie-breaker for widget
// instance-supersession election keys (claude.com/docs/connectors/building/
// mcp-apps/instance-supersession).
//
// createdAt (Date.now(), ms resolution) is the primary election key. Two
// render-tool calls landing in the same millisecond — routine under rapid
// clicking/reopening, which is exactly when supersession matters most —
// can't be ordered by createdAt alone. The official pattern adds a
// monotonic `seq` as the tie-breaker instead of falling back to an
// arbitrary instanceId string comparison.
//
// Per-process only (per the doc's own caveat: "a per-process counter works
// for a demo; a production server should derive the key from something
// durable"). Cloud Run can route the two calls to different container
// instances, in which case this doesn't disambiguate them — but it never
// makes ordering worse than the pre-existing instanceId fallback, and it
// resolves the common single-instance case (same browser, same warm
// container) that produced observable stale-button clicks in testing.

let seq = 0;

/** Returns a monotonically increasing integer, unique within this process. */
export function nextSeq(): number {
  return ++seq;
}

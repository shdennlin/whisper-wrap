## ADDED Requirements

### Requirement: Partial-consensus filter stabilises partial emissions

The system SHALL apply a single-step consensus filter inside `app/services/stream.py` before emitting `partial` events on `WS /listen`. For each completed sliding-window inference within an in-flight utterance, the wrapper SHALL:

1. Compute the longest common prefix (LCP) of the current inference's transcript and the immediately previous inference's transcript, both compared as Unicode strings.
2. Truncate the LCP at the last whitespace or punctuation boundary (so partial emissions never end mid-word). If no boundary exists inside the LCP, the truncated prefix SHALL be the empty string.
3. Emit a `partial` event whose `text` is the truncated prefix only when (a) the truncated prefix is non-empty AND (b) the truncated prefix differs from the most recently emitted `partial` text. Otherwise, no `partial` event SHALL be emitted for this inference round.
4. Cache the current inference's full transcript as the "previous inference" for the next round.

The `start_ms` of each emitted `partial` SHALL remain anchored to the utterance start (unchanged from v2 semantics). The `end_ms` SHALL reflect the position at which the truncated prefix ends within the inferred segments, computed by mapping the truncated prefix length back to the deepest segment whose accumulated text length covers that prefix.

The filter SHALL NOT alter `final` event behaviour: when the underlying VAD endpointing fires, the wrapper SHALL still emit a `final` event whose `text` is the full transcript of the just-completed utterance, even if no `partial` ever stabilised during that utterance (the "starvation" case).

#### Scenario: Two stable inferences produce a partial

- **WHEN** within an in-flight utterance the inference at window N produces transcript "今天" and the inference at window N+1 produces "今天天氣"
- **THEN** the wrapper SHALL compute LCP "今天", emit a `partial` event with `text="今天"` (after the inference at N+1), and cache "今天天氣" as the previous transcript for window N+2

#### Scenario: Unstable consecutive inferences emit no partial

- **WHEN** within an in-flight utterance window N produces "今天" and window N+1 produces "明天天氣很好"
- **THEN** the wrapper SHALL compute an empty LCP (no shared prefix at a word boundary), SHALL NOT emit a `partial` event for window N+1, and SHALL cache "明天天氣很好" as the previous transcript

#### Scenario: Idempotent partial is suppressed

- **WHEN** the wrapper has already emitted a `partial` event with `text="今天天氣"` and the next inference round produces an LCP that truncates back to "今天天氣"
- **THEN** the wrapper SHALL NOT emit a second `partial` event with the same text

#### Scenario: Final still emits when no partial ever stabilised

- **WHEN** an utterance contains only one inference round before VAD-final fires (e.g. a single short word "好"), so no consecutive-inference consensus is possible
- **THEN** the wrapper SHALL emit zero `partial` events for the utterance but SHALL still emit one `final` event with the full transcript

##### Example: LCP truncation with mixed-language transcript

| Window N transcript | Window N+1 transcript | LCP raw | LCP at word boundary | Emitted partial |
| ------------------- | --------------------- | ------- | -------------------- | --------------- |
| "I went to" | "I went to the store" | "I went to" | "I went to" | `text="I went to"` |
| "I went to" | "I want some coffee" | "I w" | "" | none |
| "今天天氣" | "今天天氣不錯" | "今天天氣" | "今天天氣" | `text="今天天氣"` |
| "Hello wor" | "Hello world" | "Hello wor" | "Hello" | `text="Hello"` |

### Requirement: Partial-consensus filter reduces emission rate

When measured against a captured-audio regression fixture (10 seconds of continuous Mandarin speech recorded at 16 kHz mono, replayed deterministically against `WS /listen`), the total number of `partial` events emitted by a v2.1 server with the consensus filter active SHALL be ≤50% of the count emitted by a v2.0 server (no consensus filter) against the same fixture under the same VAD configuration.

This requirement SHALL be verified by a regression test (`tests/test_stream_consensus.py`) that injects the captured PCM through the stream wrapper with both filter-on and filter-off code paths and asserts the count ratio.

#### Scenario: Consensus filter halves partial emissions on regression fixture

- **WHEN** the regression test replays the 10 s Mandarin fixture through the stream wrapper with the consensus filter active, and separately through the same wrapper with the filter disabled (counted directly from the underlying inference loop)
- **THEN** the filter-active partial count SHALL be ≤50% of the filter-disabled partial count

##### Example: target reduction on shipped fixture

| Fixture | Filter disabled | Filter active | Ratio | Pass |
| ------- | --------------- | ------------- | ----- | ---- |
| 10 s Mandarin sample A | 18 partials | 7 partials | 0.39 | yes (≤0.5) |
| 10 s Mandarin sample B | 22 partials | 10 partials | 0.45 | yes (≤0.5) |

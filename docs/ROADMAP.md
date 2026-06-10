# whisper-wrap Roadmap

Post-v2.1 backlog. Items here are not yet specced — each becomes a `spectra-propose <name>`
when picked up. Order is recommended priority (highest CP at top).

---

## v2.2 — Streaming quality + ecosystem integration

> **silero-vad has been promoted to a Spectra change.** See `openspec/changes/v2-2-silero-vad/` (currently parked).
>
> **OpenAI Whisper API compatibility has been promoted to a Spectra change.** See `openspec/changes/v2-3-openai-compat/` (currently parked).

---

## Considered and deferred

| Item | Why deferred |
| ---- | ------------ |
| **LocalAgreement-2 (N=2 consensus)** | Adds one more inference round-trip before the first partial appears. Conflicts with the v2.1 user feedback that wanted partials faster. May revisit if the simplified N=1 filter shows visible thrashing in practice. |
| **ct-punc Chinese punctuation restoration** (FunASR) | High value — streaming `/listen` final transcripts currently come back without zh punctuation. ~2 days work. Move to v2.3 if the v2.2 items land cleanly. |
| **Multi-format response (SRT / VTT / verbose_json)** | Sub-task of the OpenAI-compat work above; included by virtue of `response_format` support. |
| **Two-pass decoding (streaming Parakeet + Whisper batch final)** | Real big-co architecture but ~2-3 weeks of work + 2× memory footprint. Only justified if this project pivots to live-captioning-first. Tracked for v3.x. |
| **PWA front-end for `/listen`** | Tracked under the v2 PRD as v2.x. The OpenAI-compat work above opens the door to using existing third-party WebUIs as a stop-gap, which may obsolete a custom PWA. |
| **Streaming-native ASR model with Taiwanese Mandarin support** | Does not exist as an open-source model today (WeNet, NeMo, FunASR streaming are all Mandarin / Putonghua oriented). This is the only thing that would break the Whisper-architecture latency plateau. Out of scope unless the community publishes one. |

---

## Strategic direction: v3 desktop pivot (post-v2.x)

**Not yet committed.** The 2026-06-09 positioning discussion concluded
that the next major should pivot from "self-hosted server + PWA" to a
cross-platform desktop app. Detailed v3 planning (stack, phasing,
validation gates, decision log) is maintained in a private planning
workspace until launch. The license posture below stands and is
recorded here publicly on purpose.

### License posture (recorded direction)

> *Not legal advice.* This section records the strategic conclusion of
> the 2026-06-09 license discussion so future sessions reuse it instead
> of re-deriving.

**Current state**: engine is MIT. MIT explicitly permits commercial use,
SaaS hosting, closed-source forks, and rebranding. This is by design — MIT
cannot prevent any of these on its own.

**Concern**: maintainer does not want a third party taking whisper-wrap and
shipping it as a paid SaaS product.

**Conclusion**: do NOT pre-emptively relicense the engine. The right
posture for this project's stage is the **dual-track pattern**:

| Layer | License | Why |
| - | - | - |
| `whisper-wrap` engine (this repo) | **Stay MIT** | Engine is not the moat. FastAPI + faster-whisper integration is reproducible in a week by any competent engineer. MIT keeps the contributor pool open and signals trust. |
| Future desktop app (`apps/desktop/` or separate repo) | **Proprietary or FSL** | Real differentiation lives here: UX, code signing, auto-update, brand. A SaaS competitor would need to reproduce *all* of this, not just `pip install` the engine. |

**Triggers for revisiting**: only relicense the engine if **all three**
become true simultaneously:

1. A commercial product has shipped.
2. A real third-party SaaS competitor is using the engine.
3. That competitor is measurably eroding the project's revenue.

Premature relicensing (before product, before competitor, before revenue)
costs goodwill and contributor trust without protecting anything real.
MongoDB / Elastic / HashiCorp all relicensed only after all three triggers
hit, and still took public backlash for it.

**Defensive moves to take now (low cost, high option value)**:

1. **Add DCO (Developer Certificate of Origin)** via the
   [`probot/dco`](https://github.com/probot/dco) GitHub action.
   Preserves the ability to relicense later by establishing a clean
   contributor provenance chain. Without DCO/CLA, a future license
   change requires consent from every past contributor — typically
   impossible to obtain at scale.
2. **Add a "Commercial licensing available" note to README** with a
   contact email. Costs nothing; opens an inbound channel for
   companies that want to integrate the engine into proprietary
   products and would prefer a non-MIT arrangement.

**License options considered but rejected for now**:

| License | Why rejected at this stage |
| - | - |
| AGPL-3.0 | Would deter the contributors and users this project most needs to attract — many companies (notably Google) ban AGPL-licensed dependencies internally. The network clause is real protection but the contributor-pool cost is higher than the protection's current value. |
| SSPL | Not OSI-approved. Debian and several distros refuse to package SSPL-licensed software. Reputational cost outweighs technical protection. |
| BSL / FSL | Cleaner commercial protection than AGPL, but "source available" framing alienates pure-OSS users. Reconsider if a commercial desktop product launches and a SaaS competitor emerges. |

---

## Process

When picking up an item from this file:

1. `spectra-propose <kebab-case-name>` — opens the change with proposal /
   design / specs / tasks scaffolding.
2. Lift the problem statement, proposed change, and verification notes from
   here into the proposal artifacts.
3. Remove the entry from this file in the same commit that creates the change
   (so the roadmap reflects only NOT-yet-specced work).

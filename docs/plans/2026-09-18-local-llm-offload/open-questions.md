# Open questions

Part of [the local LLM offload design](overview.md).

## 4. Open questions (for Ondrej)

1. **"Gemma 4 2B and 4B, so 2-bit or 4-bit quantization"** conflates two axes.
   E2B / E4B are *model sizes*; Q4 / Q8 are *quantisations* of either. This
   document designs for **E2B and E4B at Q4_K_M by default with Q8_0 as the
   higher-quality option**. If 2-bit was meant: `Q2_K` / `IQ2_M` builds exist
   (§1.8), bartowski labels them "very low quality but surprisingly usable", and
   on these models the saving is small (E2B Q2_K is 3.02 GB against 3.46 GB for
   Q4_K_M, because the per-layer embeddings dominate the file) while the quality
   cliff is steep — 2-bit buys almost no RAM and costs most of the model.
   Recommend not offering it. Confirm the reading.
2. **Google's QAT `q4_0` or bartowski's `Q4_K_M` as the Q4 entry?** The
   first-party quantisation-aware build is smaller (3.35 GB against 3.46 GB for
   E2B, 5.15 against 5.41 for E4B), and quantisation-aware builds are normally
   *better* at the same width; §2.3 mirrors Google's by default. Phase 0
   decides on measured quality; both or one?
3. **Battery and thermal policy.** Skip on battery below a threshold or on a
   metered connection? Cheap to add; it is a behaviour a person must be able to
   see and switch.
4. **Audit sampling default for inline delegations.** Off keeps the lane fully
   off-Ledger; on catches a drifting small model early at a tiny cost.
5. **Is `required_for_local_sources` the right shape of "require"?** An org
   cannot sensibly force ordinary chat onto laptops, so "require local" is
   defined as "local sources may only be read locally". A stronger meaning
   ("this team may not use Ledger at all") is a different feature.
6. **Who owns a watch's messages on an org-scoped executor?** Phase 1 pins
   watches to the pairing owner and posts to that person's DM. A shared team
   executor with a shared channel destination is the subscriptions plan's "whose
   processor, whose audience" question again and needs the same org-level switch
   before it ships.
7. **Executor auto-update.** This design leans on catalogue revisions to push
   people to update an executor that cannot update itself. Is a Sparkle /
   MSI-upgrade story planned elsewhere, or should this plan carry it?
8. **Tool allowance for a watch.** §2.6 defaults `maxToolCalls` to 0 for a
   standing delegation and lets the orchestrator raise it to 3. With no gate
   in the path, 0 makes the common case say-only and the exception explicit;
   a higher default makes "when it fails, gather the evidence" work without
   the orchestrator asking. Which?

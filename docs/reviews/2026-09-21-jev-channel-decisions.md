# Jev channel decisions: Kimi review

Kimi reviewed commit `4630d0f60` through the installed `kimix` CLI on
2026-09-21. The review covered the channel decision standard, classifier
decision assembly, dispatch, hidden kickoff creation, policy authority and
Ledger decision client. It was a bounded code/design review; Kimi did not run
tests or inspect the settings interface, replay implementation or every reader.

## Findings and disposition

- **Unrecorded low-confidence choices:** addressed. The durable message
  snapshot now includes selected options, probabilities and threshold results.
  Abstention stays quiet in chat, while an operator can distinguish uncertainty
  from a confident no-action choice.
- **Policies too large to evaluate:** addressed. The shared policy schema
  rejects serialized policies over 16,000 UTF-8 bytes on save through the
  interface, REST or assistant tool. Multilingual and exact-boundary tests cover
  this limit; runtime caps still protect larger message/context combinations.
- **Confident reply with an uncertain recipient:** retained deliberately.
  The agent choice must independently meet the threshold; guessing a recipient
  would defeat that setting. The snapshot records the abstention and structured
  mentions continue to select a recipient directly.
- **Current source restrictions unioned with the saved snapshot:** retained
  deliberately and documented. Pinning a classification must not discard a
  source restriction present when its work is dispatched. The internal kickoff
  stores canonical basis and original-author rows in the same transaction.
- **Removed Personal Assistant binding in an authorization notice:** checked.
  The notice stores a stable user reference independently of the binding and
  uses fixed operational text. Removing a binding does not delete that user
  reference or grant execution permission. This was a verification question,
  not a demonstrated rendering defect.

Kimi found no demonstrated break in the authorization split within the files
it reviewed. That verdict is limited to the stated scope. A separate Codex
reader audit identified hidden system-message exposure through search/history;
that issue is tracked with the implementation's reader regression tests.

The durable implementation and verification contracts remain in
[the channel decision standard](../standards/channel-decision-policy.md) and
[the browser evaluation guide](../testing/channel-decisions.md).

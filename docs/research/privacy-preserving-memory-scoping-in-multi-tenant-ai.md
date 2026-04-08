# Privacy-Preserving Memory Scoping in Multi-Tenant Collaborative AI

## Context and threat model

Multi-tenant "organisational memory" creates a new class of confidentiality failures: the model is not merely answering a question, it is acting as a *cross-context conduit* between conversations with different audiences (management, HR, engineering, client channels) and different implicit "need-to-know" assumptions. The fact that retrieval is similarity-driven (vector search) makes "accidental cross-boundary recall" a default failure mode unless you build explicit boundaries into the retrieval and generation pipeline.

A useful way to structure the threat model is to separate *who* might cause leakage and *how* leakage occurs:

**Accidental leakage (benign user, benign agent):**
A correctly authorised agent instance in channel B may retrieve semantically relevant memories from channel A and include them in the model context, causing the model to surface details that members of channel B were never meant to see. This is exactly the kind of "higher-to-lower" information flow that classical information-flow control (IFC) aims to forbid.

**Adversarial leakage (malicious or curious user, or compromised inputs):**
Modern agentic/RAG systems make prompt injection and data exfiltration practical because untrusted content can be *retrieved* and then treated as instructions by the model or planner. Real-world incident analyses (e.g., the "EchoLeak" chain against Microsoft 365 Copilot) illustrate a pattern: untrusted external content (email/web/document) crosses a trust boundary, is blended into the assistant's context, and results in unauthorised access or exfiltration.

**System-level leakage (side-channels and metadata):**
Even if you block direct disclosure, an attacker can sometimes infer *membership* ("is this document in your retrieval store?") by probing the system and analysing outputs -- membership inference specifically tailored to RAG knowledge bases is now an active line of work.

In deployed collaborative AI, these risks appear in multiple places:
- **Retrieval-stage leakage:** returning a snippet/summary that should not be visible in the current audience.
- **Generation-stage leakage:** the model was shown sensitive context and paraphrased it, or combined multiple sources into an unsafe answer.
- **Planner/tool leakage:** an agent can route sensitive information into tool calls (tickets, email, CRM) or logs.
- **Store compromise leakage:** embeddings (and vector indices) can leak content, even when raw text is not directly stored alongside them.

Because your system is explicitly multi-tenant and multi-channel, the strongest practical framing is: **treat the model (and agent planner) as untrusted with respect to confidentiality**, and enforce confidentiality *at the boundaries* -- what data may enter the model context, what may be output to a given audience, and what may be sent to tools or persisted. This is precisely the philosophy behind IFC systems that were designed to tolerate untrusted code.

## Formal information-flow control and non-interference for memory scoping

### Non-interference as the "gold standard"
The classical notion of **non-interference** (informally: high/confidential inputs do not affect low/public outputs) formalises "information did not leak across a boundary". In the original state-machine framing, a security policy can be expressed as the requirement that actions by one set of users have no effect on what another set of users can observe.

For multi-channel AI memory, the analogue is:

- **High inputs:** memories and intermediate agent state derived from a confidential audience (e.g., management channel).
- **Low outputs:** responses posted into a broader or different audience (e.g., client channel, org-wide channel).

A system has the desired confidentiality property when outputs in a given channel are non-interfering with respect to secrets outside that channel's authorisation boundary.

### Decentralised Label Model and why it maps well to "conversation-derived memory"
Your "visibility levels + membership checks" approach is a form of discretionary access control. The step toward formal IFC is to represent access constraints as **labels** and to require that data only flows to outputs with compatible labels.

The **Decentralized Label Model (DLM)**, introduced by Andrew C. Myers and Barbara Liskov, is directly relevant because it supports *multiple mutually distrusting principals* and makes declassification ownership-aware. A DLM label is a set of per-owner policies (owner -> allowed readers). The model's intuition is "all policies in the label must be obeyed," so release requires a consensus of the owners' policies.

This "consensus of owners" is a very natural fit for organisational conversation memory, because a memory extracted from a conversation can be seen as jointly "owned" by:
- the organisation/tenant,
- the channel (as a policy container),
- and potentially each human participant or each message author (depending on how strict you want multi-party confidentiality to be).

### Your audience-compatibility check is a DLM-style restriction check (with an important directionality detail)
In DLM, a relabeling is considered a **restriction** (i.e., safe for confidentiality) when the set of readers permitted by the new label is a subset of those permitted by the original label.

Applied to your setting:

- Let **Readers(m)** be the set of principals allowed to read memory *m* (derived from its source context).
- Let **Audience(ctx)** be the set of principals who can read messages in the *current* context (channel/team/project).

A confidentiality-preserving flow from memory *m* into context *ctx* requires:
**Audience(ctx) <= Readers(m)** (only those who were authorised for *m* can see outputs influenced by *m*).

Your description says "a memory from channel A can only be surfaced in channel B if every member of channel A is also a member of channel B." Interpreted literally, that is **Audience(A) <= Audience(B)**, which would *not* prevent leakage (because B could contain additional people). The property that prevents leakage is the reverse: **Audience(B) <= Audience(A)**, i.e., everyone who can see the answer in B was already in A's audience. The DLM "restriction" definition corresponds to this safe directionality.

### Why access checks alone do not yield full non-interference in agentic systems
Even a perfect retrieval-time access check can fail to deliver an end-to-end non-interference guarantee if *any* of the following hold:

**Cross-context state persists.**
If the agent (or your memory service) caches summaries, tool outputs, or intermediate reasoning from a high context and later uses that state in a low context, then the low output can still depend on high inputs even without retrieving the original memory. End-to-end IFC systems handle this by *tainting the running computation state* (process label) and restricting outputs accordingly. Modern agent security work applies this idea directly to planners by tracking labels on messages, actions, tool calls, and results, and enforcing policies to prevent illicit flows.

**Declassification is effectively happening every time the model outputs.**
In IFC terms, generating text into a channel is "writing to an output channel". DLM explicitly treats output channels as labelled and relies on the enforcement mechanism to prevent leaks when data leaves the system.

**Integrity matters, not only confidentiality.**
Prompt injection is, in IFC framing, an integrity failure: attacker-controlled (low-integrity) input influences privileged actions or causes the agent to violate policy. The recent agent-security work that instruments planners with dynamic IFC explicitly targets this by tracking *both confidentiality and integrity labels* and enforcing policies that prevent illicit flows and prevent attacker-controlled data from triggering consequential actions.

A key practical conclusion from the modern agent-focused IFC work is: **you need enforcement around planner decisions and tool actions, not just around retrieval.**

### Declassification and "robustness" against manipulation
Real systems regularly require *sanitised release*: management discussion -> project update; HR meeting -> anonymised policy summary; incident response -> postmortem. In IFC, this is **downgrading/declassification**, and naive models can be vulnerable if untrusted inputs influence what gets declassified.

Work on downgrading policies and robust declassification builds on DLM's idea that each principal may only weaken its own policy, and that downgrading should be controlled by explicit authority.

More recent formal work on *nonmalleable information flow* shows that declassification mechanisms can be unsafe if attacker-controlled inputs can "shape" what gets released, motivating stronger conditions around endorsement/declassification interactions. This maps uncannily well to prompt injection: untrusted text (low integrity) tries to persuade the system to output secrets (a declassification-like event).

## Privacy-preserving RAG and embedding security

### Access control in RAG is necessary but incomplete
Most production RAG systems implement a form of "filter then retrieve" (or "retrieve then filter") using metadata/ACLs. However, the research literature increasingly treats the *retrieval database itself* and its embeddings as privacy-critical attack surfaces, not just the generated answer. A comprehensive 2026 review summarises RAG's attack surface as including corpus poisoning, membership inference, and other adversarial attacks.

Two implications for your memory system:
1. **Correct scoping must be enforced before the model sees content**, because once sensitive text is in the prompt, you are relying on an untrusted generator to "behave".
2. **The vector store is a privacy asset**: even if you never show a document, attackers may infer its presence or reconstruct it from embeddings if the store or embedding API boundary is compromised.

### Membership inference against RAG knowledge bases
Multiple papers show that an attacker can infer whether a target document (or passage) is present in a RAG database by probing the system and analysing responses.

- "Generating Is Believing" proposes an attack (S2MIA) using semantic similarity between generated content and a candidate sample, and reports strong membership inference performance, including bypassing representative defences evaluated in that work.
- "Is My Data in Your Retrieval Database?" gives a crisp black-box threat model: attacker can choose prompts and observe outputs; with crafted prompts ("does this appear in the context?" style), membership can be inferred for documents in the retrieval database; the paper also considers a grey-box setting with access to log-probabilities.
- More recent work explores alternative signals and calibrations (difficulty calibration, side channels like generation budget), highlighting that membership leakage can persist even when simple similarity heuristics are not reliable.

This matters to multi-tenant memory because it creates a leakage mode that is **orthogonal** to "audience compatibility":
Even if the agent never reveals a confidential memory verbatim, an adversary could still infer whether that memory exists in the store (e.g., "did the company discuss acquisition X?").

### "Benign query" extraction and why it complicates policy enforcement
Beyond membership inference, recent research shows **implicit knowledge extraction** attacks where queries look benign (no overt "ignore instructions" payload) but are iteratively mutated to explore the embedding space and pull out private knowledge from RAG systems.

From a policy perspective, this means:
- A system cannot rely solely on detecting explicit "exfiltrate secrets" intent in prompts.
- Retrieval constraints and rate limits become part of privacy enforcement, not just performance engineering.

### Embeddings are not "safe representations"
A recurring misconception in industry is that storing embeddings is safer than storing text. The literature does not support that assumption:

- A generative embedding inversion attack can reconstruct input sequences from sentence embeddings, and explicitly frames this as a privacy risk that is not well mitigated by current defences.
- "Text Embeddings Reveal (Almost) As Much As Text" reports that a multi-step inversion method can recover **92%** of 32-token inputs exactly for certain embedding models, and can recover personal information (e.g., names) in clinical notes.
- A dedicated study of embedding-vector databases frames a realistic threat model where an attacker obtains stored embeddings (e.g., via compromise) and trains an inverse model; it proposes "Embedding Guard" as a defence that tries to reduce the correlation between text and embeddings while preserving downstream utility.

For your design, this implies that **vector-store compromise should be treated as data compromise unless you have cryptographic or DP protections in place**, and even then you must understand the residual leakage.

### Differential privacy for embeddings and for RAG
Differential privacy (DP) provides a formal privacy guarantee, but applying it to embeddings and to RAG introduces steep utility trade-offs and architectural complexity.

**DP embedding release mechanisms.**
Work on "private release" of text embedding vectors proposes mechanisms that satisfy metric-space variants of DP and explicitly targets the privacy-utility trade-off for sharing embeddings.
Neighbourhood-aware DP mechanisms for word embeddings similarly calibrate noise based on local embedding neighbourhood structure to reduce unnecessary utility loss.
Metric-DP work (including industrial research) emphasises that the downstream-task impact depends strongly on task complexity and on the chosen metric/noise mechanism.

**DP at the RAG pipeline level.**
A concrete DP-RAG design ("DPVoteRAG") treats the external knowledge base as the sensitive dataset and aims to ensure (epsilon,delta)-DP with respect to that dataset. It explicitly assumes the base LLM is trained on data disjoint from the sensitive knowledge base, and then uses DP mechanisms (including a sparse vector technique component) to bound the influence of any single individual's record on the generated answer.

Operationally, DP-RAG is attractive when:
- you need *statistical privacy guarantees* against black-box probing, and
- your use case can tolerate reduced factuality/coverage and increased compute.

### Cryptographic privacy for retrieval
DP is not the only path. Some recent systems aim for **cryptographic confidentiality** of both documents and queries.

- A provably secure RAG framework ("SAG") claims pre-storage full encryption protecting both retrieved content and embeddings, with formal security proofs under a computational model.
- A cryptography-based framework ("Pisces") aims to protect both queries and documents and reports retrieval accuracy comparable to plaintext baselines (within a 1.87% margin), while using protocol techniques like oblivious filtering and labelled PSI for different retrieval paths.

These approaches are highly relevant if your threat model includes **vector store compromise** or **untrusted infrastructure operators** (common in multi-tenant SaaS).

## Need-to-know and context-dependent authorisation in collaborative AI

### Why "need-to-know" is not the same as "is member of group"
Your baseline model (private/channel/team/project/org) is essentially group- and scope-based. "Need-to-know" often requires *purpose* and *task context*:

- The same HR fact might be accessible to HR for payroll processing but not to HR for informal chat; the same client detail may be accessible to a specific account team but not to engineering; the same strategic planning note may be accessible in an M&A workstream but not in an all-hands Q&A.

Classic access control literature introduces several models precisely to represent these differences:

**Attribute-based access control (ABAC).**
The NIST guide frames ABAC as making access decisions based on subject attributes, object attributes, environmental conditions, and policies defined over those attributes. This is a natural fit for "context-dependent" retrieval conditions (time, incident state, client relationship status, on-call duty, etc.).

**Purpose-based access control (PBAC).**
Purpose-based models treat data elements as labelled with intended purposes and can encode explicit prohibitions ("do not use X for Y"), aiming to capture privacy constraints that are not just "who" but also "why".

**Relationship-based models.**
Relationship-based access control work (and related path-based models) formalises authorisation rules in terms of relationships (e.g., manager-of, assigned-to, client-contact-for) and supports foundations like separation of duty and "Chinese Wall" conflict-of-interest constraints -- important when an AI agent participates in multiple client contexts.

### Inference-aware policies: when the *answer itself* changes what the user learns
Even with correct ACLs, the system can leak through *inference*: users can combine multiple allowed answers to deduce a secret. Knowledge-based security policies explicitly model this by deciding whether to answer a query based on an estimate of the querier's knowledge (and how it would increase after the answer).

This is particularly relevant for LLM agents because:
- LLMs summarise and synthesise, which can reveal correlations (e.g., "there is a hiring freeze") without quoting a confidential source.
- Repeated querying can act like an adaptive attack, gradually extracting sensitive facts.

### "Need-to-know" enforcement as a multi-agent problem
A strikingly direct antecedent to your system exists in older multi-agent security work: a Carnegie Mellon paper proposes a multi-agent architecture for adaptive authorisation of access to confidential information and defines "need-to-know" authorisation as granting access only if the information is necessary for the requester's task/project; it treats the authorisation task as a text classification problem that must learn a supervisor's decision criteria with small labelled sets and aims for near-zero false alarm rates.

The key lesson for modern collaborative AI is that **need-to-know tends to require content- and task-aware gating in addition to static membership checks** -- but this immediately couples you to the limitations of automated sensitivity classification (false negatives) and to the difficulty of modelling "purpose".

## Automated sensitivity classification and realistic error rates

Automated sensitivity classification is attractive as a safety net ("detect HR/legal/compensation and tighten scoping"), but it is not a substitute for access control because the failure mode that matters most is the **false negative**: the classifier fails to recognise a sensitive conversation, the system stores it with a permissive label, and later retrieval leaks it.

### What the literature says about performance and trade-offs
**Enterprise DLP-style text classification can achieve low false negative rates in constrained settings.**
A PETS 2011 paper on "text classification for data loss prevention" reports experimental false negative rates on multiple enterprise corpora; in its reported configurations, false negative rates vary by corpus and strategy, including values around 3% in some cases (Table 1).
The same work explicitly acknowledges the trade-off: increasing supplemental "public" corpora can reduce false positives while increasing false negatives because the classifier becomes biased towards public documents.

**Sensitivity is context-dependent and often not topic-like.**
Work on technology-assisted sensitivity review for government documents emphasises that misclassifying a sensitive document is far more costly than misclassifying a non-sensitive one, motivating recall-weighted evaluation and human-in-the-loop workflows.
A government sensitivity dataset ("GovSensitivity") contains 3,801 documents with 502 sensitive examples tagged for FOIA sensitivities (personal information and international relations), highlighting that sensitivity categories may be both rare and heterogeneous.
On this dataset, reported models can have relatively high recall but modest precision and F1 (e.g., recall reported up to ~0.763, with F1 around 0.426 for one configuration), implying a non-trivial false negative rate even in a carefully defined task.

**LLM-based sensitive-topic detection can be strong in narrow domains -- but false negatives still appear.**
A 2024 study evaluating several LLMs for detecting "sensitive topics" reports false negative rates that vary substantially across models (e.g., 14% for one baseline model, ~1-2% for stronger models in that study's preliminary setting).
These results are promising, but they are not directly transferable to enterprise HR/legal/strategy detection because definitions, distributions, adversarial prompting, and organisational jargon vary widely.

### Practical implications for your memory system
From a systems standpoint, automated sensitivity classification is best treated as:
- a **defence-in-depth layer** that can *tighten* labels or route items to review, and
- a mechanism that can provide **probabilistic risk signals** (confidence/uncertainty) rather than binary truth.

If you rely on it as the primary guardrail, your threat model must include classifier evasion and distribution shift as first-class risks, especially as attackers learn what wording bypasses your detectors.

## Is audience compatibility sufficient, and what formal guarantees are realistically achievable?

### What your approach *does* buy you
If implemented in the **safe direction** (current audience is a subset of original audience), your audience-compatibility rule is essentially enforcing the same idea as DLM "restriction" relabeling: information only flows into contexts whose permitted readers are no broader than the data's permitted readers.

That is a strong baseline because it addresses the most common and damaging class of "accidental cross-channel recall" failures -- particularly those caused by vector similarity retrieval returning the wrong memory.

### Where it is not sufficient on its own
Audience compatibility at *query time* is not an end-to-end non-interference guarantee unless you additionally ensure that **no other state or channel** can carry high information into low contexts.

The main gaps, mapped to IFC concepts, are:

**Persistent state and multi-step agent workflows.**
If an agent instance reads high data in one context and later answers in a lower context, the answer can depend on high state even without retrieving high memories again. Dynamic IFC addresses this by raising the computation label when high data is read and restricting later outputs. Modern agent security work applies this idea directly to planners by tracking labels on messages, actions, tool calls, and results, and enforcing policies to prevent illicit flows.

**Integrity failures (prompt injection) can force leaks.**
Even if retrieval is correctly scoped, an attacker can sometimes manipulate the system into disclosing what it *can* access (e.g., by inducing unsafe tool calls or coaxing the model to reveal context). Real-world prompt-injection chains and formal analyses both treat this as a central security flaw in agentic/RAG systems.

**Inference and membership leakage.**
Audience compatibility controls disclosure of memory *content*, but it does not prevent:
- membership inference ("is this document present?"),
- side-channel inference (e.g., behavioural differences under varying generation budgets),
- or iterative extraction via benign queries exploring embedding space.

If your threat model includes external users probing a client-facing agent, these become relevant even when direct memory content never leaks.

**Vector-store compromise.**
If an attacker obtains embeddings, inversion/reconstruction attacks can recover substantial text. Audience compatibility does not help here because the leak bypasses "retrieval to generation" and attacks the storage layer directly.

### What "formal guarantees" are feasible in practice
Because LLMs are hard to verify, the most realistic path to formal-ish guarantees is to **treat the model as a black box** and reason about *what it is allowed to observe and where its outputs may go*.

Concretely, you can aim for:

**A boundary non-interference guarantee:**
If confidential memories do not enter the model context in a low-authorisation channel, then (ignoring model memorisation from pretraining) the model's outputs in that channel cannot depend on those confidential memories. This is a coarse but meaningful guarantee that reduces to correct enforcement of "what enters context" and correct control of cross-context state.

**Dynamic IFC for agent execution graphs:**
Instrument the agent runtime (planner, tool calls, memory reads/writes) with confidentiality and integrity labels, and enforce policies at every "sink":
- posting a message into a channel,
- writing to long-term memory,
- sending tool outputs (email, tickets, CRM),
- logging/telemetry.

This is exactly the direction taken by recent work on securing AI agents with IFC, which characterises guarantees achieved by enforcing policies with dynamic IFC and explicitly targets both prompt injection safety and illicit information flows.

**Controlled declassification pipelines:**
Treat "summarise management discussion into project update" as an explicit declassification event requiring authority, and defend against manipulation (nonmalleability / robust declassification) so that untrusted inputs cannot steer what is released.

**Storage-layer confidentiality for embeddings:**
If you cannot tolerate "vector store compromise = plaintext compromise," you likely need DP and/or cryptographic retrieval designs (encrypted embeddings, private query protocols). Recent proposals in RAG security directly target this layer.

### A synthesis: when your audience-compatibility rule is enough, and when it is not
Your audience-compatibility rule (implemented as **Audience(current) <= Audience(source)**) is close to a correct IFC *flow check* for direct retrieval-based disclosure. It is likely sufficient **only** under a constrained operational model:

- agent instances are isolated per context (no shared hidden state across channels),
- no cross-context caches or tool result reuse,
- no external adversarial users probing the system,
- vector store and embedding service are fully trusted,
- and you do not need to release sanitised summaries across boundaries.

Once you relax any of these (multi-agent handoffs, tool use, external clients, shared infrastructure, declassification workflows), audience compatibility becomes a necessary but insufficient component of a broader **information-flow and integrity enforcement** story.

# Review of the Nessie Multi-Agent Memory System

**Reviewer:** Gemini
**Date:** 2026-04-09
**Verdict:** The design contains a compelling vision but is undermined by significant internal contradictions, a reliance on non-existent "magic" components, and a failure to address critical implementation details, particularly concerning feedback loops, cost, and security. In its current state, it is not a blueprint for a robust, scalable system but rather a collection of ambitious but disconnected ideas.

---

## 1. CONTRADICTIONS

The documents are inconsistent, presenting a vision that the detailed designs and current state audits fail to support.

**1.1. Promised vs. Delivered Memory Types:**
- **Contradiction:** The overview in `docs/multi-agent-memory-system.md` prominently features seven memory types, with "Procedural" and "Framing" memory marked as "PRIORITY: HIGH". However, the `Current State Audit` section in the same document admits these are "Not started". The detailed `memory-pipeline-design.md` focuses almost exclusively on `Intent` and `Reason` types, which map loosely to the `Semantic` and `Reasoning` types from the overview.
- **Impact:** The system's highest-ROI features exist only as proposals. The core pipeline design doesn't account for them, suggesting they are not truly integrated into the architecture.

**1.2. The Non-Existent "Skill Promotion Pipeline":**
- **Contradiction:** `docs/the-agents.md` describes a clear pipeline: "successful run → self-eval captures procedural memory → human/agent promotes to candidate skill → tests pass → skill approved". However, `docs/multi-agent-memory-system.md` confirms that both the self-eval loop and procedural memory capture are "Not started". The skill system itself is also a future item.
- **Impact:** This is a fantasy. A pipeline cannot exist if its start, middle, and end points are all undefined. It misrepresents the system's maturity and capability.

**1.3. Flawed Security Logic:**
- **Contradiction:** `docs/memory-pipeline-design.md` contains a section, `Research-Informed Design Updates`, which explicitly flags a critical error: "our audience compatibility check has the directionality wrong... Verify our `match_thoughts_scoped()` implements this correctly." Despite this warning, the proposed SQL function in `docs/memory-security-and-scoping.md` appears to implement the flawed logic of checking if the source channel's members are a subset of the current channel's, not the other way around.
- **Impact:** The system is designed with a known, critical security flaw that could lead to data leakage across audiences. The design acknowledges the research but fails to correctly implement its findings.

**1.4. Agent as a Glorified Search Box:**
- **Contradiction:** `docs/the-agents.md` details an execution flow where memories are retrieved and injected into the prompt. However, the system prompt then instructs the LLM: "Do not emit tool-call markup or request more tool execution."
- **Impact:** This fundamentally neuters the agent. It cannot use memory to inform new actions or tool calls within the same reasoning loop. The agent is not acting on memory; it is merely summarizing it. This contradicts the entire premise of an agentic system.

---

## 2. EVAL AND FEEDBACK LOOP GAPS

The system's self-improvement capabilities are based on feedback loops that are either entirely theoretical or deeply flawed.

**2.1. The "Self-Eval" Magic Wand:**
- **Gap:** The entire self-eval loop, described in `docs/multi-agent-memory-system.md`, hinges on a "hidden evaluation prompt" that produces a complex, structured JSON output. This is hand-waved magic. No such prompt is provided. There is no analysis of whether a cheap model like `gpt-4o-mini` can reliably generate such structured output or the associated cost of running this after every single task.
- **Impact:** The core engine for capturing procedural, framing, and missing memories is a black box that likely does not work as specified.

**2.2. "Missing Memory" Detection is a Guess:**
- **Gap:** The mechanism for detecting what memory *should have existed* relies entirely on the `missing_memories` field from the fictional self-eval output.
- **Impact:** The system has no practical way to identify its own knowledge gaps.

**2.3. `was_referenced` is Brittle and Unreliable:**
- **Gap:** `docs/memory-pipeline-design.md` states that `was_referenced` is determined by whether the agent's response references content from the memory. This implies a simple string-matching or fuzzy-matching heuristic. The cited research in `docs/research/memory-retrieval-and-reranking-in-multi-agent-systems.md` explicitly warns against this simplistic view, noting that "unused is not the same as irrelevance" due to factors like prompt budget and position bias.
- **Impact:** The primary positive signal for the reranker is based on a noisy, unreliable heuristic that ignores the nuances of how LLMs use context. This will generate poor-quality training data.

**2.4. Signal Aggregation is Naive:**
- **Gap:** The aggregation rules in `docs/multi-agent-memory-system.md` are simplistic. A "negative" signal from a memory being injected but not referenced is weak at best. The system has no mechanism to handle false positives in reference detection, which will poison the training data.
- **Impact:** The training data for the reranker will be polluted with mislabeled examples, leading to a model that performs poorly or degrades over time.

**2.5. Reranker Pipeline is a Placeholder:**
- **Gap:** The Phase 5 reranker is an idea, not a design. There are no specifics on model architecture, training data volume requirements, or the infrastructure for training and deployment. The cold-start problem is acknowledged but "solved" with equally vague proposals like "synthetic queries".
- **Impact:** The system's core promise of improving retrieval over time is not backed by a buildable plan.

**2.6. Open to Adversarial Attack:**
- **Gap:** The documentation contains zero discussion of adversarial inputs to the feedback loop. A malicious or disgruntled user could systematically downvote helpful memories or craft prompts to game the `was_referenced` signal.
- **Impact:** The memory's usefulness ranking can be easily manipulated, degrading the system for all users.

---

## 3. MEMORY TYPE GAPS

The proposed high-priority memory types are superficially defined, ignoring the hardest implementation problems.

**3.1. Procedural Memory's "Generalization" Step is Undefined:**
- **Gap:** The proposal in `docs/multi-agent-memory-system.md` claims the system will compress raw tool calls into generalized steps (e.g., `docker logs my-service-abc` becomes `docker logs {service_name}`). This generalization is the most difficult and most important part of the process, and it is completely unexplained. What LLM prompt or algorithm can reliably perform this abstraction?
- **Impact:** Without a solution to this core problem, procedural memory capture is impossible.

**3.2. Framing Memory's Validation is Shallow:**
- **Gap:** The validation step for Framing memory is described as checking if "referenced files still exist." This is trivial and insufficient. The value of a framing memory is in its understanding of architecture and patterns, which can become outdated and harmful even if all the files still exist. The design lacks a concept of "conceptual" staleness.
- **Impact:** The system will knowingly inject outdated and potentially harmful architectural assumptions into the agent's context.

**3.3. Episodic Memory Lacks a "Situation" Embedding:**
- **Gap:** Retrieval of episodic memories relies on "situation similarity." But the design fails to define how a "situation" is embedded. If it's just a text embedding of the description, it's no different from semantic memory and fails to capture the structural elements of a situation (e.g., actors, constraints, actions taken).
- **Impact:** Episodic memory, as designed, is not functionally different from semantic memory, and will not provide the "have I seen this before?" capability it promises.

**3.4. Memory Types are Siloed:**
- **Gap:** The documents describe a set of memory types but provide no mechanism for them to interact. The "Target Retrieval Architecture" is a simple sequence of lookups, not an integrated query that can, for instance, use a `Procedural` memory step that retrieves a value from a `Semantic` memory.
- **Impact:** The memory system is a collection of separate databases, not an integrated cognitive architecture.

---

## 4. SCALING AND COST

The design ignores the operational reality of running such a system at scale. The cost model is unsustainable.

**4.1. Unexamined Latency:**
- **Gap:** The architecture proposes hybrid search, RRF fusion, and a future reranker with zero analysis of the performance impact. What is the latency budget for a retrieval call? How does it perform with 100k, 1M, or 10M thoughts?
- **Impact:** The system will likely be unacceptably slow at any significant scale.

**4.2. Prohibitive Runtim Costs:**
- **Gap:** The design mandates an LLM call for self-evaluation after every non-trivial task and another LLM call for metadata/reasoning extraction on every conversation turn. This is an unbounded cost center.
- **Impact:** The operational cost of this memory system will be astronomical, rendering it economically non-viable for any active organization. The "local-first filtering" mitigation is punted to "FUTURE".

**4.3. The Unpruned Recall Ledger:**
- **Gap:** The `thought_recalls` table, which logs every single retrieval operation, has no defined pruning, archiving, or aggregation strategy.
- **Impact:** This table will grow indefinitely, becoming an operational and performance bottleneck. It is a time bomb.

---

## 5. WHAT IS MISSING FOR A COMPLETE SYSTEM

Beyond the gaps above, the design omits several components required for any robust, multi-agent system.

**5.1. No Garbage Collection or Decay:** There is no automated process for the system to forget or down-weight information that is old, unused, or consistently rated as unhelpful.

**5.2. No Conflict Resolution:** The system cannot handle two agents storing contradictory facts. It relies on a `SUPERSEDES` link that must be explicitly created. There is no mechanism for detecting and resolving conflicts that arise organically.

**5.3. No Memory Model for Agent Forking/Cloning:** The agent hierarchy is described, but the memory implications of creating new agents (cloning, forking) are ignored. This is a fundamental aspect of agent collaboration.

**5.4. No Security Model for Agent-Creation:** The security model does not cover the scenario where one agent creates another. This is a critical security vulnerability, as it leaves open the possibility of privilege escalation or data leakage.

**5.5. No Concrete Skill Promotion Pipeline:** The process of turning a captured procedural memory into a validated, reusable skill is mentioned but not designed. The review, testing, and approval workflow is missing.

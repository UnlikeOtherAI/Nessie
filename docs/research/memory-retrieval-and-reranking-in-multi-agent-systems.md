# Memory Retrieval and Reranking in Multi-Agent Systems

## Why cosine similarity breaks down for long-lived agent memory

A pure vector-similarity pipeline—store each memory as an embedding and retrieve by cosine similarity in a vector index—is a strong "first-stage" retriever, but it is not a complete relevance model. Dense embeddings are optimised to pull semantically related items together, not to decide whether a candidate is *contextually appropriate* for a specific conversation state, speaker identity, task intent, or temporal situation, which is why you see "semantically similar but contextually wrong" false positives. This mismatch is repeatedly observed in IR benchmarks: lexical baselines like BM25 remain robust in diverse settings, and the strongest systems often rely on multi-stage ranking (candidate generation → reranking) rather than a single similarity score.

The specific stack you described is a canonical modern setup: embeddings produced by OpenAI's `text-embedding-3-small` default to 1536 dimensions (unless you request dimensionality reduction), and cosine-based similarity search is typically executed via a vector index such as pgvector inside PostgreSQL.

However, when "memories" are conversational artefacts spanning months/years, relevance becomes *conditional*: a memory that is "about the same topic" may be wrong because it is about a different person, an outdated preference, a different project, or a past plan that has since changed. Recent long-context and long-term dialogue benchmarks explicitly highlight topic drift and long-range causal/temporal dependencies as hard cases; adding retrieval helps but still leaves substantial gaps versus human performance, underscoring that retrieval quality (and filtering) is a bottleneck rather than a solved engineering detail.

A useful framing is: your current cosine retrieval is doing "high recall neighbourhood search in embedding space". The missing component is "fine-grained relevance scoring under context", which is the classic intent of rerankers and learning-to-rank approaches.

## Learned reranking beyond cosine similarity

Modern retrieval stacks almost always separate **candidate generation** from **reranking**. Candidate generation must be fast and scalable; reranking can be slower but more accurate because it sees a small list (top-*k*) and can apply heavier models/features. This multi-stage design is explicit in IR "design pattern" literature (keyword/dense first-stage retrieval followed by neural rerankers).

In practice, there are four reranking families worth distinguishing for your scale (tens of thousands of memories), ordered from "most standard" to "most specialised".

**Cross-encoders (pairwise scoring with joint attention)**
Cross-encoders concatenate (query, candidate) and predict a relevance score in one forward pass, allowing full token-level interaction between query and document. This "query-document pair encoding" was popularised early by BERT passage reranking and remains a strong baseline for reranking because it directly models interaction rather than compressing each text into a single vector.

For RAG-style memory retrieval, cross-encoders are often used exactly as you propose: retrieve top-*k* by embeddings, then rerank those *k* candidates with a learned scorer that sees richer context. Many production rerank APIs (e.g., provided by Cohere) describe their rerank models as cross-encoders designed to reorder results returned by an existing retrieval method.

Why this fits your scale: with tens of thousands of memories, you do *not* need an ultra-fast neural retriever for end-to-end search if you can rerank ~50–200 candidates per conversational turn. Cross-encoders are typically too expensive for scoring every memory, but are very realistic as a second-stage model. The BGE reranker model card and docs, for example, explicitly position cross-encoder rerankers as "rerank top-100 retrieved" in a two-stage pipeline.

**Sequence-to-sequence rerankers (MonoT5 / DuoT5 and variants)**
A distinct line of work uses T5-style seq2seq models for reranking and combines pointwise ("Mono") and pairwise ("Duo") rerankers, sometimes alongside document expansion ("Expando"). This is presented as a reusable multi-stage ranking blueprint that achieves near-SOTA in several benchmarks and supports zero-shot transfer in some settings.

For your application, the takeaways are pragmatic: (a) a *pairwise* reranker can explicitly learn "A should be above B for this query/context" rather than predicting absolute scores, and (b) cascade designs (fast model → slower model) can keep latency controlled.

**Late-interaction models (ColBERT/ColBERTv2)**
Late-interaction methods sit between bi-encoders (single-vector cosine similarity) and cross-encoders. ColBERT encodes queries and documents independently but retains per-token embeddings; relevance is computed by token-level max-sim interactions aggregated across the query. This improves expressiveness versus single-vector similarity without requiring full cross-attention over concatenated text.

ColBERTv2 refines the approach and discusses a key trade-off: late-interaction often requires substantially larger storage footprints than single-vector indices because you store many vectors per document, even if retrieval is efficient.

For your scale (tens of thousands), ColBERT-style indexing is *feasible*, but it may be *engineering overkill* unless you have very tight latency constraints and want to avoid GPU reranking at request time. If you can afford reranking 100 candidates with a cross-encoder, ColBERT's main advantage (fast end-to-end retrieval on huge corpora) is less compelling.

**Listwise rerankers and LLM reranking**
Listwise learning-to-rank predates LLMs (e.g., ListNet, LambdaRank/LambdaMART) and optimises ranking metrics more directly than pointwise losses.

More recently, LLMs have been used as listwise rerankers by prompting them to reorder a set of passages. Tooling such as RankLLM focuses on reproducible multi-stage pipelines and supports families like RankGPT/RankZephyr.
A very practical constraint is context length: listwise LLM rerankers often can only take ~10–20 passages at a time and use sliding-window reranking to handle top-100 lists.

For your memory system, LLM listwise reranking is usually "late-stage polish" rather than the core solution: it can improve top-10 ordering, but can be expensive/variable, and may complicate deterministic behaviour. RankLLM explicitly discusses non-determinism and reliability concerns in LLM APIs, which are relevant when reranking becomes part of an agent's core cognition loop.

## Training with mostly implicit signals and effective negative mining

Your proposed training tuple—(query, memory, context, signal) where signal is positive/negative based on "memory used in the response"—maps closely to learning-to-rank from implicit feedback (clicks, dwell time, etc.). The central challenge in that literature is: *non-selection is not the same as irrelevance*, because the system's presentation policy shapes what gets examined and thus what can be "used". Counterfactual and propensity-weighted learning-to-rank explicitly targets this bias.

A key conceptual match to your system is **exposure bias**: if your agent only ever sees top-*k* memories, "unused" candidates outside top-*k* are unlabelled rather than negative; even within top-*k*, the agent may ignore something relevant due to prompt budget, reasoning path, or redundancy. Counterfactual LTR frameworks (inverse propensity weighting and later refinements) were built precisely to learn from such biased observational logs.

### Practical negative mining strategies that generalise well

In dense retrieval and reranking work, three negative types are repeatedly useful, and they map cleanly to your memory setting.

**In-batch negatives (cheap, strong baseline)**
Dense retrievers like DPR popularised in-batch negatives: in a minibatch, each query treats other queries' positive passages as negatives, producing many "challenging enough" negatives at low cost. DPR also mixes in a BM25 negative to diversify negative difficulty.

**Hard negatives mined by retrieval (the ones your cosine step finds)**
Hard-negative mining addresses a known bottleneck: random negatives are often too easy and yield weak gradients. ANCE directly samples negatives from an ANN index built from the model itself, updating the index as training progresses, to better match the negative distribution at test time.

For you, "cosine-top-*k* but unused" is already a form of hard-negative mining. The twist is how you interpret it: treat these as **weak negatives** (low-confidence) rather than absolute negatives, because many will be "relevant but not used". This is where pairwise/listwise losses and debiasing become helpful: you can train the model to prefer *used* memories over *unused-but-exposed* memories without asserting the latter are strictly irrelevant. The implicit-feedback ranking literature (e.g., BPR) formalises this idea as learning pairwise preferences from implicit interaction events.

**Mixed negatives by difficulty (stability and calibration)**
Combining random negatives, "near-miss" semantic negatives (high cosine, unused), and "lexical distractor" negatives (high token overlap but wrong entity) tends to stabilise training and reduce brittleness across query types—especially when memories include names, projects, or time-specific facts. This aligns with benchmark observations that robust systems often integrate lexical and semantic signals rather than relying on one.

### Reducing bias in the "used memory" label

If your "used" label is derived from internal traces (e.g., whether a memory was inserted into the prompt, cited by the model, or referenced by tool calls), you can make the supervision more faithful by structuring the agent to *explicitly decide* what it used and why. Work in conversational RAG increasingly trains/elicits the model to decide when to retrieve, rewrite for retrieval, and judge passage relevance before answering (building on Self-RAG-like ideas). This provides a more direct and inspectable signal than post-hoc heuristics.

If you do not randomise candidate presentation during data collection, you should expect position bias (top-ranked candidates are more likely to be used). Unbiased LTR work proposes IPS/DR estimators and joint bias estimation (e.g., Unbiased LambdaMART) precisely to train rankers under such positional biases.

## Context-dependent retrieval for multi-agent memory

Your requirement—"the same memory should rank differently depending on who is asking and in what conversation"—is well aligned with three mature research threads: personalised retrieval, conversational retrieval (history-aware intent modelling), and agent memory architectures that explicitly encode time/importance.

### Conditioning retrieval on the agent and the conversation

Long-term memory systems for LLM-based agents increasingly store *more than raw turns*: they store summaries, user portraits/preferences, or abstractions to support context-dependent recall. MemoryBank, for example, explicitly stores multi-turn records plus hierarchical summaries and personality inferences, and uses a dense retrieval component (DPR-like) over those memory pieces; it also introduces a time-and-recall-based updating/forgetting mechanism inspired by forgetting curves.

In a multi-agent platform, "agent identity" plays a similar role to "user identity" in personalised search. Personalised dense retrieval frameworks incorporate user-specific preferences into retrieval by augmenting the retrieval model with user-conditioned components (e.g., attention over user signals).

The practical implication for your reranker is straightforward: make the scoring function explicitly conditional, e.g.
**score = f(query_text, conversation_state, agent_profile, memory_text, memory_metadata)**,
rather than hoping cosine similarity implicitly captures those conditions. This is strongly supported in memory-agent architectures where "what is relevant depends on relevant to what?", and retrieval is explicitly conditioned on a query memory/current situation.

### History-aware (conversational) retrieval and denoising

Conversational retrieval research highlights that naively embedding the last user turn is often insufficient; historical turns can be helpful or harmful depending on topic shifts. History-Aware Conversational Dense Retrieval (HAConvDR) explicitly targets this by reformulating queries with denoised context and mining supervision based on the measured impact of historical turns.

Similarly, conversational query rewriting (e.g., CONQRR and later multi-query rewriting methods) exists partly because "the intended query" is under-specified in a single utterance; rewriting aims to produce a better retrieval query without retraining the entire retriever.

For memory retrieval, this maps to: represent the query as a *conversation-state object* (summary + current user goal + constraints + agent role), not just the latest message embedding.

### Time, importance, and structured memory as ranking features

Even before learned rerankers, several agent-memory systems reduce false positives by adding simple, interpretable factors alongside semantic relevance:

- Generative Agents' retrieval score is an explicit weighted combination of **relevance (cosine similarity), recency (exponential decay on last access), and importance (LLM-assigned poignancy)**, normalised to [0,1].
- MemoryBank's "forget/reinforce" update mechanism makes recall depend on elapsed time and memory strength, not only semantic similarity.
- TiM proposes "thought" organisation and selective recall to support long-term reasoning without repeatedly reprocessing full history.
- H-MEM proposes hierarchical memory levels to narrow retrieval to relevant subspaces and reduce irrelevant participation range.

For your learned reranker, these factors can be incorporated either as extra tokens (metadata -> textual features) or as structured numeric features in a learning-to-rank model (e.g., LambdaMART) alongside neural scores. Classical learning-to-rank work (LambdaRank/LambdaMART, ListNet) is designed to combine heterogeneous features and optimise ranking metrics, which is often attractive when you have strong non-text signals like time, author, agent-id, and "last-used-by-this-agent".

## Cold start bootstrapping without enough signal data

Cold start is usually where memory systems fail in practice: you need acceptable relevance before you can collect reliable implicit feedback, but you need feedback to train the reranker.

The most effective bootstraps are **multi-signal** and **teacher-driven**.

### Start with multi-signal retrieval before any learning

A robust early-stage approach is **hybrid candidate generation**: combine semantic retrieval with lexical retrieval (BM25 or sparse neural methods) and fuse rankings (e.g., Reciprocal Rank Fusion). RRF is a classic, parameter-light rank fusion method shown to consistently improve combined rankings across retrieval systems.
Sparse neural first-stage rankers like SPLADE are explicitly motivated by the value of exact term matching while preserving semantic expansion and efficient inverted-index retrieval.

In memory retrieval, lexical signals matter disproportionately because names, project codes, and specific commitments often determine contextual correctness. BEIR's emphasis that BM25 remains a robust baseline across heterogeneous tasks is a strong empirical argument for hybridising early instead of over-committing to dense similarity alone.

### Use off-the-shelf rerankers as teachers

Because you only have tens of thousands of memories, you can often use an existing cross-encoder reranker "out of the box" for reranking top-*k*, then later distil/finetune to your domain. Practical examples include BGE rerankers (open models) and commercial rerank APIs.

A common bootstrapping strategy is **teacher -> student distillation**:
1) retrieve candidates with your current system;
2) rerank with a strong teacher (cross-encoder or LLM listwise reranker);
3) train a smaller/faster student on teacher-labelled (query, candidate, score/rank) pairs.
This is implicitly supported by the modern ecosystem around LLM reranking (RankLLM reproduces multiple teacher-like reranking methods and highlights the practical integration of rerankers in multi-stage pipelines).

### Generate synthetic supervision and queries

If you lack labels, synthetic data generation for retrieval is now well established:

- Doc2query/docTTTTTquery generate likely queries for a document and index them or use them to create training pairs.
- InPars proposes unsupervised dataset generation for IR using LLMs to create query-document pairs; later work continues to extend these pipelines.
- HyDE generates a hypothetical "ideal document" for a query using an instruction-following LLM, then embeds it with an unsupervised retriever to find real neighbours; it is explicitly designed for zero-shot dense retrieval without relevance labels.
- Unsupervised dense retrieval pretraining (Contriever) provides strong retrieval starting points without labelled data and is often used as a base for fine-tuning.

For your use case, the most directly applicable bootstrap is: generate *memory-seeking questions* from each stored memory (or memory cluster), then train the reranker/retriever to rank that memory highly for those questions. This does not require user feedback and gives you initial "what would retrieve this?" supervision. The doc2query and InPars families are essentially industrialised versions of this idea.

### Evaluate using public long-term memory benchmarks (even if your domain differs)

Even though your memory is agent-specific, benchmarks like LoCoMo are valuable for stress-testing long-horizon conversational memory (topic drift, multi-session dependencies) and for comparing retrieval+reranking variants under controlled conditions. LoCoMo explicitly targets very long dialogues over many sessions and shows that retrieval helps but does not solve the problem, making it a good regression suite for retrieval improvements.

## Architectures and training workflows that match your scale

At tens of thousands of memories, your "overkill threshold" is largely determined by latency budgets, GPU availability, and how many agents can concurrently retrieve.

### A scale-appropriate default architecture

A strong, non-overkill blueprint for your setting is:

**Candidate generation (fast, high recall)**
Use your existing embedding retrieval (pgvector cosine) as one channel, and add a lexical channel (BM25 or sparse retrieval) to reduce entity/name false positives; fuse with a simple method like RRF or weighted score fusion. This leverages pgvector's strength as an in-database ANN/exact similarity layer while hedging with lexical matching.

**Second-stage reranking (high precision)**
Rerank top-*k* (typically 50–200) with a cross-encoder that takes: (conversation summary + last user message + agent role/persona + candidate memory text + key metadata rendered as text). Cross-encoders are explicitly designed to model query-document interactions, and are widely positioned as the reranking component after an initial retriever.

**Optional third-stage (only if needed)**
If you need maximal top-5 quality and can tolerate latency/variance, apply listwise LLM reranking on the top-10/20 after cross-encoder reranking. Beware context-length limitations and sliding-window complexity if you try to rerank top-100 directly with an LLM.

### Training the reranker with your implicit "used memory" signal

A practical training approach that aligns with the literature is:

- Treat each conversation turn as a "query instance" with an associated candidate list (what retrieval surfaced and exposed).
- Prefer **pairwise** or **listwise** objectives over pure pointwise classification, because many "negatives" are actually "not used" rather than "irrelevant". Classical and modern LTR work provides the theoretical and empirical basis for these objectives.
- Implement **hard-negative mining** from your own retrieval: include high-cosine unused memories as weak negatives; mix with random negatives to avoid collapse; and periodically refresh hard negatives (ANCE-style motivation: negatives should resemble test-time confusions).
- Debias for exposure/position: if your logging policy is "always take top-*k* by cosine", you inherit position bias analogous to click logs; consider IPS/DR-inspired weighting or controlled randomisation of candidate ordering during data collection to improve identifiability.

### What is likely overkill at tens of thousands of memories

**Training a custom dense retriever from scratch** is often unnecessary initially if you already have good embeddings and your main pain is contextual false positives; the literature strongly supports fixing this with reranking and hybrid signals first.

**Full ColBERT-style production indexing** may be overkill unless you need extremely low latency without GPU reranking. Late-interaction brings storage/index complexity (many vectors per memory) to gain retrieval-time interaction power—a trade that is most compelling at very large corpus scale.

**Listwise LLM reranking as the primary reranker** is usually overkill because of context-length constraints, sliding-window engineering, cost, and non-determinism concerns; it is best treated as an optional top-*n* refinement or as a teacher for distillation.

### What is "just enough" and tends to work

The strongest "just enough" recipe, supported across IR and agent-memory work, is to combine: (1) hybrid candidate generation, (2) a cross-encoder reranker trained with hard negatives and implicit-feedback-aware objectives, and (3) explicit context features like recency/importance/agent-id. The fact that agent architectures like Generative Agents and MemoryBank explicitly add recency/importance and hierarchical summaries is a strong indicator that *context features are not optional* in long-lived memory retrieval.

# Reasoning Provenance and Decision Traceability in Knowledge Management

## Why this problem is hard and why the research community keeps returning to it

Capturing "why" is fundamentally different from capturing "what". In software and product work, decisions and their rationales are distributed across time, people, and media: meeting talk, chat threads, issue comments, design docs, code reviews, and commits. The classic design-rationale community explicitly modelled design as *argumentation* around ill-structured ("wicked") problems rather than as a clean sequence of requirements -> design -> implementation. Horst W. J. Rittel and Melvin M. Webber framed policy/planning problems as "wicked" and not definitively specifiable; this way of thinking later shaped argumentation-oriented rationale methods in design and software.

That framing matters for your use case (intuition in message 5 -> reframing in message 12 -> evidence in message 20 -> confirmation in message 35) because it implies two requirements that many early tools underestimated:

1) rationale is *evolutionary* (statements get reworded, narrowed, superseded, or partially rejected), and
2) rationale must be *retrievable and attributable* long after the conversation ends, including after the artefacts it justified have been refactored or renamed.

A useful bridge vocabulary comes from provenance standards. The W3C's PROV data model defines provenance as information about "entities, activities, and people" involved in producing something, with extensibility points for domain-specific detail. While PROV was designed for general provenance interchange, its graph model is directly relevant to "reasoning provenance": you can treat decisions as *activities*, rationale statements as evolving *entities*, and participants as *agents*, then encode derivation links between conversation, evidence, and the shipped artefact.

## What thirty-plus years of design-rationale work tried, what failed, and what endured

### Argumentation models and tools: IBIS, gIBIS, QOC, DRL, Compendium

Early systems in design rationale attempted to represent the structure of deliberation explicitly. In practice, they converged on graph-shaped "rationale networks", even when their notations differed, because argumentation is inherently relational (issues connect to options and supporting/attacking arguments).

A canonical example is gIBIS, a hypertext tool built to operationalise IBIS-style discussions as networks of issues, positions, and arguments. Its authors observed something that maps almost one-to-one onto your "message 5 -> 12 -> 20 -> 35" challenge: an "issue base" is a vehicle for an evolving discussion, where the original framing of an issue may later be recognised as biased or based on a presupposition that becomes explicit and is rejected. They also highlight the need to manage "outdated" material in the network (some parts become wrong or irrelevant while others remain linked to active regions), recommending explicit mechanisms to indicate "age and relevance" and -- critically -- human responsibility for the "currency and hygiene" of the knowledge base.

QOC (Questions, Options, and Criteria), introduced as a semi-formal notation for Design Space Analysis, treats design rationale as a representation of the *design space around an artefact*: questions identify issues, options propose answers, criteria evaluate options. Allan MacLean and colleagues' paper explicitly defines these constituents, as well as positioning Design Space Analysis as a constructed companion to the artefact rather than a passive by-product. QOC is strong for trade-off reasoning and comparing alternatives, but it is not naturally a chronological "conversation trace" unless you explicitly attach conversational evidence to each Q/O/C element.

DRL (Decision Representation Language) aimed to increase expressive adequacy: Jintae Lee and Kum-Yew Lai argue that whether you "reap benefits" from rationale depends heavily on the representational language; they note that if rationales were represented only in free text, benefits might not exceed what you already get from informal meeting notes, and computational support depends on what the representation makes explicit and how formal it is. This is an early articulation of a dilemma you will face: free-form conversation captures nuance but is hard to query reliably; rigid structure is queryable but costly to maintain.

Compendium is important because it represents a pragmatic pivot from "pure rationale capture" to "meeting facilitation + incremental structuring + publishable outputs". The Compendium methodology positions the face-to-face meeting as a major knowledge event and claims strategies for real-time capture and integration of hybrid material (predictable/formal and unexpected/informal), producing a reusable group memory, and transforming that resource into formats suited to different stakeholders (including document generation from maps). A later retrospective chapter on Compendium's lineage explicitly foregrounds "overheads" and the "intrusive" nature of graphical argument maps as adoption obstacles, and argues that human factors (skills, facilitation, training, fitting work practices) were more decisive than raw software quality.

### What failed in practice and why it keeps repeating

A 2000 survey of design rationale systems reviews many prototype systems across domains and concludes that, despite substantial effort, none had achieved widespread industrial use; many remained laboratory prototypes with few real-world deployments. Later reflections in the software-engineering rationale community echo the same concern: despite decades of research and many advocates, rationale is still unlikely to be captured in practice, and empirical evaluation of many rationale projects was limited.

Across this literature, the recurring failure modes are consistent:

- **Capture overhead and "intrusiveness"**: explicit rationale formalisms interrupt flow and demand extra work at precisely the moment teams are optimising for speed, alignment, and delivery.
- **Misaligned incentives**: rationale producers pay the cost now; rationale consumers often benefit later (sometimes years later), so teams under-produce and under-maintain rationale.
- **Staleness and inconsistency**: rationale and artefacts drift unless maintenance is a first-class workflow. Both gIBIS and later empirical work call out the need for upkeep and the risk of inconsistency when designs evolve.
- **Over-formalisation vs under-structure**: users resist systems requiring extensive explicit structure; incremental formalisation emerged as a response to this "formality barrier".

The key meta-lesson is that the *representation* is rarely the main problem; the socio-technical system around capture and maintenance is. The Compendium experience explicitly states that quality software support is necessary, but "human factors" required closer attention for embedding in day-to-day practice.

### What endured and scaled better: lightweight decision records, by-product capture, and value-based rationale

In contrast to heavy, graph-first systems, modern industrial practice has gravitated toward *lightweight decision records* as a minimum viable unit of rationale. Jeff Tyree and Art Akerman's architecture decision template (popular in architecture documentation) is one precursor. Michael Nygard popularised "Architecture Decision Records" (ADRs) as short documents describing one significant decision and its consequences, emphasising that consequences of one decision become context for subsequent decisions -- i.e., decisions form a dependency chain.

Importantly, architecture standards explicitly encode rationale expectations. The ISO/IEC/IEEE 42010 architecture description standard states that the "rationale for a decision" can include the basis, alternatives and trade-offs considered, potential consequences, and citations to additional information. This standardisation matters because it turns "write down the why" from an ad hoc good habit into a specifiable artefact type that tools can validate, search, and cross-link.

Two durable research directions also map directly to your system design:

- **Rationale as a by-product of work**: rather than asking people to do "extra documentation", capture artefacts produced anyway by structured processes (e.g., negotiation artefacts, decision templates, meeting maps). The "WinWin" approach explicitly frames rationale capture as cost-effective when it is embedded in the negotiation process and the tool captures negotiation artefacts as part of normal work.
- **Value-based / purpose-driven capture**: empirical work argues you should document only what is likely to be valuable for defined downstream activities. A controlled experiment on "value-based" design rationale documentation reports that a customised rationale document can contain substantially less information than a full template (reported average around 46% of information items) while targeting the information categories most needed for specific activities, explicitly motivated by reducing known inhibitors to rationale documentation.

The combined takeaway is that the most promising systems either (a) reduce capture friction dramatically (lightweight ADR-style), (b) integrate capture into meeting facilitation and publishing workflows (Compendium-style), or (c) formalise only the parts needed for known future tasks (value-based documentation), while accepting that some detail will remain in raw conversation traces.

## Automated extraction of argumentation from multi-turn conversation

### What "argument mining" can do today

Argument mining is generally defined as automatically identifying and extracting the structure of inference and reasoning in natural language, not just the stance but the supporting reasons. Surveys describe a common pipeline: detect argumentative spans, classify components (claim/premise/evidence), identify relations (support/attack), and sometimes build a global argument graph.

Multi-turn conversation adds specific difficulties beyond single documents:

- **Context dependence and coreference**: later turns refer back to earlier claims with pronouns, ellipsis, or shorthand; without dialogue context, component classification becomes brittle.
- **Dialogue structure effects**: conversational moves (questioning, agreeing, challenging, proposing) correlate with argumentative roles, and newer models explicitly incorporate dialogue acts and conversational context to improve relation prediction in discussions.
- **Incremental revision**: reasoning often emerges as reformulations rather than as clean premise->conclusion structures; meeting-argument diagramming work highlights the need to account for interruptions, partial arguments, and structural negotiation in talk.

Empirically, much argument mining research has used online debate corpora, such as the Internet Argument Corpus (IAC), which provides large-scale multi-post discussions annotated for stance and other pragmatic features. These resources help with modelling argumentative discourse, but engineering conversations differ: they contain code, references to tickets, architecture constraints, and organisational context that is not explicit in the text.

### Towards rationale extraction in software engineering communications

Recent work is increasingly targeted at software-development text sources:

- One line of work treats developer discussions as the substrate for latent "design information" that can be located and structured, motivated by the idea that design intent and trade-offs are embedded in discussion even when not captured in formal documents.
- Rationale extraction has been attempted in long-running decision archives such as the Python core developers' email discussions, using heuristics-based methods to identify rationale-containing sentences that are otherwise "hidden" in email threads.
- A 2024 proposal ("DRMiner") claims an approach that uses large language models plus sentence features to extract and pair rationale-relevant sentences from Jira issue logs, then construct rationale structures.
- Another emerging approach is to extract rationale from commit messages and assemble it into an ontology-backed knowledge graph, including dataset creation and classifier evaluation for rationale elements.

Taken together, the state of the art suggests partial automation is plausible, but end-to-end faithful reconstruction of a "developing chain" across dozens of turns is still research-grade: the surveys emphasise persistent challenges around implicit premises, missing markers, and context sensitivity, while meeting-oriented work shows the gap between clean argument diagrams and messy real conversation.

For your system, this implies a practical stance aligned with older rationale lessons: treat automated extraction as *assistive* (suggesting candidate claims, evidence, alternatives, constraints, and decision points) and design for incremental correction and restructuring over time -- i.e., automation feeding an incremental-formalisation workflow rather than "push-button rationale graphs".

## Linking rationale to implementation artefacts and surviving refactoring

### Traceability in software engineering: why it breaks

The traceability literature is explicit that traceability is about following artefacts over their lifecycle, and that links are valuable for tasks like validation, change management, and impact analysis. However, links are often absent or implicit, and recovering them later is difficult because documentation and code live at different abstraction levels and in different formalisms (free text vs programming languages).

Information-retrieval approaches (e.g., latent semantic indexing) have long been used to recover documentation<->code links by leveraging identifiers and comments as semantic signals, arguing that a large amount of domain knowledge is encoded in names and comments, and emphasising that statistical IR can reduce the cost of recovery compared to heavy knowledge-base or parsing approaches. The same work also makes an uncomfortable assumption explicit: automated meaning extraction depends on "reasonably named" identifiers and comments; otherwise, deriving meaning automatically (or even manually) becomes far harder.

Even if you recover links once, evolution breaks them. A refactoring-aware traceability model paper points out that many approaches use absolute paths or fully qualified names as identifiers; such identifiers are unique at a point in time, but refactorings (rename/move package/class, folder moves) change them and break history tracking unless you reconstruct continuity across renames. That paper proposes persistent "CodeBlockID" identifiers and uses refactoring detection (e.g., RefactoringMiner) to stitch together code-block histories across name changes, explicitly to preserve trace links across refactoring.

### Rationale-aware architecture models and design-to-code linkage

A complementary research direction is to embed rationale directly into architecture models so that "why" can be traced to design objects. A rationale-based architecture model (AREL) is presented as capturing relationships between design rationale and architecture elements, supporting traceability for change impact analysis and root-cause analysis, motivated by the claim that absent rationale makes it harder to detect inconsistencies and conflicts and to understand assumptions and constraints.

Design-to-code linkage has also been studied more locally. "Design Pattern Rationale Graphs" are presented as making explicit relationships between design concepts in a pattern and linking those concepts to implementing code, with case studies claiming low-cost support for identifying design goals and improving confidence about how goals are realised in a code base.

Architecture-knowledge work similarly treats design decisions, assumptions, and context as first-class "architectural knowledge" and argues for preserving graphs of decisions and their dependencies to support evolution and maintenance. Philippe Kruchten proposes an ontology of architectural design decisions and emphasises preserving interdependencies, while later architectural-knowledge work defines architectural knowledge as including decisions, assumptions, and context that determine why an architecture is the way it is.

The standards perspective reinforces this: ISO/IEC/IEEE 42010 explicitly expects architectural decisions to have rationale including alternatives/trade-offs, consequences, and citations. This aligns with traceability needs but underscores a practical gap: standards can say what "should be captured", but toolchains must make capture cheap and maintenance normal.

### A provenance-centric view of "why does this exist?"

To answer "why does this UI component / API endpoint / DB column exist?" after refactors, you need two kinds of resilience:

- **Artefact identity resilience**: the link target must remain findable across renames/moves; refactoring-aware identifiers and history reconstruction address this at code level.
- **Rationale provenance resilience**: the rationale claim must point to evidence and the conversational path that produced it, not just to a summary. Provenance models like PROV provide a graph vocabulary for entities/activities/agents and derivation relationships, and "decision provenance" work argues for using provenance methods to expose decision pipelines (chains of inputs, decisions/actions, and downstream effects), motivated by accountability and audit needs.

Your system can treat each "crystallised reason" as a node derived from many conversational micro-nodes (message fragments, linked evidence, intermediate reframings), while simultaneously anchoring the final rationale node to one or more artefact identities that can be resolved through code history. This is, in effect, combining rationale graphs (IBIS/QOC/DRL lineage) with provenance graphs (PROV/decision provenance lineage).

## Knowledge decay, organisational amnesia, and empirically supported preservation strategies

### Why institutional "why" disappears

Organisational memory research commonly defines organisational memory as stored information from an organisation's history that can be brought to bear on present decisions, and emphasises that memory is distributed across locations (people, routines, artefacts, systems) rather than residing in one place. This distribution is exactly why "why" decays: you can keep code but lose the people; you can keep tickets but lose the context; you can keep docs but lose trust in whether they're current.

Turnover is a major empirical driver of knowledge loss. A 2023 systematic review on knowledge loss induced by organisational member turnover is based on 91 empirical studies and maps antecedents and outcomes across contexts. In software projects specifically, turnover-induced knowledge loss has been operationalised using version-control history: one replication study treats files as "abandoned" when a high proportion of their lines are last touched by developers who have left, and reports that abandoned files can persist for long periods (including reporting that a significant share of abandoned files remain for at least two years).

Crucially, this shows why "git-blame is not enough": version control attributes *what changed* to a developer, but does not preserve the *reasoning* behind the change, and after leavers exit, even the implicit knowledge embedded in code becomes harder to access.

### What preservation strategies have evidence behind them

A key empirically grounded insight is that retention is not only about capturing *task knowledge* ("what they know"), but also *relational knowledge* ("who they know and how work gets done"). A widely cited study on preventing knowledge-loss crises argues that departing employees take not only subject-matter expertise but organisational memory of why key decisions were made and awareness of past projects; it critiques approaches that only codify documents because captured knowledge may not be found, interpreted correctly, or trusted enough to be used, and because codification misses the network of relationships that makes knowledge actionable. It proposes organisational network analysis as a way to identify vulnerabilities tied to key roles (connectors/brokers/peripheral players) and to target retention strategies accordingly.

The design-rationale literature converges on an analogous point: even when rationale capture tools exist, adoption depends on work practices, training, and clear value. Compendium's long-running deployment highlights facilitation and learnability (training courses, templates) as mechanisms to negotiate the cost/benefit trade-off, and emphasises that sustained use required attention to human practice, not just tooling.

Finally, broader knowledge-management research on failures repeatedly identifies socio-organisational failure factors (e.g., leadership support, culture, uncertainty about what specificity level is worth capturing), implying that "capture everything" repositories often fail, while purpose-driven, culturally supported practices are more robust.

For your system, the evidence-backed implication is that preserving "why" needs both (a) capture mechanisms integrated into everyday work and (b) ongoing curation, whether through explicit roles (facilitator/curator), lightweight incentives, or workflows that surface staleness and require renewal.

## Design implications for a modern system that captures developing reasoning chains

### Model the problem as dual graphs: rationale structure and provenance structure

The historical lesson is that you should not choose between "structured rationale" and "raw conversation"; you need both, linked.

- **Rationale structure graph** (IBIS/QOC/DRL family): nodes for issues/questions, options/positions, criteria/constraints, arguments/evidence, and decisions (with status and consequences). This aligns with established representational primitives (Issue/Position/Argument in gIBIS; Question/Option/Criterion in QOC; richer spaces in DRL) and with the observation that benefits depend on what is made explicit.
- **Provenance graph** (PROV + decision provenance): nodes for entities/activities/agents and edges like "wasDerivedFrom", "wasGeneratedBy", "used", "wasAttributedTo". This enables explanation queries to traverse from a shipped artefact back through decisions, evidence, and conversational origins.

This combination directly addresses your "message 5 -> 12 -> 20 -> 35" requirement: the rationale graph holds the *crystallised* reason and its structure, while the provenance graph preserves the *genealogy* of that crystallisation across time and reframing.

### Adopt incremental formalisation as a first-class workflow, not a rescue strategy

The most relevant older insight is that requiring full formal structure up front fails, yet leaving everything as raw text prevents reliable retrieval and analysis. Shipman & McCall's integrated perspective proposes capturing design communication and incrementally structuring it into argumentation and other formalisms over time; Compendium operationalises this through templates, tagging, and facilitation around live meetings.

A practical pattern that follows from the literature:

- **Capture first, structure progressively**: ingest conversation streams and attach them to provisional issue nodes ("this seems like the issue under discussion"), then allow later consolidation into stable issue/decision records. gIBIS explicitly flags that older issue framings may be biased or outdated; designing for revision is essential.
- **Make staleness visible**: store timestamps, confidence, and "superseded by" relations; gIBIS suggests age/relevance cues and assigned responsibility for hygiene, while empirical work lists inconsistency and misalignment as inhibitors.
- **Value-based capture**: decide which rationale categories are mandatory (e.g., "decision + status + consequences + key constraints"), and make richer capture optional or triggered by specific downstream needs. Controlled experiments on value-based rationale documentation support the feasibility of capturing substantially less than "everything" while targeting utility.

### Treat artefact linking as a resilience problem and design for refactoring from day one

If your rationale links break when code is reorganised, users will stop trusting the system. The refactoring-aware traceability model literature demonstrates that identifiers based on paths or names break under common refactorings, and proposes reconstructing history through refactoring detection and persistent IDs.

A research-aligned approach is:

- attach rationale to **stable artefact identities** (e.g., code-block IDs with rename history, schema-element IDs, API operation IDs) rather than to unstable names;
- store **multiple anchors** (e.g., code entity + commit range + test name + interface contract), so that if one anchor changes, the link can be re-resolved using others; this echoes traceability recovery work that treats linking as probabilistic and benefits from multiple textual signals (identifiers/comments + docs).
- support **semi-automated link recovery** (IR-based suggestions) for legacy rationale and for post-refactor reconciliation, acknowledging that explicit links are rarely present and recovery tools exist for that reason.

### Use automated argumentation extraction as a drafting assistant, not as the system of record

Given current argument mining capabilities and known limitations in dialogue, the most robust architecture is to use NLP/LLM extraction to propose candidate nodes and relations, then route them through incremental formalisation and human review. This matches both (a) the argument mining surveys' emphasis on difficulty of deep reasoning extraction and (b) decades of rationale research showing capture must fit human practice and must be maintainable.

Recent software-engineering-specific rationale mining (issue discussions, email archives, commit messages, knowledge graphs) suggests concrete starting points for extraction targets -- rationale-bearing sentences, alternative proposals, and constraints -- but also implicitly reinforces the need for ground-truth datasets and evaluation, which earlier rationale work notes was too often missing.

### Evaluate the system the way the researchers say the field failed to: with downstream tasks and longitudinal drift

A repeated critique in rationale research is the lack of empirical evaluation and the uncertainty about practitioner needs, even after many years of work. Your system's evaluation should therefore be built around the downstream tasks that motivate provenance:

- **Answerability of "why" queries** (can a maintainer reconstruct constraints, alternatives, and evidence?) aligns with the definition of rationale content and its intended benefits.
- **Change impact and root-cause analysis effectiveness** aligns with rationale-aware architecture traceability goals.
- **Resilience under refactoring** aligns with refactoring-aware traceability findings that naive identifiers break history.
- **Longitudinal knowledge retention under turnover** aligns with organisational knowledge-loss models and empirical findings on abandonment persistence.

The highest-leverage historical lesson is that "capturing rationale" cannot be a single feature. It must be a socio-technical loop: lightweight capture embedded in work, progressive structuring, explicit maintenance cues, refactoring-resilient artefact identity, and provenance links that keep conversational origins accessible. The strongest prior art for this loop is the combined lineage of gIBIS/Compendium (evolving conversation maps + facilitation), ADR-style practice (lightweight decision records), traceability recovery (semi-automated linking), and provenance graphs (explicit derivation chains).

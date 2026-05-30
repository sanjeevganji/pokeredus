# Toward an Object-Oriented, Class-Based Generative AI Architecture

## Executive overview

This report surveys existing research that is most relevant to building a new generative AI system whose core representational primitive is an object/class, with relations also treated as classes, all mapped into a multidimensional embedding space and refined top‑down under a reinforcement-style feedback loop.
It connects your idea to prior work in frame-based and object-oriented knowledge representation, knowledge graphs and their embeddings, object-centric learning, self-organizing maps and concept-formation networks, neuro-symbolic reasoning and RL, and recent object-oriented KR frameworks such as KRROOD.[^1][^2][^3][^4][^5]
The report then sketches a concrete architecture and training loop for an object/class-based AI, and discusses feasible strategies for extracting knowledge from existing LLMs, building problem-specific class maps, and keeping memory and compute bounded using modern tools.

## 1. Conceptual lineage of your idea

### 1.1 Frames, semantic networks, and OOP

Class- and object-based knowledge representations were studied long before modern deep learning, primarily as frames and semantic networks.[^6][^7][^1]
Minsky introduced frames as data structures for stereotypical situations or concepts, composed of slots (attributes/relations) with values that can be atomic or pointers to other frames, combined with inheritance from more general frames.[^7][^6]
Frame systems already exhibit several properties you want: object-like concepts, inheritance hierarchies, slots that can point to other frames (relations-as-objects), and a notion of defeasible defaults for reasoning under typical-but-not-universal context.[^8][^6][^7]

Semantic networks similarly represent knowledge as nodes (concepts/objects) and arcs (typed relations such as IS-A or PART-OF), which were later generalized into knowledge graphs using RDF/OWL and SPARQL for querying.[^1][^6]
Modern frame-based systems are structurally very close to conventional OOP: classes correspond to frames, object instances to individual frames, and slots/attributes to fields; inheritance provides taxonomic structure, and procedures attached to frames resemble methods.[^8][^6][^1]

### 1.2 Knowledge graphs and embeddings

Knowledge graphs represent a large set of entities and typed relationships as triples \\(h,r,t\\) in a graph, and are widely used for structured knowledge in production systems such as Google’s Knowledge Graph and Wikidata.[^9][^10][^1]
Knowledge graph embedding (KGE) methods map entities and relations into vectors in a continuous space while preserving relational structure, enabling efficient link prediction, reasoning, and retrieval.[^11][^12][^10][^13][^9]
Surveys of KGE models describe translation-based methods such as TransE and its variants, bilinear models like DistMult and ComplEx, and more expressive neural and graph-neural approaches that learn entity and relation embeddings jointly with scoring functions.[^12][^10][^13][^9][^11]
This directly supports your requirement that classes and relations be embedded in a vector space suitable for semantic similarity and compositional reasoning.

### 1.3 Object-oriented KR with native classes (KRROOD)

Recent work explicitly addresses the "object-ontological impedance mismatch" between classical KR systems and OOP by representing concepts as native classes in a language like Python.[^14][^2][^3][^15]
The KRROOD framework treats knowledge as first-class programming abstractions: concepts are Python classes, taxonomic relations are expressed via inheritance, and relations are class attributes or n-ary functions, all accessible to regular application code.[^2][^3][^15]
KRROOD includes a Python-native query language (EQL) over these objects, ripple-down rules for incremental knowledge acquisition, and tools to import ontologies (OWL) into class hierarchies, showing a practical route for OOP-based symbolic knowledge paired with efficient querying and rule-based reasoning.[^3][^15][^2]
This demonstrates that an object/class-based representation can support nontrivial reasoning at scale and integrate with conventional software stacks.

### 1.4 Cognitive architectures and object-based working memories

Cognitive architectures such as Soar and ACT-R represent the agent’s state as a symbolic graph of objects and relations, with explicit long-term procedural and declarative memories and online learning mechanisms.[^16][^17][^18]
In Soar, working memory is a symbolic graph rooted in a state object; procedural memory is a set of if–then rules that match against this graph to propose and apply operators, and semantic memory stores reusable graph substructures as general knowledge.[^18][^16]
Soar’s spatial-visual system uses a scene graph of objects and subobjects with spatial properties, similar to modern scene graphs in vision and to your idea of class-based structures coupled to perceptual input.[^16]
This line of work shows that a unified object graph can support decision-making, learning, and perception for general agents, and that online, incremental learning on such structures is feasible.[^17][^18][^16]

## 2. Learning object-centric and class-centric representations

### 2.1 Object-centric learning and slots

Object-centric learning in deep vision explicitly aims to discover object-like units rather than monolithic feature maps, using mechanisms such as Slot Attention.[^4][^19][^20][^21][^22]
Slot Attention is a module that takes a perceptual representation (e.g., a CNN feature map) and produces a set of "slots"—exchangeable vectors that bind to individual objects or parts via iterative attention and competition, enabling compositional generalization to unseen object combinations.[^19][^20][^21][^22][^4]
Extensions like adaptive slot attention learn to dynamically choose the number of slots per instance, addressing the need for variable complexity and suggesting architectures where the number of conceptual units is input-dependent and learned.[^21]
These works provide practical building blocks for perceptual front-ends that output discrete object-like representations, which could then be promoted to classes in your system.

### 2.2 Self-organizing maps and concept trees

Self-organizing maps (SOMs) learn a low-dimensional grid of neurons whose weight vectors approximate the distribution of high-dimensional input vectors, preserving topological relationships.[^23][^24][^5]
As training proceeds, nearby neurons in the map represent similar inputs, which has been used for visualization, clustering, and "manifold tree" structures for content management and knowledge discovery.[^24][^5][^23]
Work on generating concept trees from growing SOMs shows how SOM units can be hierarchically grouped into higher-level concepts, suggesting a path to building top-down concept hierarchies where each node corresponds to a cluster over clusters.[^25][^5]

Earlier theoretical work such as Amari’s concept-formation networks and related recurrent nets show that sequential networks with recurrent connections can self-organize into equilibrium states corresponding to clusters (concepts) of stimuli, with orthogonal and covariance learning rules governing formation and retention of concept patterns.[^26]
These ideas can inspire mechanisms for autonomous class formation and refinement based on clustering of object embeddings and dynamic allocation of new class nodes.

### 2.3 Knowledge graph structure and embeddings as class maps

Knowledge graphs already organize entities into taxonomies with IS-A and PART-OF relations, which are essentially class hierarchies and compositional relations.[^10][^6][^1]
Surveys on knowledge graph structure and embeddings point out that KGE models for link prediction can be strongly influenced by graph structure, and that graph topology can be exploited for tasks like bias detection and performance prediction.[^27][^10]
In practice, this means that your object/class graph, once embedded, can support efficient link prediction, type inference, and class refinement by leveraging existing KGE methods to score candidate relations and class memberships.

## 3. Neuro-symbolic AI and class formation via RL

### 3.1 Neuro-symbolic AI and KG reasoning

Neuro-symbolic AI integrates neural networks with symbolic structures such as logic, knowledge graphs, and ontologies, aiming to combine data-driven learning with explicit reasoning and explainability.[^28][^29][^30][^31]
A major line of work focuses on neurosymbolic reasoning over knowledge graphs, where symbolic logic rules or deductive databases complement knowledge graph embeddings to support expressive reasoning and better generalization.[^29][^28]
Taxonomies of neurosymbolic methods for KGs distinguish logically informed embedding approaches, embedding models with logical constraints, and rule-learning approaches, each offering different ways to shape or interpret the embedding space.[^28][^29]
These methods match your desire for class-based structures that live simultaneously as symbolic objects and vectors, with constraints guiding how they evolve.

### 3.2 Neurosymbolic reinforcement learning

Neurosymbolic reinforcement learning (NSRL) explicitly combines symbolic structures with RL, using either learning to improve reasoning, reasoning to guide learning, or tightly integrated learning-reasoning cycles.[^30]
A survey on NSRL categorizes work by whether the symbolic part provides structured state abstractions, constraints, or high-level options, and whether the neural part handles perception, function approximation, or policy learning.[^30]
Concrete neurosymbolic RL examples include conditioning RL policies on knowledge graph embeddings; for instance, projects where a graph encoder produces task embeddings that serve as "recipes" for different tasks, enabling structured transfer (coffee → tea) by freezing the graph encoder and fine-tuning the policy.[^32]
This pattern is directly relevant to your proposed self-improvement loop: the class graph and its embeddings can define a structured state or task space that the RL agent uses to select actions such as refining classes, adding relations, or choosing reasoning strategies.

### 3.3 Class expression refinement as RL

There is also work that explicitly models class expression learning (finding logical class descriptions) as an RL problem.
For example, the DRILL framework treats description logic class expression learning as a refinement problem in an infinite state space, using a deep Q-network and refinement operators to efficiently search for class descriptions that match examples.[^33]
DRILL demonstrates how RL can operate over symbolic class constructors and refinement steps, optimizing cumulative discounted rewards such as accuracy or compactness of class expressions.[^33]
This suggests a concrete approach for your system: use RL policies over class refinement operators (split, merge, specialize, generalize, retype relation) with rewards derived from predictive performance, compression, or external feedback.

## 4. A concrete high-level architecture

This section sketches one feasible architecture that respects your constraints: classes as first-class objects, relations as classes, vector embeddings for all nodes and edges, dynamic class formation and refinement, and an RL-style improvement loop.

### 4.1 Core data structures

At the heart of the system is a typed, attributed graph:

- Node types:
  - ConceptClass: corresponds to a concept or type (e.g., "PrimeNumber", "NeuralNetwork", "Temperature")
  - Instance: individual cases or entities (e.g., the number 7, a specific paper)
  - RelationClass: a class representing a relation (e.g., "isA", "partOf", "greaterThan", "causes")
- Edge types:
  - Instance-of: Instance → ConceptClass
  - Subclass-of: ConceptClass → ConceptClass (taxonomic hierarchy)
  - Relation-instance: RelationClass → (subject, object) or a hyperedge capturing n-ary relations

This is essentially a typed knowledge graph / frame system, but each ConceptClass, RelationClass, and Instance has:

- A symbolic representation (class/struct with fields and methods) in the host language, akin to KRROOD’s Python classes or Minsky-style frames.
- A learned embedding vector in a shared continuous space, similar to KGE or object-centric slot vectors.[^9][^2][^3][^11][^12]

Relations-as-classes can be represented using either reified nodes in a standard knowledge graph or hypergraph structures, with generalized relational neural networks or hypergraph neural networks handling message passing.[^34][^35][^36]

### 4.2 Perception and text interfaces

To interface with existing data and LLMs, the system needs encoders that map external inputs into the class graph:

- Text encoder: A (possibly frozen or distilled) transformer or alternative text encoder maps text into contextual token embeddings, which are then aligned with ConceptClass embeddings via contrastive objectives or prompting existing LLMs to identify relevant concepts and relations.[^37][^1]
- Perceptual encoders: For images or structured data, use object-centric modules such as Slot Attention or similar object discovery architectures to produce slot vectors that are then bound or matched to existing ConceptClass instances or used to propose new ones.[^20][^22][^4][^19][^21]

Rather than using a full LLM internally, this design treats LLMs as external tools that can:

- Suggest candidate classes and relations from text descriptions ("extract ontology fragment from paragraph").
- Provide weak supervision for mapping raw text spans to ConceptClasses.
- Generate natural language descriptions of existing classes for human inspection.

### 4.3 Embedding and reasoning layers

Over the base graph, several learned components operate:

- Graph embedding layer: A KGE or graph neural network (GNN) that learns embeddings for ConceptClass, RelationClass, and Instance nodes, optimized for link prediction, type inference, and other self-supervised tasks such as predicting masked edges.[^13][^11][^12][^10][^9]
- Symbolic reasoning layer: Optional rule engines or description-logic reasoners (similar to KRROOD’s RDRs and EQL queries) perform exact inference, constraint checking, or ontology-based reasoning.[^15][^2][^3]
- Hybrid neurosymbolic reasoning: Neural components propose candidate facts or refinements; symbolic components validate them against constraints or derive additional consequences.[^31][^29][^28][^30]

Reasoning tasks (answering queries, planning, generating text) can be framed as functions over this graph: first retrieve a relevant subgraph, then perform symbolic inference and/or run neural decoders to produce outputs.

### 4.4 Self-improvement loop via RL

The self-improving aspect can be built as an RL agent operating on the class graph:

- State: current snapshot of the relevant subgraph (classes, relations, embeddings, and possibly statistics such as usage counts or prediction errors).
- Action space: operations on the class graph, such as:
  - CreateClass(parent, definition)
  - SplitClass(existing, criterion)
  - MergeClasses(c1, c2)
  - AddRelationClass(domain, range)
  - AddConstraint(class, rule)
  - RetypeInstance(instance, new_class)
  - Promote frequently co-occurring patterns to new RelationClass.
- Reward signals:
  - Predictive performance: improvement in accuracy or likelihood on held-out link prediction or downstream tasks.
  - Compression: reductions in description length when explaining data via the class hierarchy.
  - Human feedback: explicit reinforcement for useful or interpretable class structures.

Similar to DRILL’s use of a Q-network plus refinement operators over class expressions, this RL agent can be trained to discover effective refinement sequences, using rollouts over candidate class graphs and evaluating them via symbolic and neural metrics.[^33]
Neurosymbolic RL work shows that RL can effectively be guided by symbolic structures and that structured state representations enable better generalization and sample efficiency.[^30]

## 5. Mining and compressing knowledge from existing LLMs

### 5.1 Using LLMs as ontology extractors

Existing LLMs can be leveraged as teachers to bootstrap the class graph without embedding their full parameterization.
Given text, code, or documentation, LLMs can be prompted to output:

- Entity and concept lists, with suggested hierarchies ("list main concepts and subtypes in this domain").
- Relations between concepts, with explicit type signatures.
- Prototypes and counterexamples for each class, which can be used as positive and negative instances for training embeddings and constraints.

This process is akin to ontology learning or schema induction, but uses LLMs as heuristic pattern matchers rather than as the primary knowledge store.[^31][^1]
The resulting candidate classes and relations can be filtered and grounded using graph-embedding scoring, symbolic consistency checks, and RL-based refinement.

### 5.2 Distillation into class embeddings

Knowledge distillation techniques from large models to smaller ones, and from models to KGs, can be adapted to map LLM behavior into class graph embeddings.
For example:

- Query the LLM with many prompts that probe semantic similarity, analogy, and entailment across a candidate concept set; use the response patterns as supervision signals for learning embeddings that preserve these relations.
- Use techniques similar to knowledge graph completion: treat LLM outputs as noisy labels for edges and relation types, and train KGE or GNN models to fit these edges while regularizing toward consistency and sparsity.

Surveys on KG embeddings note that simpler models can match more complex ones when trained with strong regularization and modern optimization, suggesting that compact yet expressive embeddings are feasible.[^12][^10][^13][^9]
This supports your goal of minimal space and compute, by compressing LLM-derived relational knowledge into a relatively small set of class and relation vectors.

### 5.3 Problem-specific class maps and specialization

For a given problem domain (e.g., robotics, theorem proving, DevOps), you can maintain a domain-specific class map that is a subgraph of a larger general ontology.
Class maps can be induced by:

- Starting from a seed set of domain concepts and performing radius-limited expansion in the larger graph based on edge types and importance metrics.
- Using SOM-like or clustering approaches over usage or co-occurrence statistics to group concepts into higher-level modules, which can then be compiled into specialized subgraphs.[^5][^23][^24]

This leads to a modular architecture where each specialized skill ("robot manipulation", "Kubernetes debugging") corresponds to a relatively small class graph and its associated embeddings, which can be loaded on demand.
Similar ideas exist in modular KGs and in neurosymbolic RL, where different tasks reuse shared subgraphs or encoders.[^32][^28][^30]

## 6. Memory, compute, and representation trade-offs

### 6.1 Compactness via embeddings and sharing

Compared to storing all facts explicitly in symbolic form, embeddings provide a compressed representation that can capture many relational patterns implicitly, supporting link prediction and type inference with fewer parameters.[^10][^13][^9][^12]
Sharing of substructures—via inheritance, reused RelationClass nodes, and typed attributes—allows many instances to reuse the same conceptual machinery, similar to how hierarchies in Cresceptron reduced space complexity by reusing representations across concepts.[^38]
Careful design of the class graph (e.g., limiting branching factor, enforcing sparsity, pruning unused nodes) and selection of compact KGE architectures can keep memory and compute requirements modest compared to large monolithic transformers.

### 6.2 Dynamic complexity and instance-adaptive structures

Object-centric learning with adaptive slots shows that the number of object representations can be made dynamic, with the model selecting more slots for complex scenes and fewer for simple ones.[^21]
A similar mechanism can be used for class graph expansion: allocate new ConceptClass or RelationClass nodes only when existing ones fail to explain new data or when error signals cross thresholds, approximating structural regularization.
SOM-derived trees and concept-formation networks provide heuristics for growing and pruning conceptual units based on data density and stability of attractor states, enabling incremental but bounded growth.[^25][^26][^5]

### 6.3 Computation patterns

Because the core representation is a sparse graph, many computations (message passing, querying, reasoning) can be restricted to small subgraphs relevant to the current task, unlike transformers which typically process entire contexts with dense attention.
Dynamic computation per sample, as emphasized in object-oriented deep learning proposals, supports input-driven sparsity and potential hardware acceleration.[^39]
Moreover, symbolic reasoning over graphs can often be performed via efficient database-like operations (as KRROOD shows with SQLAlchemy-backed queries), which scale differently from dense matrix multiplications and may be cheaper for certain workloads.[^2][^3][^15]

## 7. Implementation roadmap with current tech

This section outlines a pragmatic path to an MVP and then more ambitious versions.

### 7.1 MVP: static class graph with neural scoring

Phase 1 focuses on a static but learnable class graph:

- Build or import a seed ontology for a chosen domain, using existing ontologies or LLM-assisted extraction.
- Represent concepts and relations as classes/objects in the host language (e.g., Python), using a KRROOD-like framework or custom equivalents.[^3][^15][^2]
- Store the graph in a graph database or in-memory structure; learn KGE or GNN-based embeddings using standard objectives (link prediction, type classification).
- Expose a query interface that retrieves and reasons over subgraphs, mixing symbolic rules with neural scores.

At this stage, there is no structural RL; self-improvement is limited to updating embeddings and maybe adjusting rule weights based on feedback.

### 7.2 Phase 2: automated class refinement and RL

Phase 2 introduces structural modification policies:

- Define a set of refinement operators on the graph (split, merge, add/retype relations, add constraints), inspired by DRILL’s class expression refinement operators.[^33]
- Implement an environment simulation where applying a refinement sequence yields a new graph; evaluate its quality using metrics like prediction accuracy, compression, and consistency.
- Train a Q-network or policy gradient agent to select refinement actions that maximize long-term reward, initially in small synthetic domains.
- Use neurosymbolic RL patterns to let symbolic rules constrain the action space and prune obviously invalid refinements.[^30]

This leads to a system that can autonomously reorganize its class structure as it ingests more data or receives feedback on its performance.

### 7.3 Phase 3: interactive, domain-general class-based AI

In the long term, this architecture can be extended to a general AI assistant:

- Multiple domain-specific graphs share a higher-level ontology, allowing cross-domain transfer via shared ConceptClass nodes and relation structures.
- Perception modules (text, vision, code) map inputs to graph nodes and subgraphs; reasoning combines neural scoring and symbolic inference to answer queries and plan actions.
- A meta-level RL agent monitors performance across domains and allocates representational capacity (new classes, new relations) where it yields the most value.

This would be "LLM-like" in terms of capability but structurally very different: its knowledge is explicit in the class graph, its reasoning is hybrid neurosymbolic, and its learning involves both parameter updates and structural changes.

## 8. Key research risks and open questions

Several challenges remain open and would require experimentation:

- Scalability of structural RL: Operating over large graphs with huge action spaces is hard; techniques from program synthesis, neural architecture search, and hierarchical RL may be needed.
- Evaluation of class quality: Defining robust, task-agnostic rewards that capture "good" class structures (interpretable, generalizable, compressed) is nontrivial.
- Alignment and safety: While explicit structures aid interpretability, structural modifications could still lead to unexpected behaviors; constraints and verification tools must be integrated into the refinement loop.[^39][^29][^28][^30]
- Human-in-the-loop design: Practical systems will likely need tools for human experts to inspect, edit, and veto class changes, similar to ripple-down rules and ontology engineering workflows.[^15][^2][^3]

Despite these uncertainties, existing work on frame-based KR, knowledge graphs and embeddings, object-centric learning, concept formation networks, neurosymbolic reasoning, and object-oriented KR frameworks collectively indicate that your proposed class-based AI is conceptually sound and technically plausible with current tools.
A staged implementation that begins with a static, OOP-based knowledge graph plus embeddings and gradually introduces structural RL and self-organization is a realistic path toward "a new age of AI mastery" built on explicit, object-oriented knowledge rather than opaque transformer weights.[^4][^9][^39][^28][^1][^2][^3][^30]

---

## References

1. [Knowledge Representation in AI: Techniques, Types & Real Uses](https://www.gyansetu.in/artificial-intelligence/knowledge-representation-in-ai/) - A complete guide to knowledge representation in AI- covering frames, ontologies, semantic networks, ...

2. [[Literature Review] Implementing Knowledge Representation and ...](https://www.themoonlight.io/en/review/implementing-knowledge-representation-and-reasoning-with-object-oriented-design) - KRROOD (Knowledge Representation and Reasoning with Object Oriented Design) is a Python-native frame...

3. [Implementing Knowledge Representation and Reasoning with ...](https://arxiv.org/abs/2601.14840) - This paper introduces KRROOD, a framework designed to bridge the integration gap between modern soft...

4. [Object-Centric Learning with Slot Attention - Google Research](https://research.google/pubs/object-centric-learning-with-slot-attention/)

5. [[PDF] The Self-Organizing Maps: Background, Theories, Extensions and ...](https://personalpages.manchester.ac.uk/staff/hujun.yin/pubs/SOMs-BackgroundTheoriesExtensionsApplications.pdf) - We present a new way of utilizing the SOM as a topology-preserving man- ifold tree-structure for con...

6. [Frame-based System - GM-RKB](http://www.gabormelli.com/RKB/Frame-based_System)

7. [slides16-frames-postscript](https://www.cs.rochester.edu/~schubert/444/lecture-slides/slides16-frames-postscript.pdf)

8. [AI-notes](https://www.scribd.com/document/51443012/AI-notes) - This document summarizes knowledge representation methods for natural language processing systems. I...

9. [Gentle Introduction to Knowledge Representation Learning](https://towardsdatascience.com/gentle-introduction-to-knowledge-representation-learning-1ee873830219/) - Knowledge representation learning (KRL) mainly focus on the process of learning knowledge graph embe...

10. [Understanding the performance of knowledge graph ...](https://www.sciencedirect.com/science/article/pii/S2667318522000071)

11. [A Survey on Knowledge Graph Embedding: Approaches ... - Medium](https://medium.com/@EleventhHourEnthusiast/a-survey-on-knowledge-graph-embedding-approaches-applications-and-benchmarks-894b53563cba) - Paper review

12. [Survey on Embedding Models for Knowledge Graph and ...](https://medium.com/@EleventhHourEnthusiast/survey-on-embedding-models-for-knowledge-graph-and-its-applications-a5ee5d577157) - Paper Review

13. [A survey on knowledge graph embeddings with literals: Which model links better literal-ly? - Genet Asefa Gesese, Russa Biswas, Mehwish Alam, Harald Sack, 2021](https://journals.sagepub.com/doi/10.3233/SW-200404?icid=int.sj-abstract.citing-articles.441) - Knowledge Graphs (KGs) are composed of structured information about a particular domain in the form ...

14. [Implementing Knowledge Representation and Reasoning ... - arXiv](https://arxiv.org/html/2601.14840v1) - We address the paradigm gap by proposing an object-oriented, Python-native representation of knowled...

15. [Implementing Knowledge Representation and Reasoning with ...](https://chatpaper.com/paper/228415) - KRROOD is a framework that integrates knowledge representation and reasoning within object-oriented ...

16. [Soar (cognitive architecture) - Wikipedia](https://en.wikipedia.org/wiki/Soar_(cognitive_architecture))

17. [[2201.09305] An Analysis and Comparison of ACT-R and Soar - arXiv](https://arxiv.org/abs/2201.09305) - This is a detailed analysis and comparison of the ACT-R and Soar cognitive architectures, including ...

18. [Microsoft Word - smem_tech.doc](http://web.eecs.umich.edu/~soar/sitemaker/docs/pubs/smem_tech.pdf)

19. [[2006.15055] Object-Centric Learning with Slot Attention - arXiv Vanity](https://ar5iv.labs.arxiv.org/html/2006.15055) - Learning object-centric representations of complex scenes is a promising step towards enabling effic...

20. [Object-Centric Learning with Slot Attention](https://proceedings.neurips.cc/paper/2020/hash/8511df98c02ab60aea1b2356c013bc0f-Abstract.html)

21. [Under review as a conference paper at ICLR 2024](https://openreview.net/pdf?id=EaLfdBPlIh)

22. [[2006.15055] Object-Centric Learning with Slot Attention - arXiv](https://arxiv.org/abs/2006.15055) - Learning object-centric representations of complex scenes is a promising step towards enabling effic...

23. [Self-Organizing Maps Definition - DeepAI](https://deepai.org/machine-learning-glossary-and-terms/self-organizing-map) - Self-Organizing Maps (SOMs), also known as Kohonen maps, are a type of artificial neural network tha...

24. [Self-organizing map - Wikipedia](https://en.wikipedia.org/wiki/Self-organizing_map) - A self-organizing map (SOM) or self-organizing feature map (SOFM) is an unsupervised machine learnin...

25. [[PDF] Generating Concept Trees from Dynamic Self-organizing Map - CORE](https://fileserver-az.core.ac.uk/download/pdf/235628933.pdf)

26. [Neural theory of association and concept-formation](https://brainmaps.org/pdf/amari1977.pdf)

27. [A Survey on Knowledge Graph Structure and Knowledge Graph Embeddings](https://arxiv.org/html/2412.10092)

28. [Neurosymbolic AI for Reasoning over Knowledge Graphs](https://arxiv.org/abs/2302.07200) - Neurosymbolic AI is an increasingly active area of research that combines symbolic reasoning methods...

29. [Semantic Web 0 (0) 1](https://www.semantic-web-journal.net/system/files/swj3203.pdf)

30. [Neurosymbolic Reinforcement Learning and Planning](https://arxiv.org/abs/2309.01038) - The area of Neurosymbolic Artificial Intelligence (Neurosymbolic AI) is rapidly developing and has b...

31. [Neuro-symbolic AI - Wikipedia](https://en.wikipedia.org/wiki/Neuro-symbolic_AI) - Neuro-symbolic AI is a subfield of artificial intelligence that integrates neural methods with symbo...

32. [Neuro-Symbolic Task Conditioning for Reinforcement Learning | Knowledge Graph Transfer](https://www.youtube.com/watch?v=IUUlV4eUTZM) - Learn how Knowledge Graph embeddings can condition a reinforcement learning (RL) policy and enable s...

33. [[PDF] Neuro-Symbolic Class Expression Learning - IJCAI](https://www.ijcai.org/proceedings/2023/0403.pdf) - We model CEL using refinement operators within the framework of reinforcement learning. 2. We presen...

34. [TIONAL NEURAL NETWORKS ON HYPERGRAPHS](https://openreview.net/pdf?id=HRF6T1SsyDn)

35. [TIONAL NEURAL NETWORKS ON HYPERGRAPHS - OpenReview](https://openreview.net/references/pdf?id=Bn3_wlRUkQ)

36. [Reconstructing Groups of People with Hypergraph Relational Reasoning](https://openaccess.thecvf.com/content/ICCV2023/supplemental/Huang_Reconstructing_Groups_of_ICCV_2023_supplemental.pdf)

37. [codefuse-ai/Awesome-Code-LLM - GitHub](https://github.com/codefuse-ai/awesome-code-llm) - These models are Transformer encoders, decoders, and encoder-decoders pretrained from scratch using ...

38. [[PDF] Cresceptron: a self-organizing neural network which grows adaptively](https://www.cse.msu.edu/~weng/research/CresceptronIJCNN1992.pdf)

39. [Object-Oriented Deep Learning | The Center for Brains, Minds ...](https://cbmm.mit.edu/publications/object-oriented-deep-learning) - We investigate an unconventional direction of research that aims at converting neural networks, a cl...


<img src="https://r2cdn.perplexity.ai/pplx-full-logo-primary-dark%402x.png" style="height:64px;margin-right:32px"/>

# Let us ideate on an implementation I want to implement this object-oriented generative AI in the context of automating video games and optimizing the play in turn-based games.

For starters I would like to start with Pokemon Showdown, which is a 6v6 battle of a team of pokemon with unique stats and abilties, given a complete knowledge of pokemon along with possible moves, the ai should form a class based system of each pokemon, and have sub classes and vector mapping for relations which are moves abilities items etc,
Create a master prompt for creating an agent that can detect a browser game and play in real time, and learn over time and iteratively refine its classes to contain different attributes and matchups of pokemons, and compute these into strategies as each turn of the game comes down to playing one of 4 moves or switching,
store sets of pokemon with ability and item (with nature and evs as subclasses) choices which can be defined as common config types for the pokemon classes. And form a scoring system for ranking pokemon within a pool of pokemon based on matchup and performance based score that can dynamically adjust based on given game state similar to monte carlo trees.
Structure the prompt as an initial prompt for code and env setup, and subsequent prompts for progressively developing the ai. I will be working inside of hermes ai with deepseek flash and pro, suggest agent usage and skills/instructions that I need to setup before the initial master prompt for writing code.
Suggest existing architectures and techstacks as we are more focused on the strategy and knowledge development specific to pokemon

At a high level, you can treat “Pokemon Showdown agent” as the first concrete instantiation of your class-based AI: use an explicit object graph for Pokémon, moves, items, matchups and team configs, learn embeddings over that graph, and put an MCTS-style decision layer on top to pick moves/switches each turn.[^1][^2][^3]

Below is:

- A recommended architecture + tech stack.
- How to set up agents/skills in Hermes with Deepseek.
- A master system prompt for the coding agent.
- A sequence of follow‑up prompts you can run to progressively build the system.

***

## Recommended architecture for Showdown

### Core domain model (classes and relations)

Use an explicit object graph, with each node having both a symbolic representation and an embedding:

- Classes (types in your KR sense):
    - `PokemonClass` (species-level concept: base stats, types, learnset).
    - `MoveClass` (damage class, type, base power, secondary effects).
    - `AbilityClass`.
    - `ItemClass`.
    - `NatureClass`.
    - `EVSpreadClass` (common spreads as named configs).
    - `SetClass` (a “configuration type”: Pokémon species + moveset + ability + item + nature + EVSpread + role tags like “bulky pivot”, “specs wallbreaker”).[^4][^3]
    - `MatchupClass` (relations like “threatens”, “checks”, “counters”, “wallbreaker vs balance”, etc.).
- Relations (also represented as first‑class classes):
    - `hasType(PokemonClass, Type)`.
    - `hasMove(PokemonClass, MoveClass)`.
    - `hasAbility(PokemonClass, AbilityClass)`.
    - `hasItem(SetClass, ItemClass)`.
    - `usesSet(PokemonClass, SetClass)`.
    - `threatens(SetClass, SetClass)` / `isCheckedBy(SetClass, SetClass)` etc., learned from data.[^5][^1]

Map all of these to vectors with a knowledge-graph-embedding style module so you can compute semantic similarity (e.g., two sets that both threaten Toxapex will be close in embedding space).[^6][^7][^8]

### Game state representation

For each battle state, maintain:

- Active Pokémon (both sides): species, current HP %, status, stat boosts, revealed item/ability, known moves.
- Backline: species + inferred sets / probability distribution over set classes.
- Field: hazards (Rocks, Spikes, Screens), weather, terrain, Trick Room, etc.
- History: last N turns of moves, switches, revealed tech.

Represent this as:

- A typed graph snapshot referencing the underlying `PokemonClass`, `SetClass`, etc.
- A learned state embedding (e.g., GNN over the state graph) that feeds into the policy/value network for scoring moves/switches.[^3][^1][^5]


### Decision layer: MCTS‑style scoring

At each turn, you have up to 4 moves + up to 5 possible switches (depending on fainted mons), sometimes more with Mega/Z options.[^2]

- Use a variant of Monte Carlo Tree Search (MCTS) or a shallower expectiminimax-style search with:
    - Nodes = game states with a “player to move”.
    - Actions = one of the 4 moves or a switch.
    - Rollout policy = heuristic + small NN that uses class embeddings and matchup features.
- Use a value function that combines:
    - Heuristic score (type matchups, speed control, HP/position advantage).
    - Learned value from previous games (win probability estimate).
- This is standard for Pokémon AI and has been shown effective even with simplified environments.[^9][^10][^1][^2]

The key twist for your project: the scoring functions are *expressed in terms of class relations* and can be refined by updating classes and relations (e.g., “this set actually checks Iron Valiant worse than we thought”).

***

## Tech stack suggestions (strategy/knowledge-focused)

You want to spend your brain on strategy and the class system, not wiring, so lean on existing tools:

- **Battle environment / Showdown integration**
    - Use **poke-env**: a Python interface that wraps Pokémon Showdown battles and exposes `Battle`, `Pokemon`, `Move` objects, plus RL utilities.[^4][^3]
    - Optionally use Showdown’s simulator API directly (`SIMULATOR.md`, `SIM-PROTOCOL.md`) if you want more control or custom formats.[^11][^12]
- **Strategy / learning**
    - Python + PyTorch (or JAX/Flax) for:
        - Knowledge graph embeddings (simple TransE/DistMult-style module).
        - State encoder (GNN or MLP over engineered features).
        - Policy/value networks for move scoring.
    - Store your class graph in simple Python objects + NetworkX or a lightweight graph DB; you don’t need heavy infra at first.
- **RL \& search**
    - Implement MCTS in Python as a separate module; several theses and tutorials exist for applying MCTS in Pokémon and other high-branch games.[^10][^1][^9][^2]
- **Browser automation (for “real-time” vs web UI)**
    - Python + Playwright or Selenium, mapping DOM to your internal battle state.
    - There are general examples of using Selenium to automate web games.[^13][^14]
    - But for Pokémon Showdown specifically, you’ll get far better control \& speed using a direct protocol/ poke-env than pure screen/DOM scraping.[^3][^4]

***

## Hermes / Deepseek agent and skills setup

Inside Hermes, you want a multi-agent setup roughly like:

1. **“DevOps \& Environment” agent**
    - Skills: shell/OS operations, git, Python environment management, package install.
    - Instructions:
        - Owns `git init`, `poetry`/`pip`, `conda`, installing poke-env, PyTorch, Playwright/Selenium, etc.
        - Sets up a local Showdown server or connects to play.pokemonshowdown.com in a headless environment as needed.[^15][^4][^3]
2. **“Game-KR Architect” agent**
    - Skills: design data models, define class graphs \& schemas, document interfaces.
    - Instructions:
        - Responsible for the object/class ontology: Pokémon, moves, abilities, items, sets, matchup relations.
        - Produces Python class signatures and comments, but *not* full training code.
3. **“Strategy \& RL Engineer” agent**
    - Skills: RL, supervised learning, KGE, MCTS, offline/online training loops.
    - Instructions:
        - Designs state representations, reward shaping, MCTS and/or policy/value networks.
        - Connects the domain model graph to learned embeddings and the decision policy.
4. **“Browser / Client Automation” agent**
    - Skills: Playwright/Selenium scripting, DOM inspection, event handling.
    - Instructions:
        - Implements a driver that can either control a browser (clicking moves, reading HP, etc.) or talk to Showdown over websocket/text protocols and feed states into the strategy core.[^12][^13][^11]
5. **“Refinement / Analyst” agent (optional)**
    - Skills: log analysis, metric tracking, rule refinement.
    - Instructions:
        - Periodically inspects battle logs, updates class-level matchup statistics (e.g., “this set lost 70% of games vs that set”), and proposes class refinements.

In Hermes, wire Deepseek Flash for fast iterative coding and refactors, and Deepseek Pro for more complex design reasoning and RL/strategy design.

***

## Master system prompt for the coding agent

This is the *big* system prompt you give to your main coding agent (Strategy + KR + some DevOps). Tweak wording to match Hermes’ schema, but conceptually:

```text
You are a senior AI engineer building an object-oriented, class-based Pokémon Showdown agent.

High-level goals:
- Represent Pokémon knowledge as an explicit object/class graph (PokemonClass, MoveClass, AbilityClass, ItemClass, SetClass, NatureClass, EVSpreadClass, MatchupClass).
- Each class and relation must have both:
  - A symbolic representation (Python classes and objects).
  - A learned embedding vector in a shared space (for semantic similarity and matchup scoring).
- Use this graph to drive a decision policy for Pokémon Showdown battles that:
  - Observes game state (via poke-env or the Showdown simulator API).
  - At each turn chooses either one of 4 moves or a switch.
  - Uses a combination of heuristics, learned value estimates and Monte Carlo Tree Search (or similar) to score actions.
- Over time, log battles and use them to:
  - Refine matchup relations (e.g., which sets threaten which).
  - Adjust SetClass definitions and attributes.
  - Improve the evaluation function via RL or supervised learning.

Constraints and preferences:
- Language: Python 3.
- Core battle environment: poke-env over Pokémon Showdown, not raw screen scraping.
- Use a modular, object-oriented architecture that separates:
  - knowledge graph (classes + relations),
  - battle state parsing/representation,
  - decision/strategy layer (policy/value, MCTS),
  - environment/bot interface.
- Focus on clarity and extensibility: well-named classes, clear interfaces, minimal external dependencies beyond PyTorch, poke-env, and standard libs.

Your responsibilities in this project:
1. Environment setup:
   - Create a Python project layout suitable for a medium-sized research codebase.
   - Add dependencies (poke-env, PyTorch, a small graph library such as networkx, and a browser automation stack for later).
   - Provide command-line entry points for:
     - Self-play training / evaluation.
     - Playing ladder or test matches on a local Showdown server.
2. Domain model:
   - Define Python classes and data structures for the knowledge graph:
     - PokemonClass, MoveClass, AbilityClass, ItemClass, NatureClass, EVSpreadClass, SetClass, MatchupClass, RelationClass types.
   - Implement a persistent store for these classes (e.g., JSON/SQLite) plus a loader that builds the in-memory graph and initializes embeddings.
3. Battle state representation:
   - Wrap poke-env / Showdown battle objects into a consistent GameState representation that references the knowledge graph.
   - Include enough features (HP %, types, status, boosts, hazards, etc.) for strategic decisions.
4. Strategy layer:
   - Implement:
     - A heuristic evaluation of GameState based on type matchups and resources.
     - A pluggable policy/value network that uses the graph embeddings.
     - An MCTS (or similar) search routine that scores actions by simulated rollouts.
5. Learning & refinement:
   - Design log formats for battles, including chosen action, state features, outcome and inferred matchups.
   - Implement training scripts that:
     - Update policy/value networks.
     - Update matchup statistics on SetClass / MatchupClass.
     - Optionally propose structural refinements to classes (e.g., splitting a SetClass by performance).

General coding style:
- No placeholder code. If something cannot be implemented yet, define clear interfaces and TODO comments, and explain dependencies.
- Use small, focused modules with descriptive names.
- Prefer explicit configuration via YAML/TOML files for hyperparameters and runtime settings.

In each step, propose a clear plan, then implement it. Ask for confirmation when making large structural choices (e.g., switching from pure heuristics to RL, or changing the state representation).
```


***

## Follow‑up prompts for progressive development

Use these after the master system prompt, in roughly this order. Each one can be a user message you send to the same coding agent.

### 1. Project and environment scaffolding

```text
Phase 1: scaffold the project and environment.

Tasks:
- Create a Python project layout for a “pokemon_oo_agent” package with submodules:
  - core/knowledge_graph/
  - core/domain/
  - core/state/
  - core/strategy/
  - envs/poke_env/
  - training/
  - scripts/
- Add a pyproject or requirements that includes:
  - poke-env
  - torch
  - networkx
  - pydantic or dataclasses-json (optional)
- Add a minimal CLI script that:
  - Connects to a local Pokémon Showdown server via poke-env.
  - Plays random moves using a stub Agent class.

Do not implement learning yet. Focus on clean structure, type hints and documentation.
Explain any non-obvious choices in comments at the top of modules.
```


### 2. Domain model and class graph

```text
Phase 2: implement the knowledge graph and domain classes.

Tasks:
- Define Python classes for:
  - PokemonClass, MoveClass, AbilityClass, ItemClass, NatureClass, EVSpreadClass, SetClass, MatchupClass, RelationClass.
- Implement a KnowledgeGraph manager that:
  - Stores nodes and edges (e.g., via networkx).
  - Allows queries like:
    - all sets for a given Pokémon species,
    - all moves of a given type,
    - all sets that threaten a target SetClass.
- Define a simple embedding module:
  - Maintain a vector for each node (initialized randomly).
  - Provide APIs to:
    - get/set embeddings,
    - run one training step on a batch of (head, relation, tail, label) triples (knowledge graph embedding style).

Use placeholder training logic (e.g., simple margin ranking loss) but implement the real code structure.

Assume we will later import a full Pokédex / move / ability dataset. For now, create a small fixture dataset (few Pokémon, moves, items) to test the graph and embedding module.
```


### 3. Battle state and feature extraction

```text
Phase 3: battle state representation.

Tasks:
- Implement a GameState class that:
  - Wraps poke-env Battle, Pokemon and Move objects.
  - References KnowledgeGraph nodes for species, sets (when known or inferred), moves, abilities and items.
  - Exposes:
    - active_pokemon (our side and opponent),
    - available_actions (moves + legal switches),
    - scalar features (HP %, hazards, boosts, weather, etc.).

- Implement a FeatureExtractor that:
  - Converts GameState into:
    - a compact tensor / array representation for policy/value networks,
    - a small subgraph (nodes and edges) for graph-based reasoning if needed.

Ensure it can be used both in simulation (self-play) and online play.
```


### 4. Strategy: heuristic + MCTS

```text
Phase 4: strategy and search.

Tasks:
- Implement a heuristic evaluator:
  - Score a GameState using:
    - Type matchups,
    - Speed control (who likely moves first),
    - Remaining resources (HP, hazards, win conditions).
- Implement a policy/value network skeleton:
  - Given state features and knowledge graph embeddings, output:
    - action logits (for available moves/switches),
    - state value estimate.

- Implement an MCTS module:
  - Nodes: GameState snapshots.
  - Actions: available moves/switches.
  - Selection, expansion, rollout and backprop using the policy/value network + heuristic.
  - Limit search by iterations and/or time, with a default budget that is compatible with Pokémon Showdown’s per-turn time constraints.

- Integrate into an Agent class that:
  - Given a poke-env Battle, builds GameState,
  - Runs MCTS,
  - Returns the chosen action to poke-env.

Add basic logging of decisions for later analysis.
```


### 5. Learning and class refinement

```text
Phase 5: learning & class refinement.

Tasks:
- Implement a logging subsystem:
  - For every battle and turn, log:
    - serialized GameState summary,
    - chosen action and available actions,
    - final outcome (win/loss),
    - any inferred SetClass or MatchupClass relations.
- Implement scripts to:
  - Train the policy/value network from logs (imitation learning or RL).
  - Update KnowledgeGraph embeddings with new (head, relation, tail, label) triples derived from battles.

- Design a simple class refinement mechanism:
  - For each SetClass, keep statistics vs other SetClasses (win rate, performance).
  - Propose splits or new MatchupClass entries when significant patterns appear (e.g., a set underperforms vs a specific archetype).
  - For now, only implement analytics and reporting (no automatic structural changes). Emit suggestions in a human-readable report.
```


### 6. Browser / real-time UI control (optional later phase)

```text
Phase 6: browser automation for live play.

Tasks:
- Implement a thin BrowserClient using Playwright or Selenium that:
  - Loads the Pokémon Showdown web client.
  - Detects the current battle state from DOM (active Pokémon, HP bars, moves, switches).
  - Maps the DOM state into GameState (reusing the same representation used with poke-env).

- Implement a loop that:
  - Reads DOM state,
  - Builds GameState,
  - Calls Agent to choose an action,
  - Clicks the appropriate button in the browser.

Note: For early development and training, the poke-env / simulator route remains primary. The browser client is for demonstration and ladder play.
Document any differences or limitations between the DOM-based and simulator-based states.
```


***

## How this ties back to your class-based AI vision

- Pokémon, moves, abilities, items, natures, EV spreads, and configs are explicit classes, with relations like `hasMove`, `checks`, `threatens`, etc. stored in an evolving graph.[^4][^3]
- Each class and relation gets an embedding that is learned from raw battle outcomes and Showdown data, giving your system a semantic geometry of matchups.[^7][^8][^1][^6]
- The decision layer (policy/value + MCTS) reasons over these classes rather than raw tokens, and can be improved either by updating embeddings/NN weights or refining the class graph itself.
- Over time you can start adding a structural RL layer that actually edits the class graph (merging/splitting `SetClass`, changing `MatchupClass` definitions) based on performance, which is exactly the self-improving, top‑down refinement you described.

If you want, next step I can do is: take Phase 1 and Phase 2 prompts and tighten them into something you can paste directly into Hermes with Deepseek, tuned to your existing agent/skills naming.
<span style="display:none">[^16][^17][^18][^19]</span>

<div align="center">⁂</div>

[^1]: https://arno.uvt.nl/show.cgi?fid=170059

[^2]: https://niklasriewald.com/2019/10/27/the-math-behind-competitive-pokemon-part-5-game-tree-pruning/

[^3]: https://poke-env.readthedocs.io

[^4]: https://github.com/hsahovic/reinforcement-learning-pokemon-bot

[^5]: https://arxiv.org/html/2504.04395v1

[^6]: https://towardsdatascience.com/gentle-introduction-to-knowledge-representation-learning-1ee873830219/

[^7]: https://www.sciencedirect.com/science/article/pii/S2667318522000071

[^8]: https://journals.sagepub.com/doi/10.3233/SW-200404?icid=int.sj-abstract.citing-articles.441

[^9]: http://arno.uvt.nl/show.cgi?fid=170059

[^10]: https://jeffbradberry.com/posts/2015/09/intro-to-monte-carlo-tree-search/

[^11]: https://github.com/smogon/pokemon-showdown/blob/master/sim/SIM-PROTOCOL.md

[^12]: https://github.com/smogon/pokemon-showdown/blob/master/sim/SIMULATOR.md

[^13]: https://angiejones.tech/selenium-for-games/

[^14]: https://www.reddit.com/r/learnprogramming/comments/qotsxl/how_can_i_make_a_client_that_interacts_with/

[^15]: https://github.com/smogon/pokemon-showdown-client/blob/master/README.md

[^16]: Toward-an-Object-Oriented-Class-Based-Generative-AI-Architecture.md

[^17]: https://github.com/taylorhansen/pokemonshowdown-ai

[^18]: https://github.com/Owzok/Pokemon-Showdown-Simulator

[^19]: https://github.com/wgranados/Pokemon-Showdown/blob/master/sim/SIM-PROTOCOL.md


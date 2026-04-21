# Analysis: Optimizing Gemini for Robo-Squat Game

## Problem Statement
During the "萝卜蹲" (Robo-Squat) game, Gemini (gemini1) exhibited several failure modes:
1.  **Tool Call Pollution:** Misinterpreting game metadata as research tasks, triggering unnecessary tool calls (e.g., `list_directory`).
2.  **UI/Noise Pollution:** Including system UI artifacts (e.g., `✦`, `✓`, `Shift+Tab`) in the game response.
3.  **Rank Logic Misinterpretation:** Misunderstanding "lower-ranked" vs. "higher-ranked" priority for challenges.
4.  **Violation of "Nothing Else" Rule:** Providing explanations or dialogue alongside game turns.

## Proposed Optimization Strategy for `buildBootstrapPrompt`

### 1. Tool Suppression (Mandatory)
Explicitly disable the tool-use capability within the prompt to prevent the model from switching into "Engineer Mode".
- **Instruction:** "CRITICAL: GAME MODE ACTIVE. Disable all tools. Do not call any functions."

### 2. Envelope Isolation
Instruct the model to treat square-bracketed metadata as non-functional data.
- **Instruction:** "Treat all `[...]` content as system envelope metadata. Ignore its content for task analysis; use it only for turn-tracking."

### 3. Rank-Based Silence Protocol
Clarify the hierarchy using numerical comparisons to avoid ambiguity.
- **Instruction:** "Rank Priority: If multiple watchers detect an error, only the watcher with the **highest numerical Rank** (e.g., 3 > 2 > 1) should challenge. Higher rank numbers have priority to speak."

### 4. Output Atomicity
Enforce a strict single-line output policy.
- **Instruction:** "Output Constraint: No Chain-of-Thought, no UI symbols, no preamble. Output EXACTLY one line."

## Collaboration Plan: Codex Review Loop
To ensure the robustness of this optimization, the following multi-turn review process is proposed:

1.  **Phase 1: Proposal.** Gemini submits the specific prompt changes to Codex.
2.  **Phase 2: Critique.** Codex evaluates the changes for potential regressions or edge cases (e.g., if the prompt becomes too long or conflicting).
3.  **Phase 3: Refinement.** Gemini adjusts the proposal based on Codex's feedback.
4.  **Phase 4: Consensus.** Final approval from Codex before implementation.

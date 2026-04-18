# AI Unscientific Top

Leaderboard for unscientific LLM model benchmarks. Based on one-shot refactoring of a large legacy TypeScript file using [OpenCode](https://github.com/opencode-ai/opencode) builder agents with [oh-my-opencode-slim](https://github.com/ZoRDoK/oh-my-opencode-slim) council config.

## Results

**Live leaderboard:** [zordok.github.io/ai-unscientific-top](https://zordok.github.io/ai-unscientific-top/)

### Senior
| Model | Provider | Lines Δ | Time | Cost | Quality Gates |
|-------|----------|---------|------|------|------|
| **Qwen-3.6-plus** | opencode-go | 516 | 7 min | $0.17 | 1 warn |
| gpt-5.3-codex | openai | 279 | 2m30s | — | — |

### Upper-Middle
| Model | Provider | Lines Δ | Time | Cost | Quality Gates |
|-------|----------|---------|------|------|------|
| GLM-5.1 | ollama-cloud | 628 | 74 min | — | 1 warn |
| gpt-5.4-fast | openai | 319 | 10m13s | — | 1 error |

### Middle
| Model | Provider | Lines Δ | Time | Cost | Quality Gates |
|-------|----------|---------|------|------|------|
| MiniMax-M2.7 | minimax | 259 | 3m28s | — | 1 warn |
| Kimi-2.5 | opencode-go | 512 | 11 min | $0.12 | clean |

### Junior
| Model | Provider | Lines Δ | Time | Cost | Quality Gates |
|-------|----------|---------|------|------|------|
| MiMo-v2-omni | opencode-go | 523 | 4 min | $0.22 | 1 error, 2 warnings |
| MiMo-v2-pro | opencode-go | 211 | 7 min | — | 1 error |
| Nemotron-3-super | ollama-cloud | 991 | 8 min | — | 1 error |
| deepseek-3.2 | ollama-cloud | 106 | ~hours | — | — |

### Did Not Finish
| Model | Provider | Notes |
|-------|----------|-------|
| Gemma-4:31b | ollama-cloud | DNF |
| Elephant | openrouter | No changes |

**Rounds:**
- **Round 1** (2026-04-16): Qwen-3.6-plus, GLM-5.1, MiniMax-M2.7, Kimi-2.5, MiMo-v2-omni, Gemma-4:31b
- **Round 2** (2026-04-18): Elephant, MiMo-v2-pro, Nemotron-3-super, gpt-5.3-codex, gpt-5.4-fast, deepseek-3.2

## Comparing Model Output

Each model's refactored file is in `models/<model-name>/callback-dispatch-service.ts`. The baseline (pre-refactor) is `models/baseline/callback-dispatch-service.ts`.

### Diff a model against baseline (local)

```bash
# Diff any model against the baseline
diff models/baseline/callback-dispatch-service.ts models/qwen-3.6-plus/callback-dispatch-service.ts

# Or with color and context
git diff --no-index models/baseline/callback-dispatch-service.ts models/qwen-3.6-plus/callback-dispatch-service.ts

# Side-by-side with wider terminals
diff --side-by-side --width=200 models/baseline/callback-dispatch-service.ts models/qwen-3.6-plus/callback-dispatch-service.ts
```

### Diff two models against each other (local)

```bash
diff models/kimi-2.5/callback-dispatch-service.ts models/qwen-3.6-plus/callback-dispatch-service.ts
```

### View on GitHub

Click any file in `models/<model-name>/` to view it. To compare on GitHub, use the URL hack:

```
https://github.com/ZoRDoK/ai-unscientific-top/compare/main...main
```

Since all files are on `main`, you'll need to diff locally. A quick trick — open both files in separate browser tabs and use a web diff tool like [diffchecker](https://www.diffchecker.com/).

## Methodology

- Each model receives the same 1207-line TypeScript file and identical instructions: refactor as a Senior Developer with 20 years experience, preserve all behavior.
- Models choose their own refactoring strategy — no hints given.
- Only `callback-dispatch-service.ts` may be modified.
- Must pass `tsc --noEmit` and `npm run test:unit`.
- Each model works in an isolated git worktree with its own branch.
- Seniority rating is a subjective code-quality assessment after manual review.

## Repository Structure

```
models/
  baseline/           # Original file before refactoring (English)
  glm-5.1/            # GLM-5.1 via ollama-cloud
  kimi-2.5/           # Kimi K2.5 via opencode-go
  qwen-3.6-plus/      # Qwen 3.6-plus via opencode-go
  mimo-v2-omni/       # MiMo v2-omni via opencode-go
  gemma-4-31b/        # Gemma 4:31b via ollama-cloud (DNF)
  minimax-m2.7/        # MiniMax M2.7-highspeed via minimax subscription
  elephant/            # Elephant via openrouter (no changes committed)
  mimo-v2-pro/          # MiMo v2-pro via opencode-go
  nemotron-3-super/     # Nemotron-3-super via ollama-cloud
  gpt-5.3-codex/        # gpt-5.3-codex via openai
  gpt-5.4-fast/         # gpt-5.4-fast via openai
  deepseek-3.2/         # deepseek-3.2 via ollama-cloud
index.html            # Live leaderboard (GitHub Pages)
```

## License

MIT
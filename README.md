# AI Unscientific Top

Leaderboard for unscientific LLM model benchmarks. Based on one-shot refactoring of a large legacy TypeScript file using [OpenCode](https://github.com/opencode-ai/opencode) builder agents with [oh-my-opencode-slim](https://github.com/ZoRDoK/oh-my-opencode-slim) council config.

## Results

**Live leaderboard:** [zordok.github.io/ai-unscientific-top](https://zordok.github.io/ai-unscientific-top/)

### Round 1 — 2026-04-16

| # | Model | Provider | Seniority | Lines Δ | TSC | Tests | Time | Tokens | Reqs | Cost | Lint |
|---|-------|----------|-----------|---------|-----|-------|------|--------|------|------|------|
| 1 | **Qwen-3.6-plus** | opencode-go | Senior | 516 | 2 | 1✓ | 7 min | 50K | 28 | $0.17 | 1 warn |
| 2 | GLM-5.1 | ollama-cloud | Middle-Upper | 628 | 2 | 1✓ | 74 min | 84K | — | — | 1 warn |
| 3 | MiniMax-M2.7 | minimax | Middle | 259 | 1 | 1✓ | 3m28s | — | — | — | 1 warn |
| 4 | Kimi-2.5 | opencode-go | Middle-Lower | 512 | 1 | 1✓ | 11 min | 44K | 15 | $0.12 | clean |
| 5 | MiMo-v2-omni | opencode-go | Junior | 523 | ? | ? | 4 min | 53K | 38 | $0.22 | 1 err, 2 warn |
| 6 | Gemma-4:31b | ollama-cloud | DNF | — | — | — | — | — | — | — | — |
| 7 | Elephant | openrouter | Pre-Junior | 0 | — | — | — | — | — | — | no changes |

**Original file:** 1207 lines. Models used 4 OpenCode skills (TypeScript, Architecture, Style, Tests). Prices from opencode-go logs.

## Comparing Model Output

Each model's refactored file is in `models/<model-name>/callback-dispatch-service.ts`, with Russian strings translated to English for readability. The baseline (pre-refactor) is `models/baseline/callback-dispatch-service.ts`.

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
index.html            # Live leaderboard (GitHub Pages)
```

## License

MIT
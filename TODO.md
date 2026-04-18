# AI Unscientific Top — Model Refactoring Benchmark

## Status: IN PROGRESS

### TODO
- [ ] Run builder-7 through builder-12 (7-12) with chosen models
- [ ] Collect results from each model: time, context, tsc iterations, test iterations, lines changed, PR URL
- [ ] Fill in "Context (tokens)" column from session data
- [ ] Fill in "Time" column from session data
- [ ] Add personal review comments per model
- [ ] Finalize leaderboard ranking

### Models tested (Round 1 — 2026-04-16)
| # | Builder | Model | Seniority |
|---|---------|-------|-----------|
| 1 | builder-1 | GLM-5.1 | Middle-Upper |
| 2 | builder-2 | Qwen-3.6-plus | Senior |
| 3 | builder-3 | MiniMax-M2.7-highspeed | Middle |
| 4 | builder-4 | Kimi-2.5 | Middle-Lower |
| 5 | builder-5 | MiMo-v2-omni | Junior |
| 6 | builder-6 | Gemma-4:31b | Unknown |

### Models tested (Round 2 — TBD)
| # | Builder | Model | Seniority |
|---|---------|-------|-----------|
| 7 | builder-7 | ? | ? |
| 8 | builder-8 | ? | ? |
| 9 | builder-9 | ? | ? |
| 10 | builder-10 | ? | ? |
| 11 | builder-11 | ? | ? |
| 12 | builder-12 | ? | ? |

### Task
Refactor `src/services/callback-dispatch-service.ts` (1207 lines) as a Senior Developer with 20 years experience. Each model decides its own refactoring strategy. Same codebase, same constraints (only modify that one file, preserve all behavior).
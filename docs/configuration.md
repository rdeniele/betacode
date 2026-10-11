# Configuration

Precedence (later wins): defaults, `~/.betacode/config.json`, `<project>/.betacode/config.json`, environment.

| Key | Default | Env |
|---|---|---|
| provider | qwen | BETA_CODE_PROVIDER |
| model | Qwen/Qwen3-Coder-30B-A3B-Instruct | BETA_CODE_MODEL |
| baseUrl | http://localhost:8000/v1 | BETA_CODE_BASE_URL |
| apiKey | none (optional) | BETA_CODE_API_KEY |
| temperature / topP / topK / repetitionPenalty | 0.7 / 0.8 / 20 / 1.05 | BETA_CODE_TEMPERATURE, BETA_CODE_TOP_P, BETA_CODE_TOP_K, BETA_CODE_REPETITION_PENALTY |
| contextLength | 32768 | BETA_CODE_CONTEXT_LENGTH |
| maxIterations / maxRetries | 30 / 5 | BETA_CODE_MAX_ITERATIONS |
| autoCompact | true | |
| commandTimeoutMs | 120000 | |
| permissions | {} | |
| teacher | none (optional helper model: `enabled`, `provider`, `baseUrl`, `model`) | BETA_CODE_TEACHER_API_KEY (key only) |
| pricing | none (cost only shown if set) | |

Data: `~/.betacode/betacode.db` (SQLite) and `~/.betacode/logs/betacode.log` (redacted JSON lines).

`BETACODE.md` (project root, parents up to the repo root, subdirectories up to 3 deep, and `~/.betacode/BETACODE.md`) is loaded into every run. `/init` asks the agent to write one for you, with approval.

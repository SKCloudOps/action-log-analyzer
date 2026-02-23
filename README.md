# Action Log Analyzer

> Log analysis for every run — useful for both **successes and failures**.

[![GitHub Marketplace](https://img.shields.io/badge/GitHub-Marketplace-blue?logo=github)](https://github.com/marketplace/actions/action-log-analyzer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Action Log Analyzer runs on **every workflow run** — whether jobs pass or fail. It posts a clear summary to your PR or Job Summary, extracts coverage reports and important links from logs, and surfaces artifacts.

- **When jobs fail:** Root cause analysis, suggested fixes, error context, and step timeline
- **When jobs pass:** Job status, artifacts, coverage reports, and links extracted from logs

**No external API keys. No extra cost. Just add one job to your workflow.**

---

## Quick Start

Add this job to your existing workflow file. Run on **both success and failure** for full visibility:

```yaml
analyze-logs:
  runs-on: ubuntu-latest
  needs: [your-build-job]   # replace with your actual job name
  if: always()              # runs on success AND failure
  permissions:
    actions: read           # read workflow logs and list artifacts
    pull-requests: write    # post PR comment

  steps:
    - uses: SKCloudOps/action-log-analyzer@v1
      with:
        github-token: ${{ secrets.GITHUB_TOKEN }}
```

To run **only when jobs fail** (failure analysis only):

```yaml
  if: failure()
```

`GITHUB_TOKEN` is **automatically available** — no setup, no cost, no external API keys required.

---

## What It Posts

| Scenario | What You Get |
|:---------|:-------------|
| **Jobs fail** | Root cause, failed step, suggested fix, error context, step timeline, artifacts, links |
| **Jobs pass** | Job status, artifacts, coverage reports and links extracted from logs |

Output appears in the **PR comment** and **Job Summary** tab. For commits to `main` without a PR, the summary appears in the Job Summary only.

---

## How It Works

- **On failure:** Pattern matching (patterns.json) detects known errors and suggests fixes. When no pattern matches, it provides a generic fallback and suggests adding a custom pattern.
- **On success:** Extracts coverage report URLs, test results, and other important links from job logs and surfaces them in the summary.

---

## About GITHUB_TOKEN & Permissions

`GITHUB_TOKEN` is a **short-lived token automatically created by GitHub** at the start of every workflow run. You do not need to create it, pay for it, or manage it.

You must explicitly grant the permissions Action Log Analyzer needs:

| Permission | Why It's Needed |
|---|---|
| `actions: read` | Fetch job logs and list workflow artifacts |
| `pull-requests: write` | Post the analysis comment on the PR |

---

## What It Detects

| Category | Examples |
|---|---|
| **Docker** | Auth failures, missing images, disk space, bad Dockerfile path |
| **GitHub Actions** | Missing secrets, permission errors, timeouts |
| **Node.js / npm** | Missing modules, peer dep conflicts, permission errors |
| **Tests** | Failed test suites (Jest, Mocha, etc.) |
| **TypeScript** | Compilation errors |
| **Network** | Connection refused, API rate limits |
| **Kubernetes** | ImagePullBackOff, Helm failures |
| **Unknown** | Generic fallback with error line review |

---

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | Yes | `${{ github.token }}` | Auto-available, no setup needed |
| `post-comment` | No | `true` | Post analysis as PR comment |
| `post-summary` | No | `true` | Post analysis in Job Summary tab |
| `failed-job-name` | No | `` | Analyze a specific job only (analyzes all if not set) |
| `remote-patterns-url` | No | `` | URL to fetch additional community patterns from |

---

## Outputs

Use these in later steps to build custom notifications or integrations:

| Output | Description |
|---|---|
| `root-cause` | Plain-English root cause (empty when all jobs pass) |
| `failed-step` | The step that caused the failure (empty when all jobs pass) |
| `suggestion` | Suggested fix |
| `matched-pattern` | Pattern ID that matched, or `none` |
| `category` | Category of the failure, or `Success` when all jobs pass |

### Example — Use outputs in a Slack notification

```yaml
- uses: SKCloudOps/action-log-analyzer@main
  id: lens
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}

- name: Notify Slack
  run: |
    echo "Root cause: ${{ steps.lens.outputs.root-cause }}"
    echo "Fix: ${{ steps.lens.outputs.suggestion }}"
```

---

## Adding Custom Patterns

Action Log Analyzer loads error patterns from `patterns.json` in the repo root. You can add your own patterns without touching any TypeScript:

```json
{
  "id": "my-custom-error",
  "category": "MyTool",
  "pattern": "my specific error message",
  "flags": "i",
  "rootCause": "Plain English explanation of what went wrong",
  "suggestion": "Specific steps to fix it",
  "severity": "critical",
  "tags": ["mytool", "custom"]
}
```

Custom patterns are fast, free, and always take priority.

---

## Contributing

Contributions are welcome! The easiest way to contribute is to **add new error patterns** to `patterns.json` — no TypeScript knowledge needed, just JSON.

Each pattern needs:
- `id` — unique identifier (e.g. `docker-auth`)
- `category` — group name (e.g. `Docker`, `Node.js`)
- `pattern` — regex string to match against log lines
- `flags` — regex flags (usually `"i"` for case-insensitive)
- `rootCause` — one sentence plain-English explanation
- `suggestion` — 2-3 sentences on how to fix it
- `severity` — `critical`, `warning`, or `info`
- `tags` — array of searchable tags
- `docsUrl` — (optional) link to related documentation shown in the report

See [CONTRIBUTING.md](CONTRIBUTING.md) for full details.

---

## License

MIT

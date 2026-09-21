---
name: setup-ieedan-label
description: >
  Set up @ieedan/label in a GitHub repository: write .label.yml from the repo's
  existing labels (GitHub description as apply_when by default) and add a
  GitHub Actions workflow that labels issues and pull requests on change.
  Use when installing @ieedan/label, configuring .label.yml, or adding
  automatic issue/PR labeling. Do not use the scheduled/cron recent-items
  workflow unless the user asks for it.
---

# Set up @ieedan/label

Install event-driven labeling for the given GitHub repo. They should just have the description as the apply_when by default and should run on any change to issues / prs (not the cron mode).

## Steps

1. Resolve the repo (`owner/name`) from the user, `gh repo view --json nameWithOwner -q .nameWithOwner`, or `git remote`.
2. List labels: `gh label list --repo owner/name --limit 1000 --json name,description`
3. Write `.label.yml` at the repo root (see below).
4. Write `.github/workflows/label.yml` from the event workflow (not `label-recent.yml`).
5. Tell the user to add a `TYPESAFE_API_KEY` repository secret. The workflow uses `GITHUB_TOKEN`.

Do not create labels. Do not add `label-recent.yml`, cron, or `--top`/`--all` jobs unless asked.

## `.label.yml`

For every GitHub label, add an entry whose `apply_when` is that label's description. Omit `apply_when` when the description is empty. Do not invent `remove_when`, `examples`, `threshold`, `can_apply`, `can_remove`, `context`, or a top-level `prompt`.

Quote YAML keys that are not plain identifiers (e.g. `good first issue`).

```yaml
labels:
  bug:
    apply_when: Something isn't working
  enhancement:
    apply_when: New feature or request
  good first issue:
    apply_when: Good for newcomers
```

If `.label.yml` or `.label.yaml` already exists, keep existing keys and extra fields. Only add missing labels, using the GitHub description as `apply_when`.

Unlisted GitHub labels still apply via name and description unless `only_configured: true`. Do not set `only_configured` unless the user wants Jev limited to this file.

## Workflow

Copy to `.github/workflows/label.yml`. Use `npx --yes @ieedan/label` in consumer repos. In this monorepo, keep the existing `pnpm start` workflow instead of replacing it.

```yaml
# Labels the issue or pull request that triggered the workflow.
# Add a TYPESAFE_API_KEY repository secret, and optionally a .label.yml policy
# at the repo root (checked out below so the CLI can read it).

name: Label

on:
    issues:
        types: [opened, edited, reopened]
    pull_request_target:
        types: [opened, edited, reopened, ready_for_review]
    issue_comment:
        types: [created, edited]

concurrency:
    group: label-${{ github.repository }}-${{ github.event.issue.number || github.event.pull_request.number }}
    cancel-in-progress: true

permissions:
    contents: read
    issues: write
    pull-requests: write

jobs:
    label:
        if: github.event.comment.user.login != 'github-actions[bot]'
        runs-on: ubuntu-latest
        timeout-minutes: 10
        steps:
            - uses: actions/checkout@v4

            - uses: actions/setup-node@v4
              with:
                  node-version: 24

            - name: Label
              env:
                  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
                  TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
              run: npx --yes @ieedan/label label -R "$GITHUB_REPOSITORY" "${{ github.event.issue.number || github.event.pull_request.number }}"
```

`pull_request_target` is required so fork PRs can be labeled. The workflow checks out the default branch, not the PR, so untrusted PR code is not executed.

## Optional policy fields (only if asked)

- `prompt`: repo-wide steering (same as `--prompt`)
- `remove_when`: when the label should come off
- `examples`: typical matches
- `threshold`: min noul to apply (default 0.7)
- `can_apply: false`: suggest only; do not add the label
- `can_remove: false`: never take this label off
- `context: similar_issues`: for labels like `duplicate` that depend on other issues

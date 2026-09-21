# label

An issue labeler built on top of Jev.

## Setup

```sh
pnpm install
```

Copy `.env.example` to `.env` and set `TYPESAFE_API_KEY` and `GITHUB_TOKEN`.

## Usage

```sh
pnpm start label -R owner/name 12 15 --dry-run
pnpm start label -R owner/name --top 10 --dry-run
pnpm start label -R owner/name --top 10 --issues --dry-run
pnpm start label -R owner/name --all --prs --dry-run
pnpm start label -R owner/name --top 10 --dry-run --prompt "Prefer bug over enhancement when both could apply."
```

`--dry-run` prints the chosen labels and does not apply or remove them. Omit it to apply matches and remove labels that no longer apply. `--no-remove` keeps existing labels and only adds new matches.

`--all` labels every matching issue and pull request. `--top [n]` labels the N most recently updated ones (default 10). Closed items are skipped unless you pass `--include-closed`. `--issues` limits to issues; `--prs` limits to pull requests. `--prompt` adds extra instructions for this run.

The table shows chosen labels with their noul scores. Scores close to the threshold are yellow; scores that exceed it by a wide margin are green.

Jev sees each item's title, body, and comment thread (including pull request reviews).

## Steering labels

GitHub label descriptions are short. Put longer rules in `.label.yml` at the repo root (or any parent of `--cwd`):

```yaml
policy: Prefer specific area labels. Never apply both bug and enhancement.
only_configured: true

labels:
  bug:
    apply_when: Reproducible incorrect behavior in existing functionality.
    not_when: Missing features, questions, or docs typos.
    examples:
      - Crash when input is empty
    threshold: 0.7
    remove: false
  good first issue:
    apply_when: Small, well-scoped change a new contributor could land.
    not_when: Needs design discussion or deep repo context.
    threshold: 0.85
    auto: false
  needs reproduction:
    apply_when: The report is incomplete and cannot be acted on without more detail.
    not_when: Steps, expected result, and actual result are already present.
```

Unlisted labels still use the GitHub name and description unless `only_configured: true`, which limits Jev to labels listed in this file. `auto: false` shows the label as a suggestion and does not apply or remove it. `remove: false` keeps the label if it is already on the item. Labels are removed only when Jev is clearly below the threshold (`noul < 1 - threshold`), so scores near the cutoff are left alone. `--prompt` is extra steering on top of this file.

## GitHub Actions

This repo labels its own issues and pull requests with [`.github/workflows/label.yml`](.github/workflows/label.yml). That workflow builds the CLI from this monorepo.

To use the published CLI in another repository, copy the examples in [`examples/github-workflows`](examples/github-workflows):

- [`label.yml`](examples/github-workflows/label.yml) runs on every issue and pull request (and on new comments) and applies labels to that item.
- [`label-recent.yml`](examples/github-workflows/label-recent.yml) labels the 25 most recently updated open items on a schedule, or when you run it from the Actions tab.

Add a `TYPESAFE_API_KEY` repository secret. The workflow uses `GITHUB_TOKEN` with `issues: write` and `pull-requests: write`. New matches are applied, and stale labels Jev no longer supports are removed. Pass `--no-remove` to keep existing labels.

`pull_request_target` is used so fork PRs can be labeled. Those workflows check out the default branch, not the pull request, so untrusted PR code is not executed.

Development watch mode:

```sh
pnpm dev
```

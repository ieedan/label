[![npm version](https://flat.badgen.net/npm/v/@ieedan/label?color=yellow)](https://npmjs.com/package/@ieedan/label)
[![npm downloads](https://flat.badgen.net/npm/dm/@ieedan/label?color=yellow)](https://npmjs.com/package/@ieedan/label)

# `@ieedan/label`

A super fast issue/PR labeler built on top of TypeSafe AI's Jev.

Intelligently label issues and pull requests based on their content and history.

## Usage 

You will need a few environment variables:

```sh
TYPESAFE_API_KEY=apikey_...
GITHUB_TOKEN=github_pat_... # you can use the actions one in workflows
```

Then you can use the CLI to label issues and pull requests. (We recommend using the `--dry-run` flag so you can tune what get's applied)

The repository is detected from the git remote (`origin`, then `upstream`) of the repository you run in, so `-R` is only needed when you want to label a different repository.

```sh
npx @ieedan/label label --top 5 # top 5 issues/pulls in the current repository
npx @ieedan/label label -R ieedan/shadcn-svelte-extras --top 5 # label a different repository
npx @ieedan/label label -R ieedan/shadcn-svelte-extras --all --issues # all issues
npx @ieedan/label label -R ieedan/shadcn-svelte-extras --all --prs # all pulls
npx @ieedan/label label -R ieedan/shadcn-svelte-extras --prompt "Never apply the 'help wanted' label" # extra steering
npx @ieedan/label label -R ieedan/shadcn-svelte-extras --dry-run # don't apply any labels
npx @ieedan/label label -R ieedan/shadcn-svelte-extras --threshold 0.5 # default (0.6) minimum confidence score to apply a label
npx @ieedan/label label -R ieedan/shadcn-svelte-extras --include-closed # include closed issues/pulls
npx @ieedan/label label -R ieedan/shadcn-svelte-extras --remove # also remove labels that no longer apply
npx @ieedan/label label -R ieedan/shadcn-svelte-extras --config policies/frontend.yml # use a policy file other than .label.yml
```

Optionally add a `.label.yml` at the repo root to give more guidance on when to apply and remove specific labels.

```yml
prompt: Prefer specific labels over generic ones.

labels:
  bug:
    apply_when: Something isn't working
    remove_when: The report is a feature request, not a defect
    examples:
      - Crash when a required token is missing
    threshold: 0.7
  duplicate:
    context: similar_issues # add similar issues as context
    apply_when: This issue or pull request already exists
  enhancement:
    apply_when: New feature or request
  good first issue:
    apply_when: A solution has already been proposed and agreed upon by the maintainers
    can_apply: false
    can_remove: false

only_configured: true # only apply labels that are configured in this file
```

### Human-removed labels

The GitHub CLI reads label-event history and does not reapply a label whose latest
human action was removal, even if Jev gives it a high score or a bot later adds it.
The veto filters additions and suggested choices without changing the model judgment or removal rules.
A later human addition lifts that veto. GitHub actors of type `User` count as human,
including automation using a personal token. App/bot actors do not lift the veto.

History is loaded for dry runs and refreshed immediately before additions after
inference. A failed history read prevents that item's additions. GitHub does not
provide an atomic history-check/add operation, so a small concurrent-edit window
remains. Removal behavior and model prompts are unchanged. Existing stale labels
are not removed by this fix. Low-level `label()` callers can supply
`human_removed_labels` in their payload; it does not fetch that history for them.

### Review context

PR judgments include review state (including empty-body approvals and dismissals),
submission timestamps, bot identity, and reply links. The CLI also reads GitHub
GraphQL review threads: the latest 20 threads, each root comment and latest three
comments, with resolution/outdated state, resolver, and explicit omission counts.
Thread comment bodies are capped at 500 characters; the existing conversation cap
remains 25 comments of 1000 characters. Pending draft reviews are excluded.

These fields are evidence, not automatic label triggers. Repository policy decides
what an outstanding request or any other label means. Low-level `label()` callers
can supply `review_threads` and `review_threads_omitted` alongside `conversation`.
GraphQL permissions must allow reading PR reviews. Failed thread reads stop the
CLI before inference or label writes; omitted context is not proof of resolution.
Review activity only triggers reevaluation when the repository workflow handles
those events. This change does not modify workflow triggers or removal defaults.

### Workflow integration

Check out our examples in the [`examples/github-workflows`](./examples/github-workflows) directory.

This workflow will automatically label issues and pull requests when they are created or updated.
```yml
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

### Changed files and removal conditions

PR decisions also receive bounded file paths, statuses and change counts, with up to 4,000 characters of patch excerpts. The loader reads at most 1,000 files and includes up to 100 files and 8,000 path characters; omitted files and patches are explicitly marked unknown. Fetch failures stop the run before inference or writes. This is evidence for repository policy, not a built-in dependency, feature, or CLI classifier.

For an existing label with `remove_when`, Jev answers a separate question about whether that condition is established. A low application score alone no longer removes such a label. Missing removal answers are represented by `removeNoul: null` and preserve it, including at threshold zero. Conflicting positive application and removal answers also preserve the label, except labels whose application is disabled by policy. Labels without `remove_when` retain the existing low-score removal behavior, and `can_remove: false` still blocks removals. Actual removal continues to require `--remove`.

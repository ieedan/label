[![npm version](https://flat.badgen.net/npm/v/@ieedan/label?color=yellow)](https://npmjs.com/package/@ieedan/label)
[![npm downloads](https://flat.badgen.net/npm/dm/@ieedan/label?color=yellow)](https://npmjs.com/package/@ieedan/label)

# label

A super fast issue/PR labeler built on top of TypeSafe AI's Jev.

Intelligently label issues and pull requests based on their content and history.

## Usage 

You will need a few environment variables:

```sh
TYPESAFE_API_KEY=apikey_...
GITHUB_TOKEN=github_pat_... # you can use the actions one in workflows
```

Then you can use the CLI to label issues and pull requests. (We recommend using the `--dry-run` flag so you can tune what get's applied)

```sh
npx @ieedan/label label -R ieedan/shadcn-svelte-extras --top 5 # top 5 issues/pulls
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

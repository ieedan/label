---
'@ieedan/label': patch
---

Detect the repository from the git remote so `-R` is optional

`label` now falls back to the GitHub remote (`origin`, then `upstream`) of the repository at `--cwd` when `-R`/`--repo` isn't passed, and `parseRepo` understands SSH remote URLs like `git@github.com:owner/name.git`.

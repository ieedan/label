# @ieedan/label

## 0.0.1

### Patch Changes

- Detect the repository from the git remote so `-R` is optional ([#2](https://github.com/ieedan/label/pull/2))
  
  `label` now falls back to the GitHub remote (`origin`, then `upstream`) of the repository at `--cwd` when `-R`/`--repo` isn't passed, and `parseRepo` understands SSH remote URLs like `git@github.com:owner/name.git`.

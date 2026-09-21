import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { err, ok, type Result } from 'nevereverthrow';
import { RepoNotDetectedError } from './errors';
import { type GitHubRepo, parseRepo } from './github';

const exec = promisify(execFile);

/** Remotes preferred (in order) when a repository has more than one GitHub remote. */
export const PREFERRED_REMOTES = ['origin', 'upstream'] as const;

export type GitRemote = {
	name: string;
	url: string;
};

/**
 * Detects the GitHub repository from the git remotes of the repository at `cwd`.
 *
 * @param cwd - Directory inside the git repository. Defaults to the process working directory.
 */
export async function detectRepo(
	cwd: string = process.cwd()
): Promise<Result<GitHubRepo, RepoNotDetectedError>> {
	return selectGitHubRemote(await listGitRemotes(cwd));
}

/**
 * Lists the remotes of the repository at `cwd`. Resolves to an empty list when `cwd` isn't in a
 * git repository, git isn't installed, or the repository has no remotes.
 */
export async function listGitRemotes(cwd: string = process.cwd()): Promise<GitRemote[]> {
	try {
		const { stdout } = await exec('git', ['remote', '-v'], { cwd, windowsHide: true });
		return parseGitRemotes(stdout);
	} catch {
		return [];
	}
}

/** Parses the output of `git remote -v`, preferring the fetch URL of each remote. */
export function parseGitRemotes(output: string): GitRemote[] {
	const remotes: GitRemote[] = [];

	for (const line of output.split('\n')) {
		const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
		if (!match) continue;
		const [, name, url, kind] = match;
		if (name === undefined || url === undefined) continue;

		const existing = remotes.find((remote) => remote.name === name);
		if (existing) {
			if (kind === 'fetch') existing.url = url;
			continue;
		}
		remotes.push({ name, url });
	}

	return remotes;
}

/** Picks the first remote that points at a GitHub repository, preferring `origin` then `upstream`. */
export function selectGitHubRemote(remotes: GitRemote[]): Result<GitHubRepo, RepoNotDetectedError> {
	const preferred = PREFERRED_REMOTES.map((name) =>
		remotes.find((remote) => remote.name === name)
	).filter((remote): remote is GitRemote => remote !== undefined);
	const rest = remotes.filter(
		(remote) => !(PREFERRED_REMOTES as readonly string[]).includes(remote.name)
	);

	for (const remote of [...preferred, ...rest]) {
		const parsed = parseRepo(remote.url);
		if (parsed.isOk()) return ok(parsed.value);
	}

	return err(new RepoNotDetectedError());
}

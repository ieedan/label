import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectRepo, parseGitRemotes, selectGitHubRemote } from '../src/git.js';

const exec = promisify(execFile);

describe('parseGitRemotes', () => {
	it('parses remotes and prefers the fetch URL', () => {
		const remotes = parseGitRemotes(
			[
				'origin\tgit@github.com:ieedan/label.git (fetch)',
				'origin\thttps://github.com/ieedan/label.git (push)',
				'upstream\thttps://github.com/other/label.git (fetch)',
				'upstream\thttps://github.com/other/label.git (push)',
			].join('\n')
		);

		expect(remotes).toEqual([
			{ name: 'origin', url: 'git@github.com:ieedan/label.git' },
			{ name: 'upstream', url: 'https://github.com/other/label.git' },
		]);
	});

	it('ignores lines that are not remotes', () => {
		expect(parseGitRemotes('')).toEqual([]);
		expect(parseGitRemotes('fatal: not a git repository')).toEqual([]);
	});
});

describe('selectGitHubRemote', () => {
	it('prefers origin', () => {
		const result = selectGitHubRemote([
			{ name: 'upstream', url: 'https://github.com/other/label.git' },
			{ name: 'origin', url: 'git@github.com:ieedan/label.git' },
		]);

		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value).toEqual({ owner: 'ieedan', name: 'label' });
		}
	});

	it('falls back to upstream, then to any GitHub remote', () => {
		const upstream = selectGitHubRemote([
			{ name: 'fork', url: 'https://github.com/fork/label.git' },
			{ name: 'upstream', url: 'https://github.com/ieedan/label.git' },
		]);
		expect(upstream.isOk()).toBe(true);
		if (upstream.isOk()) {
			expect(upstream.value).toEqual({ owner: 'ieedan', name: 'label' });
		}

		const other = selectGitHubRemote([
			{ name: 'fork', url: 'https://github.com/fork/label.git' },
		]);
		expect(other.isOk()).toBe(true);
		if (other.isOk()) {
			expect(other.value).toEqual({ owner: 'fork', name: 'label' });
		}
	});

	it('skips remotes that are not GitHub repositories', () => {
		const result = selectGitHubRemote([
			{ name: 'origin', url: 'git@gitlab.com:ieedan/label.git' },
			{ name: 'hub', url: 'https://github.com/ieedan/label.git' },
		]);

		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value).toEqual({ owner: 'ieedan', name: 'label' });
		}
	});

	it('errors when no remote points at GitHub', () => {
		expect(selectGitHubRemote([]).isErr()).toBe(true);
		expect(
			selectGitHubRemote([{ name: 'origin', url: 'git@gitlab.com:ieedan/label.git' }]).isErr()
		).toBe(true);
	});
});

describe('detectRepo', () => {
	let dir: string;

	beforeAll(async () => {
		dir = await mkdtemp(path.join(tmpdir(), 'label-git-'));
		await exec('git', ['init'], { cwd: dir });
	});

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('errors without a remote', async () => {
		const result = await detectRepo(dir);
		expect(result.isErr()).toBe(true);
	});

	it('reads the repository from the origin remote', async () => {
		await exec('git', ['remote', 'add', 'origin', 'git@github.com:ieedan/label.git'], {
			cwd: dir,
		});

		const result = await detectRepo(dir);
		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value).toEqual({ owner: 'ieedan', name: 'label' });
		}
	});
});

import { describe, expect, it } from 'vitest';
import {
	DEFAULT_TOP_ISSUES,
	parseAuthorRole,
	parseGitHubPayload,
	parseIssueNumbers,
	parseRepo,
	resolveIssueSelection,
	resolveItemKind,
	searchSimilarItems,
	similarSearchQuery,
} from '../src/github.js';

describe('parseRepo', () => {
	it('parses owner/name', () => {
		const result = parseRepo('ieedan/label');
		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value).toEqual({ owner: 'ieedan', name: 'label' });
		}
	});

	it('parses GitHub URLs', () => {
		const result = parseRepo('https://github.com/ieedan/label.git');
		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value).toEqual({ owner: 'ieedan', name: 'label' });
		}
	});

	it('parses SSH remote URLs', () => {
		const result = parseRepo('git@github.com:ieedan/label.git');
		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value).toEqual({ owner: 'ieedan', name: 'label' });
		}
	});

	it('parses ssh:// and git:// remote URLs', () => {
		for (const url of [
			'ssh://git@github.com/ieedan/label.git',
			'git://github.com/ieedan/label.git',
			'https://ieedan@github.com/ieedan/label',
		]) {
			const result = parseRepo(url);
			expect(result.isOk(), url).toBe(true);
			if (result.isOk()) {
				expect(result.value).toEqual({ owner: 'ieedan', name: 'label' });
			}
		}
	});

	it('rejects invalid repos', () => {
		expect(parseRepo('label').isErr()).toBe(true);
	});

	it('rejects repositories that are not hosted on GitHub', () => {
		expect(parseRepo('https://gitlab.com/ieedan/label.git').isErr()).toBe(true);
		expect(parseRepo('git@gitlab.com:ieedan/label.git').isErr()).toBe(true);
	});
});

describe('parseIssueNumbers', () => {
	it('parses mixed number formats', () => {
		const result = parseIssueNumbers(['1', '2,3', '#4']);
		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value).toEqual([1, 2, 3, 4]);
		}
	});

	it('rejects empty input', () => {
		expect(parseIssueNumbers([]).isErr()).toBe(true);
	});

	it('rejects non-numbers', () => {
		expect(parseIssueNumbers(['abc']).isErr()).toBe(true);
	});
});

describe('resolveIssueSelection', () => {
	it('selects explicit numbers', () => {
		const result = resolveIssueSelection({ numbers: ['1', '2'] });
		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value).toEqual({ type: 'numbers', numbers: [1, 2] });
		}
	});

	it('selects --all', () => {
		const result = resolveIssueSelection({ all: true });
		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value).toEqual({ type: 'all' });
		}
	});

	it('defaults --top to 10', () => {
		const result = resolveIssueSelection({ top: true });
		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value).toEqual({ type: 'top', count: DEFAULT_TOP_ISSUES });
		}
	});

	it('parses --top 5', () => {
		const result = resolveIssueSelection({ top: 5 });
		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value).toEqual({ type: 'top', count: 5 });
		}
	});

	it('rejects combining numbers with --all', () => {
		expect(resolveIssueSelection({ numbers: ['1'], all: true }).isErr()).toBe(true);
	});

	it('rejects combining --all with --top', () => {
		expect(resolveIssueSelection({ all: true, top: true }).isErr()).toBe(true);
	});
});

describe('resolveItemKind', () => {
	it('defaults to both', () => {
		expect(resolveItemKind({})).toBe('both');
	});

	it('selects issues only', () => {
		expect(resolveItemKind({ issues: true })).toBe('issue');
	});

	it('selects pull requests only', () => {
		expect(resolveItemKind({ prs: true })).toBe('pull_request');
	});

	it('keeps both when both flags are set', () => {
		expect(resolveItemKind({ issues: true, prs: true })).toBe('both');
	});
});

describe('parseGitHubPayload', () => {
	it('parses an issues webhook payload', () => {
		const result = parseGitHubPayload({
			action: 'opened',
			issue: {
				number: 12,
				title: 'Crash on empty input',
				body: 'It blows up.',
				html_url: 'https://github.com/ieedan/label/issues/12',
				user: { login: 'ieedan' },
				author_association: 'OWNER',
				labels: [{ name: 'bug' }],
			},
			repository: { full_name: 'ieedan/label' },
		});

		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value).toMatchObject({
				type: 'issue',
				number: 12,
				title: 'Crash on empty input',
				body: 'It blows up.',
				author: 'ieedan',
				authorRole: 'OWNER',
				currentLabels: ['bug'],
				repository: 'ieedan/label',
			});
		}
	});

	it('parses a pull_request webhook payload', () => {
		const result = parseGitHubPayload({
			action: 'opened',
			pull_request: {
				number: 15,
				title: 'Add dark mode',
				body: null,
				user: { login: 'octocat' },
			},
			repository: { full_name: 'ieedan/label' },
		});

		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value.type).toBe('pull_request');
			expect(result.value.number).toBe(15);
		}
	});

	it('treats an issue with pull_request as a pull request', () => {
		const result = parseGitHubPayload({
			number: 9,
			title: 'Fix types',
			body: '',
			pull_request: { url: 'https://api.github.com/repos/ieedan/label/pulls/9' },
		});

		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value.type).toBe('pull_request');
		}
	});

	it('rejects invalid payloads', () => {
		expect(parseGitHubPayload({ title: 'no number' }).isErr()).toBe(true);
	});

	it('keeps conversation comments from the payload', () => {
		const result = parseGitHubPayload({
			issue: { number: 12, title: 'Crash', body: 'It blows up.' },
			conversation: [
				{
					author: 'octocat',
					author_association: 'CONTRIBUTOR',
					body: 'I can reproduce this.',
					createdAt: '2026-01-01T00:00:00Z',
					kind: 'comment',
				},
			],
		});

		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value.comments).toEqual([
				{
					author: 'octocat',
					role: 'CONTRIBUTOR',
					body: 'I can reproduce this.',
					createdAt: '2026-01-01T00:00:00Z',
					kind: 'comment',
				},
			]);
		}
	});
});

describe('parseAuthorRole', () => {
	it('maps GitHub author_association values', () => {
		expect(parseAuthorRole('OWNER')).toBe('OWNER');
		expect(parseAuthorRole('FIRST_TIME_CONTRIBUTOR')).toBe('FIRST_TIME_CONTRIBUTOR');
		expect(parseAuthorRole('collaborator')).toBe('COLLABORATOR');
		expect(parseAuthorRole('not-a-role')).toBeNull();
		expect(parseAuthorRole(undefined)).toBeNull();
	});
});

describe('similarSearchQuery', () => {
	it('keeps distinctive title words and scopes to the repo', () => {
		expect(
			similarSearchQuery(
				{ owner: 'ieedan', name: 'label' },
				{ title: 'Crash on empty input in the CLI', type: 'issue' }
			)
		).toBe('crash empty input cli repo:ieedan/label is:issue');
	});

	it('uses is:pr for pull requests', () => {
		expect(
			similarSearchQuery(
				{ owner: 'ieedan', name: 'label' },
				{ title: 'Add dark mode', type: 'pull_request' }
			)
		).toBe('add dark mode repo:ieedan/label is:pr');
	});

	it('returns undefined when the title has no usable keywords', () => {
		expect(
			similarSearchQuery(
				{ owner: 'ieedan', name: 'label' },
				{ title: 'a to the', type: 'issue' }
			)
		).toBeUndefined();
	});
});

describe('searchSimilarItems', () => {
	it('searches GitHub, skips the current item, and truncates bodies', async () => {
		const result = await searchSimilarItems(
			{ owner: 'ieedan', name: 'label' },
			{ number: 12, title: 'Crash on empty input', type: 'issue' },
			{
				token: 'test-token',
				limit: 2,
				fetch: async (input) => {
					const url = new URL(String(input));
					expect(url.pathname).toBe('/search/issues');
					expect(url.searchParams.get('q')).toBe(
						'crash empty input repo:ieedan/label is:issue'
					);
					return Response.json({
						items: [
							{
								number: 12,
								title: 'Crash on empty input',
								body: 'This is the current issue.',
							},
							{
								number: 3,
								title: 'Crash when input is empty',
								body: `${'x'.repeat(900)} leftover`,
							},
							{
								number: 4,
								title: 'Another crash',
								body: 'Short.',
							},
							{
								number: 5,
								title: 'Should not be included',
								body: 'Extra.',
							},
						],
					});
				},
			}
		);

		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value).toHaveLength(2);
			expect(result.value[0]).toMatchObject({
				number: 3,
				title: 'Crash when input is empty',
				type: 'issue',
			});
			expect(result.value[0]?.body).toHaveLength(800);
			expect(result.value[0]?.body.endsWith('…')).toBe(true);
			expect(result.value[1]?.number).toBe(4);
		}
	});

	it('returns no candidates when the title cannot form a query', async () => {
		const result = await searchSimilarItems(
			{ owner: 'ieedan', name: 'label' },
			{ number: 1, title: 'a', type: 'issue' },
			{
				token: 'test-token',
				fetch: async () => {
					throw new Error('should not search');
				},
			}
		);

		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value).toEqual([]);
		}
	});
});

import { describe, expect, it } from 'vitest';
import {
	DEFAULT_TOP_ISSUES,
	parseGitHubPayload,
	parseIssueNumbers,
	parseRepo,
	resolveIssueSelection,
	resolveItemKind,
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

	it('rejects invalid repos', () => {
		expect(parseRepo('label').isErr()).toBe(true);
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
					body: 'I can reproduce this.',
					createdAt: '2026-01-01T00:00:00Z',
					kind: 'comment',
				},
			]);
		}
	});
});

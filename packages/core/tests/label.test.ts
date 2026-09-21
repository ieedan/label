import { describe, expect, it } from 'vitest';
import { WrongItemKindError } from '../src/errors.js';
import { questionId } from '../src/jev.js';
import { label, labelIssues } from '../src/label.js';

const labels = [
	{ name: 'bug', description: 'Something is broken.' },
	{ name: 'enhancement', description: 'New capability.' },
];

function emptyConversation(url: string): Response | undefined {
	if (url.includes('/comments') || url.includes('/reviews')) {
		return Response.json([]);
	}
}

describe('label', () => {
	it('judges multiple webhook payloads in one TypeSafe request', async () => {
		let calls = 0;

		const result = await label({
			payload: [
				{
					issue: { number: 1, title: 'Crash', body: 'It crashes' },
					repository: { full_name: 'ieedan/label' },
				},
				{
					pull_request: { number: 2, title: 'Dark mode', body: 'Adds a theme' },
					repository: { full_name: 'ieedan/label' },
				},
			],
			labels,
			ask: async ({ state, questions }) => {
				calls += 1;
				expect(state).toMatchObject({
					items: [{ number: 1 }, { number: 2 }],
					labels: [{ name: 'bug' }, { name: 'enhancement' }],
				});
				expect(Object.keys(questions)).toHaveLength(4);
				return {
					answers: {
						[questionId(0, 0)]: { noul: 0.95 },
						[questionId(0, 1)]: { noul: 0.1 },
						[questionId(1, 0)]: { noul: 0.2 },
						[questionId(1, 1)]: { noul: 0.88 },
					},
				};
			},
		});

		expect(calls).toBe(1);
		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value.decisions.map((decision) => decision.chosen)).toEqual([
				['bug'],
				['enhancement'],
			]);
		}
	});

	it('returns no labels when the repo has none', async () => {
		const result = await label({
			payload: { number: 1, title: 'Crash', body: 'It crashes' },
			labels: [],
			ask: async () => {
				throw new Error('should not call TypeSafe');
			},
		});

		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value.decisions[0]?.chosen).toEqual([]);
		}
	});
});

describe('labelIssues', () => {
	it('fetches GitHub data, asks Jev once, and skips apply on dry run', async () => {
		const requests: string[] = [];

		const result = await labelIssues({
			repo: 'ieedan/label',
			numbers: ['1', '2'],
			dryRun: true,
			token: 'test-token',
			fetch: async (input, init) => {
				const url = String(input);
				requests.push(`${init?.method ?? 'GET'} ${url}`);
				const conversation = emptyConversation(url);
				if (conversation) return conversation;
				if (url.includes('/labels')) {
					return Response.json(labels);
				}
				if (url.endsWith('/issues/1')) {
					return Response.json({ number: 1, title: 'Crash', body: 'It crashes' });
				}
				if (url.endsWith('/issues/2')) {
					return Response.json({
						number: 2,
						title: 'Dark mode',
						body: 'Theme',
						pull_request: {},
					});
				}
				throw new Error(`unexpected ${url}`);
			},
			ask: async () => ({
				answers: {
					[questionId(0, 0)]: { noul: 0.9 },
					[questionId(0, 1)]: { noul: 0.1 },
					[questionId(1, 0)]: { noul: 0.1 },
					[questionId(1, 1)]: { noul: 0.9 },
				},
			}),
		});

		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value.dryRun).toBe(true);
			expect(result.value.decisions.map((decision) => decision.chosen)).toEqual([
				['bug'],
				['enhancement'],
			]);
		}
		expect(requests.some((request) => request.startsWith('POST'))).toBe(false);
	});

	it('sends policy overlay and --prompt to Jev', async () => {
		const result = await labelIssues({
			repo: 'ieedan/label',
			numbers: ['1'],
			dryRun: true,
			token: 'test-token',
			prompt: 'Do not apply enhancement.',
			policy: {
				policy: 'Prefer specific labels.',
				labels: {
					bug: { applyWhen: 'Reproducible crash.' },
				},
			},
			fetch: async (input) => {
				const url = String(input);
				const conversation = emptyConversation(url);
				if (conversation) return conversation;
				if (url.includes('/labels')) {
					return Response.json(labels);
				}
				if (url.endsWith('/issues/1')) {
					return Response.json({ number: 1, title: 'Crash', body: 'It crashes' });
				}
				throw new Error(`unexpected ${url}`);
			},
			ask: async ({ state }) => {
				expect(state).toMatchObject({
					policy: 'Prefer specific labels.',
					prompt: 'Do not apply enhancement.',
					labels: [
						{ name: 'bug', apply_when: 'Reproducible crash.' },
						{ name: 'enhancement' },
					],
				});
				return {
					answers: {
						[questionId(0, 0)]: { noul: 0.9 },
						[questionId(0, 1)]: { noul: 0.1 },
					},
				};
			},
		});

		expect(result.isOk()).toBe(true);
	});

	it('asks Jev only about configured labels when onlyConfigured is set', async () => {
		const result = await labelIssues({
			repo: 'ieedan/label',
			numbers: ['1'],
			dryRun: true,
			token: 'test-token',
			policy: {
				onlyConfigured: true,
				labels: {
					bug: { applyWhen: 'Reproducible crash.' },
				},
			},
			fetch: async (input) => {
				const url = String(input);
				const conversation = emptyConversation(url);
				if (conversation) return conversation;
				if (url.includes('/labels')) {
					return Response.json(labels);
				}
				if (url.endsWith('/issues/1')) {
					return Response.json({ number: 1, title: 'Crash', body: 'It crashes' });
				}
				throw new Error(`unexpected ${url}`);
			},
			ask: async ({ state, questions }) => {
				expect(state).toMatchObject({
					labels: [{ name: 'bug', apply_when: 'Reproducible crash.' }],
				});
				expect(Object.keys(questions)).toHaveLength(1);
				return {
					answers: {
						[questionId(0, 0)]: { noul: 0.9 },
					},
				};
			},
		});

		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value.decisions[0]?.chosen).toEqual(['bug']);
		}
	});

	it('does not apply suggest-only labels', async () => {
		const requests: string[] = [];

		const result = await labelIssues({
			repo: 'ieedan/label',
			numbers: ['1'],
			token: 'test-token',
			policy: {
				labels: {
					bug: { auto: false },
				},
			},
			fetch: async (input, init) => {
				const url = String(input);
				requests.push(`${init?.method ?? 'GET'} ${url}`);
				const conversation = emptyConversation(url);
				if (conversation) return conversation;
				if (url.includes('/labels')) {
					return Response.json(labels);
				}
				if (url.endsWith('/issues/1')) {
					return Response.json({ number: 1, title: 'Crash', body: 'It crashes' });
				}
				if (url.includes('/labels') && init?.method === 'POST') {
					return Response.json([]);
				}
				throw new Error(`unexpected ${url}`);
			},
			ask: async () => ({
				answers: {
					[questionId(0, 0)]: { noul: 0.95 },
					[questionId(0, 1)]: { noul: 0.1 },
				},
			}),
		});

		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value.decisions[0]?.chosen).toEqual(['bug']);
		}
		expect(requests.some((request) => request.startsWith('POST'))).toBe(false);
	});

	it('does not POST labels that are already on the issue', async () => {
		const posts: string[] = [];

		const result = await labelIssues({
			repo: 'ieedan/label',
			numbers: ['1'],
			token: 'test-token',
			fetch: async (input, init) => {
				const url = String(input);
				const conversation = emptyConversation(url);
				if (conversation) return conversation;
				if (url.includes('/labels') && (init?.method ?? 'GET') === 'GET') {
					return Response.json(labels);
				}
				if (url.endsWith('/issues/1')) {
					return Response.json({
						number: 1,
						title: 'Crash',
						body: 'It crashes',
						labels: [{ name: 'bug' }],
					});
				}
				if (url.includes('/labels') && init?.method === 'POST') {
					posts.push(String(init.body));
					return Response.json([]);
				}
				throw new Error(`unexpected ${url}`);
			},
			ask: async () => ({
				answers: {
					[questionId(0, 0)]: { noul: 0.95 },
					[questionId(0, 1)]: { noul: 0.9 },
				},
			}),
		});

		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value.decisions[0]?.chosen).toEqual(['bug', 'enhancement']);
		}
		expect(posts).toEqual([JSON.stringify({ labels: ['enhancement'] })]);
	});

	it('lists open issues for --top and does not fetch by number', async () => {
		const requests: string[] = [];

		const result = await labelIssues({
			repo: 'ieedan/label',
			top: 2,
			dryRun: true,
			token: 'test-token',
			fetch: async (input, init) => {
				const url = String(input);
				requests.push(`${init?.method ?? 'GET'} ${url}`);
				const conversation = emptyConversation(url);
				if (conversation) return conversation;
				if (url.includes('/labels')) {
					return Response.json(labels);
				}
				if (url.includes('/issues?')) {
					expect(url).toContain('state=open');
					expect(url).toContain('sort=updated');
					expect(url).toContain('per_page=100');
					return Response.json([
						{ number: 8, title: 'Newest', body: 'One' },
						{ number: 7, title: 'Older', body: 'Two' },
						{ number: 6, title: 'Should be sliced', body: 'Three' },
					]);
				}
				throw new Error(`unexpected ${url}`);
			},
			ask: async ({ state }) => {
				expect(state).toMatchObject({
					items: [{ number: 8 }, { number: 7 }],
				});
				return {
					answers: {
						[questionId(0, 0)]: { noul: 0.9 },
						[questionId(0, 1)]: { noul: 0.1 },
						[questionId(1, 0)]: { noul: 0.1 },
						[questionId(1, 1)]: { noul: 0.9 },
					},
				};
			},
		});

		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value.decisions.map((decision) => decision.item.number)).toEqual([8, 7]);
		}
		expect(requests.some((request) => /\/issues\/\d+(\?|$)/.test(request))).toBe(false);
	});

	it('lists all states when --include-closed is set', async () => {
		const result = await labelIssues({
			repo: 'ieedan/label',
			all: true,
			includeClosed: true,
			dryRun: true,
			token: 'test-token',
			fetch: async (input) => {
				const url = String(input);
				const conversation = emptyConversation(url);
				if (conversation) return conversation;
				if (url.includes('/labels')) {
					return Response.json(labels);
				}
				if (url.includes('/issues?')) {
					expect(url).toContain('state=all');
					return Response.json([{ number: 3, title: 'Closed one', body: 'Done' }]);
				}
				throw new Error(`unexpected ${url}`);
			},
			ask: async () => ({
				answers: {
					[questionId(0, 0)]: { noul: 0.9 },
					[questionId(0, 1)]: { noul: 0.1 },
				},
			}),
		});

		expect(result.isOk()).toBe(true);
	});

	it('skips pull requests when --issues is set', async () => {
		const result = await labelIssues({
			repo: 'ieedan/label',
			top: 1,
			issues: true,
			dryRun: true,
			token: 'test-token',
			fetch: async (input) => {
				const url = String(input);
				const conversation = emptyConversation(url);
				if (conversation) return conversation;
				if (url.includes('/labels')) {
					return Response.json(labels);
				}
				if (url.includes('/issues?')) {
					return Response.json([
						{ number: 4, title: 'A PR', body: 'pr', pull_request: {} },
						{ number: 3, title: 'An issue', body: 'issue' },
					]);
				}
				throw new Error(`unexpected ${url}`);
			},
			ask: async ({ state }) => {
				expect(state).toMatchObject({
					items: [{ number: 3, type: 'issue' }],
				});
				return {
					answers: {
						[questionId(0, 0)]: { noul: 0.9 },
						[questionId(0, 1)]: { noul: 0.1 },
					},
				};
			},
		});

		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value.decisions.map((decision) => decision.item.number)).toEqual([3]);
		}
	});

	it('errors when an explicit number is the wrong kind', async () => {
		const result = await labelIssues({
			repo: 'ieedan/label',
			numbers: [4],
			issues: true,
			dryRun: true,
			token: 'test-token',
			fetch: async (input) => {
				const url = String(input);
				const conversation = emptyConversation(url);
				if (conversation) return conversation;
				if (url.includes('/labels')) {
					return Response.json(labels);
				}
				if (url.endsWith('/issues/4')) {
					return Response.json({
						number: 4,
						title: 'A PR',
						body: 'pr',
						pull_request: {},
					});
				}
				throw new Error(`unexpected ${url}`);
			},
			ask: async () => {
				throw new Error('should not ask');
			},
		});

		expect(result.isErr()).toBe(true);
		if (result.isErr()) {
			expect(result.error).toBeInstanceOf(WrongItemKindError);
		}
	});

	it('sends issue and pull request comments to Jev', async () => {
		const result = await labelIssues({
			repo: 'ieedan/label',
			numbers: ['1', '2'],
			dryRun: true,
			token: 'test-token',
			fetch: async (input) => {
				const url = String(input);
				if (url.includes('/labels')) {
					return Response.json(labels);
				}
				if (url.endsWith('/issues/1')) {
					return Response.json({ number: 1, title: 'Crash', body: 'It crashes' });
				}
				if (url.includes('/issues/1/comments')) {
					return Response.json([
						{
							user: { login: 'octocat' },
							body: 'I can reproduce this on main.',
							created_at: '2026-01-02T00:00:00Z',
						},
					]);
				}
				if (url.endsWith('/issues/2')) {
					return Response.json({
						number: 2,
						title: 'Dark mode',
						body: 'Theme',
						pull_request: {},
					});
				}
				if (url.includes('/issues/2/comments')) {
					return Response.json([
						{
							user: { login: 'ieedan' },
							body: 'Please add a screenshot.',
							created_at: '2026-01-01T00:00:00Z',
						},
					]);
				}
				if (url.includes('/pulls/2/comments')) {
					return Response.json([
						{
							user: { login: 'reviewer' },
							body: 'The contrast on the toggle is too low.',
							created_at: '2026-01-03T00:00:00Z',
						},
					]);
				}
				if (url.includes('/pulls/2/reviews')) {
					return Response.json([
						{
							user: { login: 'reviewer' },
							body: 'Looks good after the contrast fix.',
							state: 'APPROVED',
							created_at: '2026-01-04T00:00:00Z',
						},
					]);
				}
				throw new Error(`unexpected ${url}`);
			},
			ask: async ({ state }) => {
				expect(state).toMatchObject({
					items: [
						{
							number: 1,
							comments: [
								{
									author: 'octocat',
									body: 'I can reproduce this on main.',
									kind: 'comment',
								},
							],
						},
						{
							number: 2,
							comments: [
								{
									author: 'ieedan',
									body: 'Please add a screenshot.',
									kind: 'comment',
								},
								{
									author: 'reviewer',
									body: 'The contrast on the toggle is too low.',
									kind: 'review_comment',
								},
								{
									author: 'reviewer',
									body: 'Looks good after the contrast fix.',
									kind: 'review',
								},
							],
						},
					],
				});
				return {
					answers: {
						[questionId(0, 0)]: { noul: 0.9 },
						[questionId(0, 1)]: { noul: 0.1 },
						[questionId(1, 0)]: { noul: 0.1 },
						[questionId(1, 1)]: { noul: 0.9 },
					},
				};
			},
		});

		expect(result.isOk()).toBe(true);
	});
});

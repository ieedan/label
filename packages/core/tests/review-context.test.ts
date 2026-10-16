import { describe, expect, it } from 'vitest';
import { listItemConversation, listReviewThreads, parseGitHubPayload } from '../src/github';
import { buildContextRequest, buildRequest } from '../src/jev';
import { labelIssues } from '../src/label';

const repo = { owner: 'o', name: 'r' };
const c = (id: string, body = 'Please add coverage.') => ({
	id,
	body,
	createdAt: '2026-10-11T00:00:00Z',
	authorAssociation: 'COLLABORATOR',
	author: { login: 'maintainer', __typename: 'User' },
	pullRequestReview: { state: 'CHANGES_REQUESTED' },
});

describe('generic review context', () => {
	it('retains empty approvals/dismissals, submission times and bot identity but excludes pending reviews', async () => {
		const r = await listItemConversation(
			repo,
			{ type: 'pull_request', number: 1 },
			{
				token: 'test',
				fetch: async (input) =>
					Response.json(
						String(input).includes('/reviews')
							? [
									{
										id: 1,
										user: { login: 'm', type: 'User' },
										author_association: 'COLLABORATOR',
										body: '',
										state: 'APPROVED',
										submitted_at: '2026-10-11T00:00:00Z',
									},
									{
										id: 2,
										user: { login: 'Copilot', type: 'Bot' },
										body: '',
										state: 'DISMISSED',
										submitted_at: '2026-10-11T01:00:00Z',
									},
									{ id: 3, body: 'Private draft', state: 'PENDING' },
								]
							: []
					),
			}
		);
		if (r.isErr()) throw r.error;
		expect(r.value).toMatchObject([
			{
				id: '1',
				body: '',
				reviewState: 'APPROVED',
				createdAt: '2026-10-11T00:00:00Z',
				isBot: false,
			},
			{ reviewState: 'DISMISSED', isBot: true },
		]);
		expect(r.value).toHaveLength(2);
	});
	it('preserves inline reply identifiers', async () => {
		const r = await listItemConversation(
			repo,
			{ type: 'pull_request', number: 1 },
			{
				token: 'test',
				fetch: async (input) =>
					Response.json(
						String(input).includes('/pulls/1/comments')
							? [
									{
										id: 2,
										in_reply_to_id: 1,
										user: { login: 'author', type: 'User' },
										body: 'Done.',
									},
								]
							: []
					),
			}
		);
		if (r.isErr()) throw r.error;
		expect(r.value[0]).toMatchObject({ id: '2', replyToId: '1', isBot: false });
	});
	it('retains root requests, recent replies, resolution/outdated state and omission counts', async () => {
		const root = c('root');
		const reply = { ...c('reply', 'Done.'), replyTo: { id: 'root' } };
		const r = await listReviewThreads(repo, 1, {
			token: 'test',
			fetch: async (_input, init) => {
				const request = JSON.parse(String(init?.body));
				expect(request.variables).toEqual({ owner: 'o', name: 'r', number: 1 });
				return Response.json({
					data: {
						repository: {
							pullRequest: {
								reviewThreads: {
									pageInfo: { hasPreviousPage: true },
									nodes: [
										{
											id: 'thread',
											isResolved: true,
											isOutdated: true,
											resolvedBy: { login: 'm' },
											root: { nodes: [root] },
											recent: { totalCount: 5, nodes: [reply] },
										},
									],
								},
							},
						},
					},
				});
			},
		});
		if (r.isErr()) throw r.error;
		expect(r.value).toMatchObject({
			omitted: true,
			threads: [
				{
					isResolved: true,
					isOutdated: true,
					resolvedBy: 'm',
					commentsOmitted: 3,
					comments: [
						{ id: 'root', isBot: false },
						{ id: 'reply', replyToId: 'root' },
					],
				},
			],
		});
	});
	it('deduplicates root/recent comments, bounds bodies and excludes draft comments', async () => {
		const root = c('root', 'x'.repeat(1000));
		const r = await listReviewThreads(repo, 1, {
			token: 'test',
			fetch: async () =>
				Response.json({
					data: {
						repository: {
							pullRequest: {
								reviewThreads: {
									pageInfo: { hasPreviousPage: false },
									nodes: [
										{
											id: 't',
											isResolved: false,
											isOutdated: false,
											root: { nodes: [root] },
											recent: {
												totalCount: 2,
												nodes: [
													root,
													{
														...c('draft'),
														pullRequestReview: { state: 'PENDING' },
													},
												],
											},
										},
									],
								},
							},
						},
					},
				}),
		});
		if (r.isErr()) throw r.error;
		expect(r.value.threads[0]!.comments).toHaveLength(1);
		expect(r.value.threads[0]!.comments[0]!.body).toHaveLength(500);
		expect(r.value.threads[0]!.commentsOmitted).toBe(1);
	});
	it('fails on GraphQL errors or missing context instead of silently reporting no threads', async () => {
		for (const response of [
			{ errors: [{ message: 'Not authorized' }] },
			{ data: { repository: null } },
		]) {
			const r = await listReviewThreads(repo, 1, {
				token: 'test',
				fetch: async () => Response.json(response),
			});
			expect(r.isErr()).toBe(true);
		}
	});
	it('passes structured context to arbitrary local and similar-item policies', () => {
		const thread = {
			id: 't',
			isResolved: false,
			isOutdated: false,
			resolvedBy: null,
			comments: [
				{
					body: 'Consider this optional idea.',
					author: 'm',
					role: 'COLLABORATOR',
					kind: 'review_comment',
					isBot: false,
				},
			],
			commentsOmitted: 0,
		};
		const r = parseGitHubPayload({
			pull_request: { number: 1, title: 'A change' },
			conversation: [{ body: '', reviewState: 'APPROVED', kind: 'review', isBot: false }],
			review_threads: [thread],
			review_threads_omitted: false,
		});
		if (r.isErr()) throw r.error;
		const labels = [{ name: 'discussion', description: 'Interesting optional suggestions.' }];
		for (const request of [
			buildRequest([r.value], labels),
			buildContextRequest([{ item: r.value, candidates: [] }], labels),
		]) {
			expect(request.state.items[0]).toMatchObject({
				reviewThreads: [{ isResolved: false }],
				comments: [{ body: '', reviewState: 'APPROVED' }],
			});
			expect(request.questions.item_0_label_0!.instructions).toMatchObject({
				judge_from: expect.stringContaining('configured policy'),
			});
		}
	});
});

it.each([
	false,
	true,
])('loads thread context through the CLI and stops on errors (fail=%s)', async (fail) => {
	let asked = false;
	const r = await labelIssues({
		repo: 'o/r',
		numbers: [1],
		token: 'test',
		dryRun: true,
		fetch: async (input) => {
			const url = String(input);
			if (url.endsWith('/graphql'))
				return Response.json(
					fail
						? { errors: [{ message: 'denied' }] }
						: {
								data: {
									repository: {
										pullRequest: {
											reviewThreads: {
												pageInfo: { hasPreviousPage: false },
												nodes: [
													{
														id: 't',
														isResolved: false,
														isOutdated: false,
														root: { nodes: [c('root')] },
														recent: {
															totalCount: 1,
															nodes: [c('root')],
														},
													},
												],
											},
										},
									},
								},
							}
				);
			if (url.includes('/files?'))
				return Response.json([
					{
						filename: 'src/public.ts',
						status: 'modified',
						additions: 2,
						deletions: 1,
						patch: '@@\n+export const option = true;',
					},
				]);
			if (url.endsWith('/issues/1'))
				return Response.json({ number: 1, title: 'A change', pull_request: {} });
			if (url.includes('/labels'))
				return Response.json([{ name: 'custom', description: 'Repository policy' }]);
			return Response.json([]);
		},
		ask: async ({ state }) => {
			asked = true;
			expect(state).toMatchObject({
				items: [
					{
						reviewThreads: [{ id: 't', comments: [{ body: 'Please add coverage.' }] }],
						files: [{ filename: 'src/public.ts', additions: 2 }],
					},
				],
			});
			return { answers: { item_0_label_0: { noul: 0.8 } } };
		},
	});
	expect(r.isErr()).toBe(fail);
	expect(asked).toBe(!fail);
});

import { describe, expect, it } from 'vitest';
import { humanRemovedLabels, listHumanRemovedLabels, parseGitHubPayload } from '../src/github';
import { buildRequest, collectDecisions, labelsToApply, labelsToRemove } from '../src/jev';
import { labelIssues } from '../src/label';

const event = (action: string, name = 'bug', type = 'User', id = 1) => ({
	id,
	event: action,
	label: { name },
	actor: { type },
	created_at: '2026-10-11T00:00:00Z',
});

describe('human removal veto', () => {
	it('ignores bots and unknown actors, and compares label names without case sensitivity', () => {
		expect(
			humanRemovedLabels([
				event('unlabeled', 'Bug', 'User', 1),
				event('labeled', 'bug', 'Bot', 2),
				event('unlabeled', 'docs', 'Bot', 3),
				{ ...event('labeled', 'bug', 'User', 4), actor: null },
			])
		).toEqual(['Bug']);
	});
	it('lets a later human addition lift the veto, including actions in the same second', () => {
		expect(
			humanRemovedLabels([event('labeled', 'BUG', 'User', 2), event('unlabeled')])
		).toEqual([]);
		expect(
			humanRemovedLabels([
				event('unlabeled', 'bug', 'User', 3),
				event('labeled', 'bug', 'User', 2),
			])
		).toEqual(['bug']);
	});
	it('preserves classification when a bot has restored a human-removed label', () => {
		const parsed = parseGitHubPayload({
			issue: { number: 1, title: 'Bug', labels: ['bug'] },
			human_removed_labels: ['bug'],
		});
		if (parsed.isErr()) throw parsed.error;
		const [decision] = collectDecisions(
			[parsed.value],
			[{ name: 'bug', description: null }],
			{ item_0_label_0: { noul: 0.99 } },
			0.6
		);
		expect(decision!.labels[0]!.apply).toBe(true);
		expect(decision!.chosen).toEqual([]);
		expect(labelsToApply(decision!)).toEqual([]);
		expect(labelsToRemove(decision!)).toEqual([]);
	});
	it('loads label history across pages', async () => {
		const reads: string[] = [];
		const r = await listHumanRemovedLabels({ owner: 'o', name: 'r' }, 1, {
			token: 'test',
			fetch: async (input) => {
				const url = new URL(String(input));
				reads.push(url.searchParams.get('page')!);
				return Response.json(
					url.searchParams.get('page') === '1'
						? [
								event('unlabeled'),
								...Array.from({ length: 99 }, () => ({ event: 'commented' })),
							]
						: [
								event('labeled', 'bug', 'User', 2),
								event('unlabeled', 'docs', 'User', 3),
							]
				);
			},
		});
		expect(r.isOk()).toBe(true);
		if (r.isOk()) expect(r.value).toEqual(['docs']);
		expect(reads).toEqual(['1', '2']);
	});
	it('vetoes high model scores without changing the model request or removal semantics', () => {
		const p = parseGitHubPayload({
			issue: { number: 1, title: 'Bug', labels: ['docs'] },
			human_removed_labels: ['BUG'],
		});
		if (p.isErr()) throw p.error;
		const labels = [
			{ name: 'bug', description: null },
			{ name: 'docs', description: null },
		];
		expect(buildRequest([p.value], labels).state.items[0]).not.toHaveProperty(
			'humanRemovedLabels'
		);
		const [d] = collectDecisions(
			[p.value],
			labels,
			{ item_0_label_0: { noul: 0.99 }, item_0_label_1: { noul: 0.01 } },
			0.6
		);
		expect(d!.chosen).toEqual([]);
		expect(d!.labels[0]!.apply).toBe(true); // Preserve the model judgment for removal decisions.
		expect(labelsToApply(d!)).toEqual([]);
		expect(labelsToRemove(d!)).toEqual(['docs']);
		// The addition guard enforces the veto without rewriting classification.
		expect(labelsToApply(d!)).toEqual([]);
	});
});

async function run(options: {
	initial?: ReturnType<typeof event>[];
	refreshed?: ReturnType<typeof event>[];
	failRefresh?: boolean;
	failInitial?: boolean;
	dryRun?: boolean;
	pr?: boolean;
}) {
	const writes: unknown[] = [];
	let eventReads = 0;
	const r = await labelIssues({
		repo: 'o/r',
		numbers: [1],
		token: 'test',
		dryRun: options.dryRun,
		fetch: async (input, init) => {
			const url = String(input);
			if (init?.method === 'POST') {
				writes.push(JSON.parse(String(init.body)));
				return Response.json({});
			}
			if (url.includes('/events')) {
				eventReads++;
				if (
					(eventReads === 1 && options.failInitial) ||
					(eventReads > 1 && options.failRefresh)
				)
					return new Response('Unavailable', { status: 503 });
				return Response.json(
					eventReads === 1
						? (options.initial ?? [])
						: (options.refreshed ?? options.initial ?? [])
				);
			}
			if (url.endsWith('/issues/1'))
				return Response.json({
					number: 1,
					title: 'Bug',
					labels: [],
					...(options.pr ? { pull_request: {} } : {}),
				});
			if (url.includes('/labels')) return Response.json([{ name: 'bug', description: null }]);
			return Response.json([]);
		},
		ask: async () => ({ answers: { item_0_label_0: { noul: 0.99 } } }),
	});
	return { r, writes, eventReads };
}

describe('addition integration', () => {
	it.each([false, true])('blocks reapplication on issue/pr (pr=%s)', async (pr) => {
		const { r, writes } = await run({ initial: [event('unlabeled')], pr });
		expect(r.isOk()).toBe(true);
		expect(writes).toEqual([]);
	});
	it('still adds labels after a later human addition lifts the veto', async () => {
		const { r, writes } = await run({
			initial: [event('unlabeled'), event('labeled', 'bug', 'User', 2)],
		});
		expect(r.isOk()).toBe(true);
		expect(writes).toEqual([{ labels: ['bug'] }]);
	});
	it('refreshes history and blocks a removal made during inference', async () => {
		const { r, writes, eventReads } = await run({ refreshed: [event('unlabeled')] });
		expect(r.isOk()).toBe(true);
		expect(eventReads).toBe(2);
		expect(writes).toEqual([]);
		if (r.isOk()) {
			expect(r.value.decisions[0]!.chosen).toEqual([]);
			expect(r.value.decisions[0]!.labels[0]!.apply).toBe(true);
		}
	});
	it.each([
		'initial',
		'refresh',
	])('does not add labels when the %s history read fails', async (phase) => {
		const { r, writes } = await run({
			failInitial: phase === 'initial',
			failRefresh: phase === 'refresh',
		});
		expect(r.isErr()).toBe(true);
		expect(writes).toEqual([]);
	});
	it('reports the veto in a dry run without writes', async () => {
		const { r, writes, eventReads } = await run({
			initial: [event('unlabeled')],
			dryRun: true,
		});
		expect(r.isOk()).toBe(true);
		expect(writes).toEqual([]);
		expect(eventReads).toBe(1);
		if (r.isOk()) expect(r.value.decisions[0]!.chosen).toEqual([]);
	});
});

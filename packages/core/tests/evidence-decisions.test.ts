import { describe, expect, it } from 'vitest';
import { listChangedFiles, parseGitHubPayload } from '../src/github';
import { buildRequest, collectDecisions, labelsToRemove } from '../src/jev';

const item = {
	type: 'issue' as const,
	number: 1,
	title: 'Needs investigation',
	body: null,
	currentLabels: ['status'],
	comments: [],
};
const labels = [
	{
		name: 'status',
		description: null,
		canApply: false,
		removeWhen: 'A human confirms the report.',
	},
];
describe('generic removal conditions', () => {
	it('requires affirmative removal evidence even when application is disabled', () => {
		const request = buildRequest([item], labels);
		expect(request.state.items[0]).not.toHaveProperty('currentLabels');
		expect(Object.keys(request.questions)).toContain('item_0_label_0_remove');
		const negative = collectDecisions(
			[item],
			labels,
			{ item_0_label_0: { noul: 0.01 }, item_0_label_0_remove: { noul: 0.1 } },
			0.6
		)[0]!;
		expect(labelsToRemove(negative)).toEqual([]);
		const positive = collectDecisions(
			[item],
			labels,
			{ item_0_label_0: { noul: 0.01 }, item_0_label_0_remove: { noul: 0.9 } },
			0.6
		)[0]!;
		expect(labelsToRemove(positive)).toEqual(['status']);
	});
	it.each([
		0, 0.6, 1,
	])('preserves explicit-removal labels without an answer at threshold %s', (threshold) => {
		const decision = collectDecisions([item], labels, {}, threshold)[0]!;
		expect(decision.labels[0]!.removeNoul).toBeNull();
		expect(labelsToRemove(decision)).toEqual([]);
	});

	it('fails closed for a missing removal answer and preserves legacy labels without a removal condition', () => {
		expect(labelsToRemove(collectDecisions([item], labels, {}, 0.6)[0]!)).toEqual([]);
		expect(
			labelsToRemove(
				collectDecisions([item], [{ name: 'status', description: null }], {}, 0.6)[0]!
			)
		).toEqual(['status']);
	});
});
it('preserves an existing label when application and explicit removal answers conflict', () => {
	const both = collectDecisions(
		[item],
		[{ name: 'status', description: null, removeWhen: 'The request was withdrawn.' }],
		{ item_0_label_0: { noul: 0.9 }, item_0_label_0_remove: { noul: 0.9 } },
		0.6
	)[0]!;
	expect(labelsToRemove(both)).toEqual([]);
});

describe('bounded changed-file evidence', () => {
	it('paginates, bounds patches and preserves paths and omission metadata through the parser and prompt', async () => {
		let calls = 0;
		const r = await listChangedFiles({ owner: 'o', name: 'r' }, 1, {
			token: 'test',
			fetch: async () => {
				calls++;
				return Response.json(
					calls === 1
						? Array.from({ length: 100 }, (_, i) => ({
								filename: `src/${i}.ts`,
								status: 'modified',
								additions: 1,
								deletions: 0,
								patch: 'a'.repeat(900),
							}))
						: []
				);
			},
		});
		if (r.isErr()) throw r.error;
		expect(calls).toBe(2);
		expect(r.value.files).toHaveLength(100);
		expect(r.value.files.reduce((n, f) => n + (f.patch?.length ?? 0), 0)).toBeLessThanOrEqual(
			4000
		);
		expect(r.value.files.every((f) => f.patchOmitted)).toBe(true);
		const parsed = parseGitHubPayload({
			issue: { number: 1, title: 'test', pull_request: {} },
			files: r.value.files,
			files_omitted: r.value.omitted,
		});
		if (parsed.isErr()) throw parsed.error;
		expect(buildRequest([parsed.value], []).state.items[0]?.files).toEqual(r.value.files);
	});
	it('stops after ten full pages and marks missing file context', async () => {
		const r = await listChangedFiles({ owner: 'o', name: 'r' }, 1, {
			token: 'test',
			fetch: async () =>
				Response.json(
					Array.from({ length: 100 }, (_, i) => ({
						filename: `src/${i}.ts`,
						status: 'modified',
						additions: 1,
						deletions: 0,
					}))
				),
		});
		if (r.isErr()) throw r.error;
		expect(r.value.omitted).toBe(true);
	});
	it('propagates file-fetch errors', async () => {
		expect(
			(
				await listChangedFiles({ owner: 'o', name: 'r' }, 1, {
					token: 'test',
					fetch: async () => new Response('', { status: 403 }),
				})
			).isErr()
		).toBe(true);
	});
});

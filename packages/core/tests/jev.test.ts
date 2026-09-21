import { describe, expect, it } from 'vitest';
import type { LabelItem, RepoLabel } from '../src/github.js';
import {
	buildRequest,
	chunkItems,
	collectDecisions,
	labelsToApply,
	questionId,
	REQUEST_CHAR_BUDGET,
} from '../src/jev.js';

const labels: RepoLabel[] = [
	{ name: 'bug', description: 'Something is broken.' },
	{ name: 'enhancement', description: 'New capability.' },
];

function item(number: number, title = `Issue ${number}`): LabelItem {
	return {
		type: 'issue',
		number,
		title,
		body: 'Details.',
		currentLabels: [],
		comments: [],
	};
}

describe('buildRequest', () => {
	it('puts every item in one state and one Noul per item-label pair', () => {
		const items = [item(1), item(2)];
		const { state, questions } = buildRequest(items, labels);

		expect(state.items).toHaveLength(2);
		expect(state.labels).toHaveLength(2);
		expect(Object.keys(questions)).toEqual([
			questionId(0, 0),
			questionId(0, 1),
			questionId(1, 0),
			questionId(1, 1),
		]);
		expect(questions[questionId(1, 0)]?.instructions).toMatchObject({
			question: expect.stringContaining('`items[1]`'),
			judge_from: expect.stringContaining('comments'),
		});
		expect(state.items[0]).toMatchObject({ comments: [] });
		expect(state).toMatchObject({ policy: null, prompt: null });
	});

	it('includes policy overlay and prompt in state', () => {
		const { state, questions } = buildRequest(
			[item(1)],
			[
				{
					name: 'bug',
					description: 'Something is broken.',
					applyWhen: 'Reproducible incorrect behavior.',
					notWhen: 'Missing features.',
					examples: ['Crash when input is empty'],
				},
			],
			{ policy: 'Prefer specific labels.', prompt: 'Do not apply enhancement.' }
		);

		expect(state).toMatchObject({
			policy: 'Prefer specific labels.',
			prompt: 'Do not apply enhancement.',
			labels: [
				{
					name: 'bug',
					apply_when: 'Reproducible incorrect behavior.',
					not_when: 'Missing features.',
					examples: ['Crash when input is empty'],
				},
			],
		});
		expect(questions[questionId(0, 0)]?.instructions).toMatchObject({
			judge_from: expect.stringContaining('`prompt`'),
			label: expect.stringContaining('apply_when'),
		});
	});
});

describe('collectDecisions', () => {
	it('applies labels at or above the threshold', () => {
		const decisions = collectDecisions(
			[item(1), item(2)],
			labels,
			{
				[questionId(0, 0)]: { noul: 0.91 },
				[questionId(0, 1)]: { noul: 0.12 },
				[questionId(1, 0)]: { noul: 0.4 },
				[questionId(1, 1)]: { noul: 0.6 },
			},
			0.6
		);

		expect(decisions[0]?.chosen).toEqual(['bug']);
		expect(decisions[1]?.chosen).toEqual(['enhancement']);
	});

	it('uses per-label thresholds and skips auto:false when applying', () => {
		const decisions = collectDecisions(
			[item(1)],
			[
				{ name: 'bug', description: null, threshold: 0.9 },
				{ name: 'good first issue', description: null, auto: false },
			],
			{
				[questionId(0, 0)]: { noul: 0.8 },
				[questionId(0, 1)]: { noul: 0.9 },
			},
			0.6
		);

		expect(decisions[0]?.chosen).toEqual(['good first issue']);
		expect(labelsToApply(decisions[0]!)).toEqual([]);
	});
});

describe('chunkItems', () => {
	it('keeps small batches together', () => {
		expect(chunkItems([item(1), item(2)], labels)).toHaveLength(1);
	});

	it('splits when the request would exceed the character budget', () => {
		const huge = item(1, 'x'.repeat(REQUEST_CHAR_BUDGET));
		const chunks = chunkItems([huge, item(2)], labels);
		expect(chunks.length).toBeGreaterThan(1);
	});
});

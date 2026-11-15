import { describe, expect, it, vi } from 'vitest';
import { createDecisionsAsk } from '../src/decisions.js';
import { buildRequest } from '../src/jev.js';

const request = buildRequest(
	[
		{
			type: 'issue',
			number: 2,
			title: 'Crash on startup',
			body: '',
			currentLabels: [],
			comments: [],
		},
	],
	[{ name: 'bug', description: 'Something is broken.' }]
);
const name = 'item_0_label_0';

describe('Decisions API adapters', () => {
	it('sends OpenAI predicates and maps probabilities by name', async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json({ answers: [{ type: 'predicate', name, probability: 0.2 }] })
			);
		const ask = createDecisionsAsk(
			'openai',
			{
				LABEL_DECISION_BASE_URL: 'https://example.com/api/v1/',
				LABEL_DECISION_API_KEY: 'gateway-key',
				LABEL_DECISION_MODEL: 'custom-model',
			},
			fetcher
		);

		await expect(ask(request)).resolves.toEqual({ answers: { [name]: { noul: 0.2 } } });
		const [url, options] = fetcher.mock.calls[0] ?? [];
		expect(String(url)).toBe('https://example.com/api/v1/decisions');
		expect(options?.headers).toMatchObject({ Authorization: 'Bearer gateway-key' });
		expect(JSON.parse(String(options?.body))).toMatchObject({
			model: 'custom-model',
			input: expect.stringContaining('Crash on startup'),
			questions: [
				{ name, type: 'predicate', instructions: expect.stringContaining('judge_from') },
			],
		});
	});

	it('sends Gemini keyed noul questions and uses P(yes), even when confidence favors no', async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json({ answers: { [name]: { type: 'noul', noul: 0.1, confidence: 0.9 } } })
			);
		const ask = createDecisionsAsk('gemini', { GEMINI_API_KEY: 'google-key' }, fetcher);

		await expect(ask(request)).resolves.toEqual({ answers: { [name]: { noul: 0.1 } } });
		const [url, options] = fetcher.mock.calls[0] ?? [];
		expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/decisions');
		expect(options?.headers).toMatchObject({ 'x-goog-api-key': 'google-key' });
		expect(JSON.parse(String(options?.body))).toMatchObject({
			model: 'gemini-decision-1',
			questions: {
				[name]: { type: 'noul', instructions: expect.stringContaining('judge_from') },
			},
		});
	});

	it('rejects refused answers instead of interpreting them as a negative decision', async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ answers: [{ type: 'refusal', name }] }));
		const ask = createDecisionsAsk('openai', { OPENAI_API_KEY: 'test' }, fetcher);
		await expect(ask(request)).rejects.toThrow('Missing valid answer');
	});

	it('preserves every answer when an OpenAI request crosses the question limit', async () => {
		const question = request.questions[name];
		if (!question) throw new Error('Missing test question');
		const questions = Object.fromEntries(
			Array.from({ length: 401 }, (_, i) => [`q${i}`, question])
		);
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
			const body = JSON.parse(String(options?.body)) as {
				questions: Array<{ name: string }>;
			};
			return Response.json({
				answers: body.questions.map(({ name }) => ({
					type: 'predicate',
					name,
					probability: 0,
				})),
			});
		});
		const ask = createDecisionsAsk('openai', { OPENAI_API_KEY: 'test' }, fetcher);
		const result = await ask({ ...request, questions });
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(Object.keys(result.answers)).toHaveLength(401);
		expect(result.answers.q400).toEqual({ noul: 0 });
	});
});

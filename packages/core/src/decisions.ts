import { z } from 'zod';
import type { AskSystemOne } from './jev';

const providers = {
	openai: {
		baseUrl: 'https://api.openai.com/v1',
		model: 'gpt-6-luna',
		key: 'OPENAI_API_KEY',
		limit: 400,
	},
	gemini: {
		baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
		model: 'gemini-decision-1',
		key: 'GEMINI_API_KEY',
		limit: 1000,
	},
} as const;

const probability = z.number().min(0).max(1);
const openAIAnswer = z.object({
	type: z.literal('predicate'),
	name: z.string(),
	probability,
});
const geminiAnswer = z.object({ type: z.literal('noul'), noul: probability });

export function createDecisionsAsk(
	provider: keyof typeof providers,
	env: NodeJS.ProcessEnv = process.env,
	fetcher: typeof fetch = fetch
): AskSystemOne {
	const defaults = providers[provider];
	const baseUrl = env.LABEL_DECISION_BASE_URL?.trim();
	const key = env.LABEL_DECISION_API_KEY?.trim() || env[defaults.key]?.trim();
	if (!key) throw new Error(`Set LABEL_DECISION_API_KEY or ${defaults.key}.`);
	const url = new URL(`${(baseUrl || defaults.baseUrl).replace(/\/+$/, '')}/decisions`);
	if (
		!['https:', 'http:'].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
	) {
		throw new Error('Use an HTTPS base URL or an HTTP loopback address.');
	}

	const model = env.LABEL_DECISION_MODEL?.trim() || defaults.model;
	const headers = {
		'content-type': 'application/json',
		...(provider === 'openai' ? { Authorization: `Bearer ${key}` } : { 'x-goog-api-key': key }),
	};

	return async ({ state, questions }) => {
		const answers: Awaited<ReturnType<AskSystemOne>>['answers'] = {};
		const entries = Object.entries(questions);
		const input = JSON.stringify(state);
		for (let start = 0; start < entries.length; start += defaults.limit) {
			const batch = entries.slice(start, start + defaults.limit);
			const translated = batch.map(([name, question]) => {
				const parts = question.instructions;
				const instructions = typeof parts === 'string' ? parts : JSON.stringify(parts);
				return { name, instructions };
			});
			const wireQuestions =
				provider === 'openai'
					? translated.map((question) => ({ ...question, type: 'predicate' }))
					: Object.fromEntries(
							translated.map(({ name, instructions }) => [
								name,
								{ type: 'noul', instructions },
							])
						);
			const response = await fetcher(url, {
				method: 'POST',
				headers,
				body: JSON.stringify({ model, input, questions: wireQuestions }),
				signal: AbortSignal.timeout(120_000),
				redirect: 'error',
			});
			if (!response.ok)
				throw new Error(`Decisions endpoint returned HTTP ${response.status}.`);
			const payload = z.object({ answers: z.unknown() }).parse(await response.json());
			const scores =
				provider === 'openai'
					? readOpenAIScores(payload.answers)
					: readGeminiScores(payload.answers);
			for (const [name] of batch) {
				const score = scores[name];
				if (typeof score !== 'number') throw new Error(`Missing valid answer for ${name}.`);
				answers[name] = { noul: score };
			}
		}
		return { answers };
	};
}

function readOpenAIScores(answers: unknown): Record<string, number> {
	const values = z.array(z.unknown()).parse(answers);
	const scores = new Map<string, number>();
	for (const value of values) {
		const parsed = openAIAnswer.safeParse(value);
		if (!parsed.success) continue;
		const { name, probability } = parsed.data;
		if (scores.has(name)) throw new Error(`Duplicate answer for ${name}.`);
		scores.set(name, probability);
	}
	return Object.fromEntries(scores);
}

function readGeminiScores(answers: unknown): Record<string, number> {
	return Object.fromEntries(
		Object.entries(z.record(z.string(), geminiAnswer).parse(answers)).map(([name, answer]) => [
			name,
			answer.noul,
		])
	);
}

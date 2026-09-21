import { type EntryType, type NoulQuestion, noul, TypeSafeClient } from '@typesafe-ai/sdk';
import { err, ok, type Result } from 'nevereverthrow';
import { MissingTypeSafeApiKeyError, TypeSafeRequestError } from './errors';
import type { LabelItem, SimilarItem } from './github';
import type { LabelDefinition } from './policy';

/** Conservative cap under TypeSafe's ~150,000 character / ~32,000 token request budget. */
export const REQUEST_CHAR_BUDGET = 100_000;
export const DEFAULT_LABEL_THRESHOLD = 0.6;
export const TYPESAFE_TIMEOUT_MS = 120_000;

export type LabelJudgment = {
	name: string;
	description: string | null;
	color?: string;
	noul: number;
	threshold: number;
	apply: boolean;
	auto: boolean;
	remove: boolean;
};

export type LabelDecision = {
	item: LabelItem;
	labels: LabelJudgment[];
	chosen: string[];
};

export type AskContext = {
	policy?: string;
	prompt?: string;
};

export type AskSystemOne = (request: {
	state: EntryType;
	questions: Record<string, NoulQuestion>;
}) => Promise<{ answers: Record<string, { noul: number }> }>;

export function questionId(itemIndex: number, labelIndex: number): string {
	return `item_${itemIndex}_label_${labelIndex}`;
}

export function itemState(item: LabelItem) {
	return {
		type: item.type,
		number: item.number,
		title: item.title,
		body: item.body ?? '',
		author: item.author ?? null,
		comments: item.comments ?? [],
	};
}

export function labelState(label: LabelDefinition) {
	return {
		name: label.name,
		description: label.description ?? 'No description provided.',
		...(label.applyWhen ? { apply_when: label.applyWhen } : {}),
		...(label.removeWhen ? { remove_when: label.removeWhen } : {}),
		...(label.examples && label.examples.length > 0 ? { examples: label.examples } : {}),
		...(label.context ? { context: label.context } : {}),
	};
}

export function buildRequest(
	items: LabelItem[],
	labels: LabelDefinition[],
	context: AskContext = {}
) {
	const state = {
		policy: context.policy ?? null,
		prompt: context.prompt ?? null,
		items: items.map(itemState),
		labels: labels.map(labelState),
	};

	const questions: Record<string, NoulQuestion> = {};
	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		for (let labelIndex = 0; labelIndex < labels.length; labelIndex++) {
			const itemPath = `items[${itemIndex}]`;
			const labelPath = `labels[${labelIndex}]`;
			questions[questionId(itemIndex, labelIndex)] = noul(
				{
					question: `Should the GitHub label at \`${labelPath}\` be applied to \`${itemPath}\`?`,
					judge_from: `\`${itemPath}.title\`, \`${itemPath}.body\`, and \`${itemPath}.comments\` (the discussion between users). \`${itemPath}.type\` is issue or pull_request. Honor \`policy\` when present (repo labeling rules) and \`prompt\` when present (extra instructions for this run).`,
					label: `Use \`${labelPath}.name\` and \`${labelPath}.description\` as the meaning of the label. If \`${labelPath}.apply_when\` is present, require a match. If \`${labelPath}.remove_when\` is present, do not apply when it matches; remove the label if it is already on the item. If \`${labelPath}.examples\` is present, treat them as typical matches.`,
				},
				{
					true: 'The item matches this label and the label should be applied.',
					false: 'The item does not match this label.',
				}
			);
		}
	}

	return { state, questions };
}

export type ContextLabeledItem = {
	item: LabelItem;
	candidates: SimilarItem[];
};

export function candidateState(candidate: SimilarItem) {
	return {
		number: candidate.number,
		title: candidate.title,
		body: candidate.body,
		type: candidate.type,
	};
}

export function buildContextRequest(
	items: ContextLabeledItem[],
	labels: LabelDefinition[],
	context: AskContext = {}
) {
	const state = {
		policy: context.policy ?? null,
		prompt: context.prompt ?? null,
		items: items.map(({ item, candidates }) => ({
			...itemState(item),
			candidates: candidates.map(candidateState),
		})),
		labels: labels.map(labelState),
	};

	const questions: Record<string, NoulQuestion> = {};
	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		for (let labelIndex = 0; labelIndex < labels.length; labelIndex++) {
			const itemPath = `items[${itemIndex}]`;
			const labelPath = `labels[${labelIndex}]`;
			questions[questionId(itemIndex, labelIndex)] = noul(
				{
					question: `Should the GitHub label at \`${labelPath}\` be applied to \`${itemPath}\`?`,
					judge_from: `\`${itemPath}.title\`, \`${itemPath}.body\`, \`${itemPath}.comments\`, and \`${itemPath}.candidates\` (other issues or pull requests that may already cover this report). \`${itemPath}.type\` is issue or pull_request. Honor \`policy\` when present (repo labeling rules) and \`prompt\` when present (extra instructions for this run).`,
					label: `Use \`${labelPath}.name\` and \`${labelPath}.description\` as the meaning of the label. If \`${labelPath}.apply_when\` is present, require a match. If \`${labelPath}.remove_when\` is present, do not apply when it matches; remove the label if it is already on the item. If \`${labelPath}.examples\` is present, treat them as typical matches. Apply when comments already identify a matching existing item, or when a candidate is the same report (or otherwise matches the label). If \`${itemPath}.candidates\` is empty, rely on the item and its comments only.`,
				},
				{
					true: 'The item matches this label and the label should be applied.',
					false: 'The item does not match this label.',
				}
			);
		}
	}

	return { state, questions };
}

export function chunkItems(
	items: LabelItem[],
	labels: LabelDefinition[],
	context: AskContext = {}
): LabelItem[][] {
	return chunkWhile(items, (chunk) => fitsBudget(buildRequest(chunk, labels, context)));
}

export function chunkContextItems(
	items: ContextLabeledItem[],
	labels: LabelDefinition[],
	context: AskContext = {}
): ContextLabeledItem[][] {
	return chunkWhile(items, (chunk) => fitsBudget(buildContextRequest(chunk, labels, context)));
}

function chunkWhile<T>(items: T[], fits: (chunk: T[]) => boolean): T[][] {
	if (items.length === 0) return [];

	const chunks: T[][] = [];
	let current: T[] = [];

	for (const item of items) {
		const next = [...current, item];
		if (current.length > 0 && !fits(next)) {
			chunks.push(current);
			current = [item];
		} else {
			current = next;
		}
	}

	if (current.length > 0) chunks.push(current);
	return chunks;
}

function fitsBudget(request: { state: unknown; questions: unknown }): boolean {
	return JSON.stringify(request).length <= REQUEST_CHAR_BUDGET;
}

export function collectDecisions(
	items: LabelItem[],
	labels: LabelDefinition[],
	answers: Record<string, { noul: number }>,
	threshold: number
): LabelDecision[] {
	return items.map((item, itemIndex) => {
		const judgments = labels.map((label, labelIndex) => {
			const noulValue = answers[questionId(itemIndex, labelIndex)]?.noul ?? 0;
			const labelThreshold = label.threshold ?? threshold;
			return {
				name: label.name,
				description: label.description,
				color: label.color,
				noul: noulValue,
				threshold: labelThreshold,
				apply: noulValue >= labelThreshold,
				auto: label.auto !== false,
				remove: label.remove !== false,
			};
		});

		return {
			item,
			labels: judgments,
			chosen: judgments.filter((judgment) => judgment.apply).map((judgment) => judgment.name),
		};
	});
}

export function labelsToApply(decision: LabelDecision): string[] {
	const existing = new Set(decision.item.currentLabels.map((name) => name.toLowerCase()));
	return decision.labels
		.filter((label) => label.apply && label.auto && !existing.has(label.name.toLowerCase()))
		.map((label) => label.name);
}

/** Remove only when noul is below `1 - threshold` so near-threshold scores do not flap. */
export function labelsToRemove(decision: LabelDecision): string[] {
	const existing = new Set(decision.item.currentLabels.map((name) => name.toLowerCase()));
	return decision.labels
		.filter(
			(label) =>
				existing.has(label.name.toLowerCase()) &&
				label.auto &&
				label.remove &&
				!label.apply &&
				label.noul < 1 - label.threshold
		)
		.map((label) => label.name);
}

export async function askLabels(
	items: LabelItem[],
	labels: LabelDefinition[],
	options: {
		threshold: number;
		policy?: string;
		prompt?: string;
		client?: TypeSafeClient;
		ask?: AskSystemOne;
	}
): Promise<Result<LabelDecision[], MissingTypeSafeApiKeyError | TypeSafeRequestError>> {
	if (items.length === 0) return ok([]);
	if (labels.length === 0) {
		return ok(items.map((item) => ({ item, labels: [], chosen: [] })));
	}

	const askResult = resolveAsk(options);
	if (askResult.isErr()) return err(askResult.error);
	const ask = askResult.value;
	const context = { policy: options.policy, prompt: options.prompt };

	const chunks = chunkItems(items, labels, context);
	try {
		const nested = await Promise.all(
			chunks.map(async (chunk) => {
				const request = buildRequest(chunk, labels, context);
				const response = await ask(request);
				return collectDecisions(chunk, labels, response.answers, options.threshold);
			})
		);
		return ok(nested.flat());
	} catch (error) {
		return err(new TypeSafeRequestError(error));
	}
}

export async function askContextLabels(
	items: ContextLabeledItem[],
	labels: LabelDefinition[],
	options: {
		threshold: number;
		policy?: string;
		prompt?: string;
		client?: TypeSafeClient;
		ask?: AskSystemOne;
	}
): Promise<Result<LabelDecision[], MissingTypeSafeApiKeyError | TypeSafeRequestError>> {
	if (items.length === 0) return ok([]);
	if (labels.length === 0) {
		return ok(items.map(({ item }) => ({ item, labels: [], chosen: [] })));
	}

	const askResult = resolveAsk(options);
	if (askResult.isErr()) return err(askResult.error);
	const ask = askResult.value;
	const context = { policy: options.policy, prompt: options.prompt };

	const chunks = chunkContextItems(items, labels, context);
	try {
		const nested = await Promise.all(
			chunks.map(async (chunk) => {
				const request = buildContextRequest(chunk, labels, context);
				const response = await ask(request);
				return collectDecisions(
					chunk.map(({ item }) => item),
					labels,
					response.answers,
					options.threshold
				);
			})
		);
		return ok(nested.flat());
	} catch (error) {
		return err(new TypeSafeRequestError(error));
	}
}

export function mergeDecisions(base: LabelDecision[], extra: LabelDecision[]): LabelDecision[] {
	const extraByNumber = new Map(extra.map((decision) => [decision.item.number, decision]));
	return base.map((decision) => {
		const more = extraByNumber.get(decision.item.number);
		if (!more) return decision;
		const labels = [...decision.labels, ...more.labels];
		return {
			item: decision.item,
			labels,
			chosen: labels.filter((label) => label.apply).map((label) => label.name),
		};
	});
}

function resolveAsk(options: {
	client?: TypeSafeClient;
	ask?: AskSystemOne;
}): Result<AskSystemOne, MissingTypeSafeApiKeyError> {
	if (options.ask) return ok(options.ask);
	if (options.client) return ok(createAsk(options.client));
	try {
		return ok(createAsk(new TypeSafeClient({ timeout: TYPESAFE_TIMEOUT_MS })));
	} catch {
		return err(new MissingTypeSafeApiKeyError());
	}
}

export function createAsk(client: TypeSafeClient): AskSystemOne {
	return async ({ state, questions }) => {
		const response = await client.systemOne({ state, questions });
		const answers: Record<string, { noul: number }> = {};
		for (const [key, answer] of Object.entries(response.answers)) {
			if (answer && typeof answer === 'object' && 'noul' in answer) {
				answers[key] = { noul: answer.noul };
			}
		}
		return { answers };
	};
}

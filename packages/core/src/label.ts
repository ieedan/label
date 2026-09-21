import type { TypeSafeClient } from '@typesafe-ai/sdk';
import { err, ok, type Result } from 'nevereverthrow';
import { type LabelError, NoIssuesFoundError, WrongItemKindError } from './errors';
import { detectRepo } from './git';
import {
	addIssueLabels,
	type GitHubClientOptions,
	type GitHubRepo,
	getIssue,
	githubToken,
	type IssueSelection,
	type ItemKind,
	type LabelItem,
	listIssues,
	listItemConversation,
	listRepoLabels,
	parseGitHubPayload,
	parseRepo,
	removeIssueLabels,
	resolveIssueSelection,
	resolveItemKind,
	type SimilarItem,
	searchSimilarItems,
} from './github';
import {
	type AskSystemOne,
	askContextLabels,
	askLabels,
	DEFAULT_LABEL_THRESHOLD,
	type LabelDecision,
	labelsToApply,
	labelsToRemove,
	mergeDecisions,
} from './jev';
import {
	type LabelDefinition,
	type LabelPolicy,
	mergeLabelPolicy,
	readLabelPolicy,
} from './policy';

export type LabelOptions = {
	payload: unknown | unknown[];
	labels: LabelDefinition[];
	threshold?: number;
	prompt?: string;
	client?: TypeSafeClient;
	ask?: AskSystemOne;
	repo?: string | GitHubRepo;
	token?: string;
	fetch?: typeof fetch;
};

export type LabelResult = {
	decisions: LabelDecision[];
};

export type LabelIssuesOptions = {
	/** The repository to label. Detected from the git remotes at `cwd` when omitted. */
	repo?: string;
	numbers?: string[] | number[];
	all?: boolean;
	top?: boolean | number | string;
	includeClosed?: boolean;
	issues?: boolean;
	prs?: boolean;
	dryRun?: boolean;
	remove?: boolean;
	token?: string;
	threshold?: number;
	policy?: LabelPolicy;
	prompt?: string;
	cwd?: string;
	config?: string;
	client?: TypeSafeClient;
	ask?: AskSystemOne;
	fetch?: typeof fetch;
};

export type LabelIssuesResult = {
	repo: string;
	dryRun: boolean;
	decisions: LabelDecision[];
};

export async function label(options: LabelOptions): Promise<Result<LabelResult, LabelError>> {
	const payloads = Array.isArray(options.payload) ? options.payload : [options.payload];
	const items: LabelItem[] = [];

	for (const payload of payloads) {
		const parsed = parseGitHubPayload(payload);
		if (parsed.isErr()) return err(parsed.error);
		items.push(parsed.value);
	}

	const askOptions = {
		threshold: options.threshold ?? DEFAULT_LABEL_THRESHOLD,
		prompt: options.prompt,
		client: options.client,
		ask: options.ask,
	};

	const localLabels = options.labels.filter((label) => label.context !== 'similar_issues');
	const similarLabels = options.labels.filter((label) => label.context === 'similar_issues');

	const localDecisions = await askLabels(items, localLabels, askOptions);
	if (localDecisions.isErr()) return err(localDecisions.error);

	if (similarLabels.length === 0) {
		return ok({ decisions: localDecisions.value });
	}

	const withCandidates = await loadSimilarCandidates(items, {
		repo: options.repo,
		token: options.token,
		fetch: options.fetch,
	});
	if (withCandidates.isErr()) return err(withCandidates.error);

	const contextDecisions = await askContextLabels(
		withCandidates.value,
		similarLabels,
		askOptions
	);
	if (contextDecisions.isErr()) return err(contextDecisions.error);

	return ok({ decisions: mergeDecisions(localDecisions.value, contextDecisions.value) });
}

export async function labelIssues(
	options: LabelIssuesOptions
): Promise<Result<LabelIssuesResult, LabelError>> {
	const repoResult = await resolveRepo(options.repo, options.cwd);
	if (repoResult.isErr()) return err(repoResult.error);
	const repo = repoResult.value;
	const repoName = `${repo.owner}/${repo.name}`;

	const selection = resolveIssueSelection({
		numbers: options.numbers,
		all: options.all,
		top: options.top,
	});
	if (selection.isErr()) return err(selection.error);
	const kind = resolveItemKind({ issues: options.issues, prs: options.prs });

	const github = {
		token: options.token ?? githubToken(),
		fetch: options.fetch,
	};

	const labelsResult = await listRepoLabels(repo, github);
	if (labelsResult.isErr()) return err(labelsResult.error);

	const emptyPolicy: LabelPolicy = { labels: {} };
	const policyResult =
		options.policy !== undefined
			? ok(options.policy)
			: options.config || options.cwd
				? await readLabelPolicy(options.cwd ?? '.', options.config)
				: ok(emptyPolicy);
	if (policyResult.isErr()) return err(policyResult.error);

	const mergedLabels = mergeLabelPolicy(labelsResult.value, policyResult.value);
	if (mergedLabels.isErr()) return err(mergedLabels.error);

	const payloadsResult = await loadIssuePayloads(repo, repoName, selection.value, {
		includeClosed: options.includeClosed,
		kind,
		github,
	});
	if (payloadsResult.isErr()) return err(payloadsResult.error);

	const labeled = await label({
		payload: payloadsResult.value,
		labels: mergedLabels.value,
		threshold: options.threshold,
		prompt: joinPrompts(policyResult.value.prompt, options.prompt),
		client: options.client,
		ask: options.ask,
		repo,
		token: github.token,
		fetch: github.fetch,
	});
	if (labeled.isErr()) return err(labeled.error);

	const dryRun = options.dryRun ?? false;
	const remove = options.remove ?? false;
	if (!dryRun) {
		const applied = await Promise.all(
			labeled.value.decisions.map((decision) =>
				addIssueLabels(repo, decision.item.number, labelsToApply(decision), github)
			)
		);
		for (const result of applied) {
			if (result.isErr()) return err(result.error);
		}

		if (remove) {
			const removed = await Promise.all(
				labeled.value.decisions.map((decision) =>
					removeIssueLabels(repo, decision.item.number, labelsToRemove(decision), github)
				)
			);
			for (const result of removed) {
				if (result.isErr()) return err(result.error);
			}
		}
	}

	return ok({
		repo: repoName,
		dryRun,
		decisions: labeled.value.decisions,
	});
}

/**
 * Resolves the repository from the given reference, falling back to the git remotes at `cwd`.
 */
async function resolveRepo(
	repo: string | undefined,
	cwd: string | undefined
): Promise<Result<GitHubRepo, LabelError>> {
	if (repo !== undefined && repo.trim().length > 0) return parseRepo(repo);
	return detectRepo(cwd);
}

async function loadIssuePayloads(
	repo: GitHubRepo,
	repoName: string,
	selection: IssueSelection,
	options: {
		includeClosed?: boolean;
		kind: ItemKind;
		github: GitHubClientOptions;
	}
): Promise<Result<unknown[], LabelError>> {
	if (selection.type === 'numbers') {
		const issueResults = await Promise.all(
			selection.numbers.map((number) => getIssue(repo, number, options.github))
		);

		const payloads: unknown[] = [];
		for (const [index, result] of issueResults.entries()) {
			if (result.isErr()) return err(result.error);
			if (options.kind !== 'both') {
				const parsed = parseGitHubPayload(result.value, repoName);
				if (parsed.isErr()) return err(parsed.error);
				if (parsed.value.type !== options.kind) {
					return err(
						new WrongItemKindError(
							selection.numbers[index] ?? parsed.value.number,
							parsed.value.type,
							options.kind
						)
					);
				}
			}
			const payload = await toPayloadWithConversation(
				repo,
				repoName,
				result.value,
				options.github
			);
			if (payload.isErr()) return err(payload.error);
			payloads.push(payload.value);
		}
		return ok(payloads);
	}

	const listed = await listIssues(repo, {
		...options.github,
		includeClosed: options.includeClosed,
		kind: options.kind,
		limit: selection.type === 'top' ? selection.count : undefined,
	});
	if (listed.isErr()) return err(listed.error);
	if (listed.value.length === 0) return err(new NoIssuesFoundError());

	const payloads = await Promise.all(
		listed.value.map((issue) =>
			toPayloadWithConversation(repo, repoName, issue, options.github)
		)
	);
	const withConversation: unknown[] = [];
	for (const payload of payloads) {
		if (payload.isErr()) return err(payload.error);
		withConversation.push(payload.value);
	}
	return ok(withConversation);
}

async function toPayloadWithConversation(
	repo: GitHubRepo,
	repoName: string,
	issue: unknown,
	github: GitHubClientOptions
): Promise<Result<unknown, LabelError>> {
	const parsed = parseGitHubPayload(issue, repoName);
	if (parsed.isErr()) return err(parsed.error);
	const conversation = await listItemConversation(repo, parsed.value, github);
	if (conversation.isErr()) return err(conversation.error);
	return ok({
		issue,
		repository: { full_name: repoName },
		conversation: conversation.value,
	});
}

async function loadSimilarCandidates(
	items: LabelItem[],
	options: {
		repo?: string | GitHubRepo;
		token?: string;
		fetch?: typeof fetch;
	}
): Promise<Result<Array<{ item: LabelItem; candidates: SimilarItem[] }>, LabelError>> {
	const github: GitHubClientOptions = { token: options.token, fetch: options.fetch };
	const results: Array<{ item: LabelItem; candidates: SimilarItem[] }> = [];

	for (const item of items) {
		const repo = resolveSearchRepo(options.repo, item);
		if (!repo || !(options.token || options.fetch)) {
			results.push({ item, candidates: [] });
			continue;
		}

		const searched = await searchSimilarItems(repo, item, github);
		if (searched.isErr()) return err(searched.error);
		results.push({ item, candidates: searched.value });
	}

	return ok(results);
}

function resolveSearchRepo(
	repo: string | GitHubRepo | undefined,
	item: LabelItem
): GitHubRepo | undefined {
	if (repo && typeof repo === 'object') return repo;
	const raw = typeof repo === 'string' ? repo : item.repository;
	if (!raw) return undefined;
	const parsed = parseRepo(raw);
	return parsed.isOk() ? parsed.value : undefined;
}

function joinPrompts(...parts: (string | undefined)[]): string | undefined {
	const merged = parts
		.map((part) => part?.trim())
		.filter((part): part is string => Boolean(part))
		.join('\n\n');
	return merged.length > 0 ? merged : undefined;
}

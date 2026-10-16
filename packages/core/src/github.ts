import { err, ok, type Result } from 'nevereverthrow';
import { z } from 'zod';
import {
	ConflictingIssueSelectionError,
	GitHubApiError,
	InvalidIssueNumberError,
	InvalidPayloadError,
	InvalidRepoError,
	InvalidTopCountError,
	MissingGitHubTokenError,
	NoIssueNumbersError,
} from './errors';

export type RepoLabel = {
	name: string;
	description: string | null;
	color?: string;
};

export const AUTHOR_ROLES = [
	'OWNER',
	'MEMBER',
	'COLLABORATOR',
	'CONTRIBUTOR',
	'FIRST_TIME_CONTRIBUTOR',
	'FIRST_TIMER',
	'MANNEQUIN',
	'NONE',
] as const;

export type AuthorRole = (typeof AUTHOR_ROLES)[number];

export type ItemComment = {
	author: string | null;
	role: AuthorRole | null;
	body: string;
	createdAt: string | null;
	kind: 'comment' | 'review' | 'review_comment';
	id?: string;
	replyToId?: string;
	reviewState?: string;
	isBot?: boolean;
};

export type ReviewThread = {
	id: string;
	isResolved: boolean;
	isOutdated: boolean;
	resolvedBy: string | null;
	comments: ItemComment[];
	commentsOmitted: number;
};

export type ChangedFile = {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
	patch?: string;
	patchOmitted: boolean;
};

export type LabelItem = {
	type: 'issue' | 'pull_request';
	number: number;
	title: string;
	body: string | null;
	url?: string;
	author?: string;
	authorRole?: AuthorRole | null;
	currentLabels: string[];
	/** Labels whose latest human action was removal; used only to veto additions. */
	humanRemovedLabels?: string[];
	repository?: string;
	comments: ItemComment[];
	reviewThreads?: ReviewThread[];
	reviewThreadsOmitted?: boolean;
	files?: ChangedFile[];
	filesOmitted?: boolean;
};

export const MAX_CONVERSATION_COMMENTS = 25;
export const MAX_COMMENT_BODY_CHARS = 1000;
export const SIMILAR_ITEMS_LIMIT = 20;
export const MAX_CANDIDATE_BODY_CHARS = 800;

const SEARCH_STOPWORDS = new Set([
	'a',
	'an',
	'and',
	'are',
	'as',
	'at',
	'be',
	'by',
	'can',
	'do',
	'does',
	'for',
	'from',
	'if',
	'in',
	'into',
	'is',
	'it',
	'its',
	'not',
	'of',
	'on',
	'or',
	'that',
	'the',
	'this',
	'to',
	'was',
	'were',
	'with',
]);

export type GitHubRepo = {
	owner: string;
	name: string;
};

const labelRefSchema = z.union([
	z.string(),
	z
		.object({
			name: z.string(),
		})
		.passthrough(),
]);

const gitHubUserSchema = z
	.object({
		login: z.string(),
	})
	.passthrough();

const gitHubItemSchema = z
	.object({
		number: z.number(),
		title: z.string(),
		body: z.string().nullable().optional(),
		html_url: z.string().optional(),
		user: gitHubUserSchema.nullable().optional(),
		author_association: z.string().nullable().optional(),
		labels: z.array(labelRefSchema).optional(),
		pull_request: z.unknown().optional(),
	})
	.passthrough();

const gitHubRepositorySchema = z
	.object({
		full_name: z.string().optional(),
		name: z.string().optional(),
		owner: gitHubUserSchema.optional(),
	})
	.passthrough();

const conversationCommentSchema = z
	.object({
		author: z.string().nullable().optional(),
		role: z.string().nullable().optional(),
		author_association: z.string().nullable().optional(),
		body: z.string(),
		createdAt: z.string().nullable().optional(),
		kind: z.enum(['comment', 'review', 'review_comment']).optional(),
		id: z.string().optional(),
		replyToId: z.string().optional(),
		reviewState: z.string().optional(),
		isBot: z.boolean().optional(),
	})
	.passthrough();

const reviewThreadSchema = z.object({
	id: z.string(),
	isResolved: z.boolean(),
	isOutdated: z.boolean(),
	resolvedBy: z.string().nullable(),
	comments: z.array(conversationCommentSchema),
	commentsOmitted: z.number().int().nonnegative(),
});

const gitHubWebhookSchema = z
	.object({
		action: z.string().optional(),
		issue: gitHubItemSchema.optional(),
		pull_request: gitHubItemSchema.optional(),
		repository: gitHubRepositorySchema.optional(),
		conversation: z.array(conversationCommentSchema).optional(),
		human_removed_labels: z.array(z.string()).optional(),
		review_threads: z.array(reviewThreadSchema).optional(),
		review_threads_omitted: z.boolean().optional(),
		files: z
			.array(
				z.object({
					filename: z.string(),
					status: z.string(),
					additions: z.number(),
					deletions: z.number(),
					patch: z.string().optional(),
					patchOmitted: z.boolean(),
				})
			)
			.optional(),
		files_omitted: z.boolean().optional(),
	})
	.passthrough();

export function githubToken(env: NodeJS.Dict<string> = process.env): string | undefined {
	return env.GITHUB_TOKEN ?? env.GH_TOKEN;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/** `git@github.com:owner/name.git` and other scp-like remote URLs. */
const SCP_LIKE = /^(?:[^@/]+@)?([^/:]+):(.+)$/;

/**
 * Parses a repository reference into its owner and name.
 *
 * Accepts `owner/name` as well as the remote URL formats git writes, for example
 * `https://github.com/owner/name.git` and `git@github.com:owner/name.git`.
 */
export function parseRepo(repo: string): Result<GitHubRepo, InvalidRepoError> {
	const trimmed = repo
		.trim()
		.replace(/^git\+/, '')
		.replace(/\/+$/, '');

	let host: string | undefined;
	let path = trimmed;

	const scheme = SCHEME.exec(trimmed);
	if (scheme) {
		const withoutScheme = trimmed.slice(scheme[0].length).replace(/^[^@/]*@/, '');
		const separator = withoutScheme.indexOf('/');
		if (separator === -1) return err(new InvalidRepoError(repo));
		host = withoutScheme.slice(0, separator);
		path = withoutScheme.slice(separator + 1);
	} else {
		const scp = SCP_LIKE.exec(trimmed);
		if (scp?.[1] !== undefined && scp[2] !== undefined) {
			host = scp[1];
			path = scp[2];
		}
	}

	if (host !== undefined && normalizeHost(host) !== 'github.com') {
		return err(new InvalidRepoError(repo));
	}

	const segments = path
		.replace(/\.git$/i, '')
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
		.split('/');
	const [owner, name] = segments;

	if (!owner || !name || segments.length !== 2) {
		return err(new InvalidRepoError(repo));
	}

	return ok({ owner, name });
}

function normalizeHost(host: string): string {
	return host
		.toLowerCase()
		.replace(/:\d+$/, '')
		.replace(/^www\./, '');
}

export function parseIssueNumbers(
	raw: string[]
): Result<number[], InvalidIssueNumberError | NoIssueNumbersError> {
	const numbers: number[] = [];

	for (const value of raw) {
		for (const part of value.split(',')) {
			const normalized = part.trim().replace(/^#/, '');
			if (normalized.length === 0) continue;
			const number = Number.parseInt(normalized, 10);
			if (!Number.isInteger(number) || number <= 0 || String(number) !== normalized) {
				return err(new InvalidIssueNumberError(part.trim()));
			}
			if (!numbers.includes(number)) numbers.push(number);
		}
	}

	if (numbers.length === 0) return err(new NoIssueNumbersError());
	return ok(numbers);
}

export const DEFAULT_TOP_ISSUES = 10;

export type IssueSelection =
	| { type: 'numbers'; numbers: number[] }
	| { type: 'all' }
	| { type: 'top'; count: number };

export function resolveIssueSelection(options: {
	numbers?: (string | number)[];
	all?: boolean;
	top?: boolean | number | string;
}): Result<
	IssueSelection,
	| ConflictingIssueSelectionError
	| InvalidIssueNumberError
	| InvalidTopCountError
	| NoIssueNumbersError
> {
	const numbers = (options.numbers ?? []).map(String).filter((value) => value.length > 0);
	const hasNumbers = numbers.length > 0;
	const topResult = parseTopCount(options.top);
	if (topResult.isErr()) return err(topResult.error);
	const top = topResult.value;
	const hasAll = options.all === true;

	if ([hasNumbers, hasAll, top !== undefined].filter(Boolean).length > 1) {
		return err(new ConflictingIssueSelectionError());
	}

	if (hasAll) return ok({ type: 'all' });
	if (top !== undefined) return ok({ type: 'top', count: top });

	const numbersResult = parseIssueNumbers(numbers);
	if (numbersResult.isErr()) return err(numbersResult.error);
	return ok({ type: 'numbers', numbers: numbersResult.value });
}

export function parseTopCount(
	top: boolean | number | string | undefined
): Result<number | undefined, InvalidTopCountError> {
	if (top === undefined || top === false) return ok(undefined);
	if (top === true) return ok(DEFAULT_TOP_ISSUES);

	const value = typeof top === 'number' ? top : Number.parseInt(top, 10);
	if (!Number.isInteger(value) || value <= 0) {
		return err(new InvalidTopCountError(String(top)));
	}

	return ok(value);
}

export type ItemKind = 'issue' | 'pull_request' | 'both';

export function resolveItemKind(options: { issues?: boolean; prs?: boolean }): ItemKind {
	if (options.issues && !options.prs) return 'issue';
	if (options.prs && !options.issues) return 'pull_request';
	return 'both';
}

export function itemIsPullRequest(item: unknown): boolean {
	return typeof item === 'object' && item !== null && 'pull_request' in item;
}

export function matchesItemKind(item: unknown, kind: ItemKind): boolean {
	if (kind === 'both') return true;
	const isPr = itemIsPullRequest(item);
	return kind === 'pull_request' ? isPr : !isPr;
}

export function parseGitHubPayload(
	input: unknown,
	fallbackRepo?: string
): Result<LabelItem, InvalidPayloadError> {
	const webhook = gitHubWebhookSchema.safeParse(input);
	if (webhook.success && (webhook.data.pull_request || webhook.data.issue)) {
		const rawItem = webhook.data.pull_request ?? webhook.data.issue;
		if (!rawItem) return err(new InvalidPayloadError());
		const type = webhook.data.pull_request
			? 'pull_request'
			: rawItem.pull_request !== undefined
				? 'pull_request'
				: 'issue';
		return ok({
			...(webhook.data.files
				? { files: webhook.data.files, filesOmitted: webhook.data.files_omitted ?? false }
				: {}),
			...toLabelItem(
				rawItem,
				type,
				repositoryName(webhook.data.repository) ?? fallbackRepo,
				(webhook.data.conversation ?? []).map(toStoredComment)
			),
			...(webhook.data.human_removed_labels
				? { humanRemovedLabels: webhook.data.human_removed_labels }
				: {}),
			...(webhook.data.review_threads
				? {
						reviewThreads: webhook.data.review_threads.map((thread) => ({
							...thread,
							comments: thread.comments.map(toStoredComment),
						})),
					}
				: {}),
			...(webhook.data.review_threads_omitted !== undefined
				? { reviewThreadsOmitted: webhook.data.review_threads_omitted }
				: {}),
		});
	}

	const item = gitHubItemSchema.safeParse(input);
	if (item.success) {
		const type = item.data.pull_request !== undefined ? 'pull_request' : 'issue';
		return ok(toLabelItem(item.data, type, fallbackRepo, []));
	}

	return err(new InvalidPayloadError());
}

function repositoryName(
	repository: z.infer<typeof gitHubRepositorySchema> | undefined
): string | undefined {
	if (repository?.full_name) return repository.full_name;
	if (repository?.owner?.login && repository.name) {
		return `${repository.owner.login}/${repository.name}`;
	}
	return undefined;
}

function toStoredComment(comment: z.infer<typeof conversationCommentSchema>): ItemComment {
	return {
		author: comment.author ?? null,
		role: parseAuthorRole(comment.role ?? comment.author_association),
		body: comment.body,
		createdAt: comment.createdAt ?? null,
		kind: comment.kind ?? 'comment',
		...(comment.id ? { id: comment.id } : {}),
		...(comment.replyToId ? { replyToId: comment.replyToId } : {}),
		...(comment.reviewState ? { reviewState: comment.reviewState } : {}),
		...(comment.isBot !== undefined ? { isBot: comment.isBot } : {}),
	};
}

function toLabelItem(
	raw: z.infer<typeof gitHubItemSchema>,
	type: LabelItem['type'],
	repository: string | undefined,
	comments: ItemComment[]
): LabelItem {
	return {
		type,
		number: raw.number,
		title: raw.title,
		body: raw.body ?? null,
		url: raw.html_url,
		author: raw.user?.login,
		authorRole: parseAuthorRole(raw.author_association),
		currentLabels: (raw.labels ?? []).map((label) =>
			typeof label === 'string' ? label : label.name
		),
		repository,
		comments,
	};
}

export type GitHubClientOptions = {
	token?: string;
	fetch?: typeof fetch;
};

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

export async function listRepoLabels(
	repo: GitHubRepo,
	options: GitHubClientOptions = {}
): Promise<Result<RepoLabel[], GitHubApiError | MissingGitHubTokenError>> {
	const tokenResult = requireToken(options.token);
	if (tokenResult.isErr()) return err(tokenResult.error);

	const labels: RepoLabel[] = [];
	for (let page = 1; ; page++) {
		const result = await githubJson<
			Array<{ name: string; description: string | null; color?: string }>
		>(`/repos/${repo.owner}/${repo.name}/labels?per_page=100&page=${page}`, {
			token: tokenResult.value,
			fetch: options.fetch,
		});
		if (result.isErr()) return err(result.error);
		labels.push(
			...result.value.map((label) => ({
				name: label.name,
				description: label.description,
				color: label.color,
			}))
		);
		if (result.value.length < 100) break;
	}

	return ok(labels);
}

export async function getIssue(
	repo: GitHubRepo,
	number: number,
	options: GitHubClientOptions = {}
): Promise<Result<unknown, GitHubApiError | MissingGitHubTokenError>> {
	const tokenResult = requireToken(options.token);
	if (tokenResult.isErr()) return err(tokenResult.error);

	return githubJson(`/repos/${repo.owner}/${repo.name}/issues/${number}`, {
		token: tokenResult.value,
		fetch: options.fetch,
	});
}

export async function listIssues(
	repo: GitHubRepo,
	options: GitHubClientOptions & {
		includeClosed?: boolean;
		limit?: number;
		kind?: ItemKind;
	} = {}
): Promise<Result<unknown[], GitHubApiError | MissingGitHubTokenError>> {
	const tokenResult = requireToken(options.token);
	if (tokenResult.isErr()) return err(tokenResult.error);

	const issues: unknown[] = [];
	const kind = options.kind ?? 'both';
	const perPage = 100;

	for (let page = 1; ; page++) {
		const params = new URLSearchParams({
			state: options.includeClosed ? 'all' : 'open',
			sort: 'updated',
			direction: 'desc',
			per_page: String(perPage),
			page: String(page),
		});
		const result = await githubJson<unknown[]>(
			`/repos/${repo.owner}/${repo.name}/issues?${params}`,
			{ token: tokenResult.value, fetch: options.fetch }
		);
		if (result.isErr()) return err(result.error);

		for (const item of result.value) {
			if (!matchesItemKind(item, kind)) continue;
			issues.push(item);
			if (options.limit !== undefined && issues.length >= options.limit) {
				return ok(issues);
			}
		}
		if (result.value.length < perPage) break;
	}

	return ok(issues);
}

export type SimilarItem = {
	number: number;
	title: string;
	body: string;
	type: 'issue' | 'pull_request';
};

export function similarSearchQuery(
	repo: GitHubRepo,
	item: Pick<LabelItem, 'title' | 'type'>
): string | undefined {
	const keywords = [
		...new Set(
			item.title
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((word) => word.length >= 3 && !SEARCH_STOPWORDS.has(word))
		),
	].slice(0, 8);
	if (keywords.length === 0) return undefined;

	const kind = item.type === 'pull_request' ? 'is:pr' : 'is:issue';
	return `${keywords.join(' ')} repo:${repo.owner}/${repo.name} ${kind}`;
}

export async function searchSimilarItems(
	repo: GitHubRepo,
	item: Pick<LabelItem, 'number' | 'title' | 'type'>,
	options: GitHubClientOptions & { limit?: number } = {}
): Promise<Result<SimilarItem[], GitHubApiError | MissingGitHubTokenError>> {
	const query = similarSearchQuery(repo, item);
	if (!query) return ok([]);

	const tokenResult = requireToken(options.token);
	if (tokenResult.isErr()) return err(tokenResult.error);

	const limit = options.limit ?? SIMILAR_ITEMS_LIMIT;
	const params = new URLSearchParams({
		q: query,
		per_page: String(Math.min(100, limit + 5)),
	});
	const result = await githubJson<{
		items?: Array<{
			number: number;
			title: string;
			body?: string | null;
			pull_request?: unknown;
		}>;
	}>(`/search/issues?${params}`, {
		token: tokenResult.value,
		fetch: options.fetch,
	});
	if (result.isErr()) return err(result.error);

	const candidates: SimilarItem[] = [];
	for (const match of result.value.items ?? []) {
		if (match.number === item.number) continue;
		candidates.push({
			number: match.number,
			title: match.title,
			body: truncateText(match.body ?? '', MAX_CANDIDATE_BODY_CHARS),
			type: match.pull_request !== undefined ? 'pull_request' : 'issue',
		});
		if (candidates.length >= limit) break;
	}

	return ok(candidates);
}

export async function listItemConversation(
	repo: GitHubRepo,
	item: Pick<LabelItem, 'number' | 'type'>,
	options: GitHubClientOptions = {}
): Promise<Result<ItemComment[], GitHubApiError | MissingGitHubTokenError>> {
	const commentsResult = await listPaginated<GitHubComment>(
		`/repos/${repo.owner}/${repo.name}/issues/${item.number}/comments`,
		options
	);
	if (commentsResult.isErr()) return err(commentsResult.error);

	const comments = commentsResult.value
		.map((comment) => toFetchedComment(comment, 'comment'))
		.filter((comment): comment is ItemComment => comment !== null);

	if (item.type === 'pull_request') {
		const reviewCommentsResult = await listPaginated<GitHubComment>(
			`/repos/${repo.owner}/${repo.name}/pulls/${item.number}/comments`,
			options
		);
		if (reviewCommentsResult.isErr()) return err(reviewCommentsResult.error);
		comments.push(
			...reviewCommentsResult.value
				.map((comment) => toFetchedComment(comment, 'review_comment'))
				.filter((comment): comment is ItemComment => comment !== null)
		);

		const reviewsResult = await listPaginated<GitHubReview>(
			`/repos/${repo.owner}/${repo.name}/pulls/${item.number}/reviews`,
			options
		);
		if (reviewsResult.isErr()) return err(reviewsResult.error);
		comments.push(
			...reviewsResult.value
				.filter((review) => review.state !== 'PENDING')
				.map((review) => toFetchedComment(review, 'review'))
				.filter((comment): comment is ItemComment => comment !== null)
		);
	}

	comments.sort(compareComments);
	return ok(comments.slice(-MAX_CONVERSATION_COMMENTS));
}

type GitHubComment = {
	user?: { login?: string; type?: string } | null;
	id?: number;
	in_reply_to_id?: number;
	author_association?: string | null;
	body?: string | null;
	created_at?: string;
};

export function parseAuthorRole(value: unknown): AuthorRole | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toUpperCase().replace(/-/g, '_');
	return (AUTHOR_ROLES as readonly string[]).includes(normalized)
		? (normalized as AuthorRole)
		: null;
}

type GitHubReview = GitHubComment & {
	state?: string;
	submitted_at?: string;
};

function toFetchedComment(raw: GitHubComment, kind: ItemComment['kind']): ItemComment | null {
	const body = truncateCommentBody(raw.body ?? '');
	const reviewState = kind === 'review' ? (raw as GitHubReview).state : undefined;
	if (body.length === 0 && !reviewState) return null;
	return {
		author: raw.user?.login ?? null,
		role: parseAuthorRole(raw.author_association),
		body,
		createdAt:
			kind === 'review'
				? ((raw as GitHubReview).submitted_at ?? raw.created_at ?? null)
				: (raw.created_at ?? null),
		kind,
		isBot: raw.user?.type === 'Bot' || (raw.user?.login?.endsWith('[bot]') ?? false),
		...(raw.id !== undefined ? { id: String(raw.id) } : {}),
		...(raw.in_reply_to_id !== undefined ? { replyToId: String(raw.in_reply_to_id) } : {}),
		...(reviewState ? { reviewState } : {}),
	};
}

type LabelEvent = {
	id?: number;
	event?: string;
	label?: { name?: string };
	actor?: { type?: string } | null;
	created_at?: string;
};

/** Later human additions lift the veto; bot actions never override a human removal. */
export function humanRemovedLabels(events: LabelEvent[]): string[] {
	const removed = new Map<string, string>();
	const chronological = [...events].sort(
		(a, b) =>
			(a.created_at ?? '').localeCompare(b.created_at ?? '') || (a.id ?? 0) - (b.id ?? 0)
	);
	for (const event of chronological) {
		if (event.actor?.type !== 'User' || !event.label?.name) continue;
		const name = event.label.name;
		if (event.event === 'unlabeled') removed.set(name.toLowerCase(), name);
		else if (event.event === 'labeled') removed.delete(name.toLowerCase());
	}
	return [...removed.values()];
}

export async function listHumanRemovedLabels(
	repo: GitHubRepo,
	number: number,
	options: GitHubClientOptions = {}
): Promise<Result<string[], GitHubApiError | MissingGitHubTokenError>> {
	const events = await listPaginated<LabelEvent>(
		`/repos/${repo.owner}/${repo.name}/issues/${number}/events`,
		options
	);
	return events.isErr() ? err(events.error) : ok(humanRemovedLabels(events.value));
}

function truncateCommentBody(body: string): string {
	return truncateText(body, MAX_COMMENT_BODY_CHARS);
}

function truncateText(body: string, maxChars: number): string {
	const collapsed = body.replace(/\s+/g, ' ').trim();
	if (collapsed.length <= maxChars) return collapsed;
	return `${collapsed.slice(0, maxChars - 1)}…`;
}

function compareComments(left: ItemComment, right: ItemComment): number {
	if (left.createdAt === right.createdAt) return 0;
	if (left.createdAt === null) return 1;
	if (right.createdAt === null) return -1;
	return left.createdAt.localeCompare(right.createdAt);
}

async function listPaginated<T>(
	path: string,
	options: GitHubClientOptions
): Promise<Result<T[], GitHubApiError | MissingGitHubTokenError>> {
	const tokenResult = requireToken(options.token);
	if (tokenResult.isErr()) return err(tokenResult.error);

	const items: T[] = [];
	for (let page = 1; ; page++) {
		const result = await githubJson<T[]>(`${path}?per_page=100&page=${page}`, {
			token: tokenResult.value,
			fetch: options.fetch,
		});
		if (result.isErr()) return err(result.error);
		items.push(...result.value);
		if (result.value.length < 100) break;
	}
	return ok(items);
}

export async function addIssueLabels(
	repo: GitHubRepo,
	number: number,
	labels: string[],
	options: GitHubClientOptions = {}
): Promise<Result<void, GitHubApiError | MissingGitHubTokenError>> {
	if (labels.length === 0) return ok(undefined);

	const tokenResult = requireToken(options.token);
	if (tokenResult.isErr()) return err(tokenResult.error);

	const result = await githubJson(`/repos/${repo.owner}/${repo.name}/issues/${number}/labels`, {
		token: tokenResult.value,
		fetch: options.fetch,
		method: 'POST',
		body: JSON.stringify({ labels }),
	});
	if (result.isErr()) return err(result.error);
	return ok(undefined);
}

export async function removeIssueLabels(
	repo: GitHubRepo,
	number: number,
	labels: string[],
	options: GitHubClientOptions = {}
): Promise<Result<void, GitHubApiError | MissingGitHubTokenError>> {
	if (labels.length === 0) return ok(undefined);

	const tokenResult = requireToken(options.token);
	if (tokenResult.isErr()) return err(tokenResult.error);

	const results = await Promise.all(
		labels.map((label) =>
			githubJson(
				`/repos/${repo.owner}/${repo.name}/issues/${number}/labels/${encodeURIComponent(label)}`,
				{
					token: tokenResult.value,
					fetch: options.fetch,
					method: 'DELETE',
				}
			)
		)
	);
	for (const result of results) {
		if (result.isErr()) return err(result.error);
	}
	return ok(undefined);
}

function requireToken(token: string | undefined): Result<string, MissingGitHubTokenError> {
	const resolved = token ?? githubToken();
	if (!resolved) return err(new MissingGitHubTokenError());
	return ok(resolved);
}

async function githubJson<T>(
	path: string,
	options: {
		token: string;
		fetch?: typeof fetch;
		method?: string;
		body?: string;
	}
): Promise<Result<T, GitHubApiError>> {
	const fetchFn = options.fetch ?? fetch;
	const response = await fetchFn(`${GITHUB_API}${path}`, {
		method: options.method ?? 'GET',
		headers: {
			Accept: 'application/vnd.github+json',
			Authorization: `Bearer ${options.token}`,
			'X-GitHub-Api-Version': GITHUB_API_VERSION,
			'User-Agent': 'label',
			...(options.body ? { 'Content-Type': 'application/json' } : {}),
		},
		body: options.body,
	});

	const text = await response.text();
	if (!response.ok) {
		return err(new GitHubApiError(response.status, text.slice(0, 200)));
	}

	return ok((text.length === 0 ? undefined : JSON.parse(text)) as T);
}

/** Bound thread context: the latest 20 threads, their root request and latest 3 replies. */
export const REVIEW_THREADS_QUERY = `query ReviewContext($owner:String!,$name:String!,$number:Int!) {
 repository(owner:$owner,name:$name) { pullRequest(number:$number) {
  reviewThreads(last:20) { pageInfo { hasPreviousPage } nodes {
   id isResolved isOutdated resolvedBy { login }
   root:comments(first:1) { nodes { ...ThreadComment } }
   recent:comments(last:3) { totalCount nodes { ...ThreadComment } }
  } }
 } }
}
fragment ThreadComment on PullRequestReviewComment {
 id body createdAt authorAssociation author { login __typename }
 replyTo { id } pullRequestReview { state }
}`;

type ThreadComment = {
	id: string;
	body: string;
	createdAt: string;
	authorAssociation?: string;
	author?: { login?: string; __typename?: string } | null;
	replyTo?: { id: string } | null;
	pullRequestReview?: { state: string } | null;
};
type ThreadResponse = {
	errors?: unknown[];
	data?: {
		repository?: {
			pullRequest?: {
				reviewThreads: {
					pageInfo: { hasPreviousPage: boolean };
					nodes: Array<{
						id: string;
						isResolved: boolean;
						isOutdated: boolean;
						resolvedBy?: { login: string } | null;
						root: { nodes: ThreadComment[] };
						recent: { totalCount: number; nodes: ThreadComment[] };
					}>;
				};
			} | null;
		} | null;
	};
};

export async function listReviewThreads(
	repo: GitHubRepo,
	number: number,
	options: GitHubClientOptions = {}
): Promise<
	Result<{ threads: ReviewThread[]; omitted: boolean }, GitHubApiError | MissingGitHubTokenError>
> {
	const token = requireToken(options.token);
	if (token.isErr()) return err(token.error);
	const result = await githubJson<ThreadResponse>('/graphql', {
		token: token.value,
		fetch: options.fetch,
		method: 'POST',
		body: JSON.stringify({
			query: REVIEW_THREADS_QUERY,
			variables: { owner: repo.owner, name: repo.name, number },
		}),
	});
	if (result.isErr()) return err(result.error);
	const connection = result.value.data?.repository?.pullRequest?.reviewThreads;
	if (result.value.errors?.length || !connection)
		return err(new GitHubApiError(200, 'Unable to load review-thread context.'));
	return ok({
		omitted: connection.pageInfo.hasPreviousPage,
		threads: connection.nodes.map((thread) => {
			const unique = new Map(
				[...thread.root.nodes, ...thread.recent.nodes]
					.filter((c) => c.pullRequestReview?.state !== 'PENDING')
					.map((c) => [c.id, c])
			);
			const comments = [...unique.values()].map((c) => ({
				id: c.id,
				author: c.author?.login ?? null,
				role: parseAuthorRole(c.authorAssociation),
				body: truncateText(c.body, 500),
				createdAt: c.createdAt,
				kind: 'review_comment' as const,
				isBot:
					c.author?.__typename === 'Bot' || (c.author?.login?.endsWith('[bot]') ?? false),
				...(c.replyTo ? { replyToId: c.replyTo.id } : {}),
				...(c.pullRequestReview ? { reviewState: c.pullRequestReview.state } : {}),
			}));
			return {
				id: thread.id,
				isResolved: thread.isResolved,
				isOutdated: thread.isOutdated,
				resolvedBy: thread.resolvedBy?.login ?? null,
				comments,
				commentsOmitted: Math.max(0, thread.recent.totalCount - comments.length),
			};
		}),
	});
}

/** Bounded, repository-independent evidence; omitted diffs are not evidence of no change. */
export async function listChangedFiles(
	repo: GitHubRepo,
	number: number,
	options: GitHubClientOptions = {}
): Promise<
	Result<{ files: ChangedFile[]; omitted: boolean }, GitHubApiError | MissingGitHubTokenError>
> {
	const tokenResult = requireToken(options.token);
	if (tokenResult.isErr()) return err(tokenResult.error);
	const raw: Array<{
		filename: string;
		status: string;
		additions: number;
		deletions: number;
		patch?: string;
	}> = [];
	let omitted = false;
	for (let page = 1; page <= 10; page++) {
		const r = await githubJson<typeof raw>(
			`/repos/${repo.owner}/${repo.name}/pulls/${number}/files?per_page=100&page=${page}`,
			{ token: tokenResult.value, fetch: options.fetch }
		);
		if (r.isErr()) return err(r.error);
		raw.push(...r.value);
		if (r.value.length < 100) break;
		if (page === 10) omitted = true;
	}
	// Short paths first keeps root metadata visible without knowing any repository layout.
	raw.sort(
		(a, b) => a.filename.length - b.filename.length || a.filename.localeCompare(b.filename)
	);
	let pathChars = 0,
		patchChars = 0;
	const files: ChangedFile[] = [];
	for (const f of raw) {
		if (files.length >= 100 || pathChars + f.filename.length > 8000) {
			omitted = true;
			continue;
		}
		pathChars += f.filename.length;
		const patch =
			f.patch && !f.patch.split('\n').some((line) => line.length > 1000) && patchChars < 4000
				? f.patch.slice(0, Math.min(500, 4000 - patchChars))
				: undefined;
		patchChars += patch?.length ?? 0;
		files.push({
			filename: f.filename,
			status: f.status,
			additions: f.additions,
			deletions: f.deletions,
			...(patch ? { patch } : {}),
			patchOmitted: !f.patch || patch?.length !== f.patch.length,
		});
	}
	return ok({ files, omitted });
}

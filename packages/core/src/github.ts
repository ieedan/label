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
	repository?: string;
	comments: ItemComment[];
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
	})
	.passthrough();

const gitHubWebhookSchema = z
	.object({
		action: z.string().optional(),
		issue: gitHubItemSchema.optional(),
		pull_request: gitHubItemSchema.optional(),
		repository: gitHubRepositorySchema.optional(),
		conversation: z.array(conversationCommentSchema).optional(),
	})
	.passthrough();

export function githubToken(env: NodeJS.Dict<string> = process.env): string | undefined {
	return env.GITHUB_TOKEN ?? env.GH_TOKEN;
}

export function parseRepo(repo: string): Result<GitHubRepo, InvalidRepoError> {
	const trimmed = repo
		.trim()
		.replace(/\/+$/, '')
		.replace(/\.git$/, '');
	const withoutProtocol = trimmed.replace(/^https?:\/\//, '');
	const withoutHost = withoutProtocol.replace(/^(www\.)?github\.com\//, '');
	const [owner, name] = withoutHost.split('/');

	if (!owner || !name || withoutHost.split('/').length !== 2) {
		return err(new InvalidRepoError(repo));
	}

	return ok({ owner, name });
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
		return ok(
			toLabelItem(
				rawItem,
				type,
				repositoryName(webhook.data.repository) ?? fallbackRepo,
				(webhook.data.conversation ?? []).map(toStoredComment)
			)
		);
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
	user?: { login?: string } | null;
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
};

function toFetchedComment(raw: GitHubComment, kind: ItemComment['kind']): ItemComment | null {
	const body = truncateCommentBody(raw.body ?? '');
	if (body.length === 0) return null;
	return {
		author: raw.user?.login ?? null,
		role: parseAuthorRole(raw.author_association),
		body,
		createdAt: raw.created_at ?? null,
		kind,
	};
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

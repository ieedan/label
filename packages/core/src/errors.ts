import pc from 'picocolors';

export class LabelError extends Error {
	private readonly suggestion: string;
	private readonly docsLink?: string;
	constructor(
		message: string,
		options: {
			suggestion: string;
			docsLink?: string;
		}
	) {
		super(message);

		this.suggestion = options.suggestion;
		this.docsLink = options.docsLink;
	}

	toString() {
		return `${this.message} ${this.suggestion}${pc.gray(this.docsLink ? `\n   See: ${this.docsLink}` : '')}`;
	}
}

export class InvalidPayloadError extends LabelError {
	constructor() {
		super('Invalid GitHub issue or pull request payload.', {
			suggestion:
				'Pass a GitHub issues or pull_request webhook payload, or an issue object with number and title.',
		});
	}
}

export class InvalidRepoError extends LabelError {
	constructor(repo: string) {
		super(`Invalid repository: ${pc.bold(repo)}.`, {
			suggestion: 'Use the owner/name format, for example ieedan/label.',
		});
	}
}

export class RepoNotDetectedError extends LabelError {
	constructor() {
		super('Could not detect a GitHub repository from the git remotes.', {
			suggestion:
				'Run inside a repository with a GitHub remote, or pass the repository with -R owner/name.',
		});
	}
}

export class InvalidIssueNumberError extends LabelError {
	constructor(value: string) {
		super(`Invalid issue number: ${pc.bold(value)}.`, {
			suggestion: 'Issue numbers must be positive integers.',
		});
	}
}

export class NoIssueNumbersError extends LabelError {
	constructor() {
		super('No issue or pull request numbers were provided.', {
			suggestion:
				'Pass numbers, or use --all or --top, for example: label label -R owner/name --top 10.',
		});
	}
}

export class ConflictingIssueSelectionError extends LabelError {
	constructor() {
		super('Issue selection flags conflict.', {
			suggestion: 'Pass issue numbers, --all, or --top — not more than one of those.',
		});
	}
}

export class InvalidTopCountError extends LabelError {
	constructor(value: string) {
		super(`Invalid --top count: ${pc.bold(value)}.`, {
			suggestion: 'Pass a positive integer, for example --top 10.',
		});
	}
}

export class NoIssuesFoundError extends LabelError {
	constructor() {
		super('No issues or pull requests matched.', {
			suggestion: 'Try --include-closed, --issues, or --prs, or pass specific numbers.',
		});
	}
}

export class WrongItemKindError extends LabelError {
	constructor(
		number: number,
		actual: 'issue' | 'pull_request',
		expected: 'issue' | 'pull_request'
	) {
		super(`#${number} is a ${actual === 'pull_request' ? 'pull request' : 'issue'}.`, {
			suggestion:
				expected === 'issue'
					? 'Drop --issues, or pass an issue number.'
					: 'Drop --prs, or pass a pull request number.',
		});
	}
}

export class MissingGitHubTokenError extends LabelError {
	constructor() {
		super('GitHub token not found.', {
			suggestion: 'Set GITHUB_TOKEN or GH_TOKEN in your environment.',
		});
	}
}

export class MissingTypeSafeApiKeyError extends LabelError {
	constructor() {
		super('TypeSafe API key not found.', {
			suggestion: 'Set TYPESAFE_API_KEY in your environment.',
		});
	}
}

export class GitHubApiError extends LabelError {
	constructor(status: number, body: string) {
		super(`GitHub API error (${status}): ${body}`, {
			suggestion: 'Check the repository, issue numbers, and token permissions.',
		});
	}
}

export class TypeSafeRequestError extends LabelError {
	constructor(error: unknown) {
		super(
			`TypeSafe request failed: ${error instanceof Error ? error.message : String(error)}`,
			{
				suggestion: 'Check TYPESAFE_API_KEY and try again.',
			}
		);
	}
}

export class InvalidLabelPolicyError extends LabelError {
	readonly detail: string;

	constructor(detail: string, filePath = '.label.yml') {
		super(`Invalid ${pc.bold(filePath)}: ${detail}`, {
			suggestion: 'Check the YAML syntax and label entries, then try again.',
		});
		this.detail = detail;
	}
}

export class MissingLabelPolicyFileError extends LabelError {
	constructor(filePath: string) {
		super(`Label policy not found: ${pc.bold(filePath)}.`, {
			suggestion: 'Pass a path that exists, or omit --config to use .label.yml.',
		});
	}
}

export class UnknownPolicyLabelError extends LabelError {
	constructor(name: string, filePath = '.label.yml') {
		super(`Unknown label ${pc.bold(name)} in ${pc.bold(filePath)}.`, {
			suggestion: 'Use a label that exists on the GitHub repository, or create it first.',
		});
	}
}

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MissingLabelPolicyFileError } from '../src/errors.js';
import { mergeLabelPolicy, parseLabelPolicy, readLabelPolicy } from '../src/policy.js';

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('parseLabelPolicy', () => {
	it('parses overlay fields', () => {
		const result = parseLabelPolicy(`
prompt: Prefer specific area labels.
only_configured: true
labels:
  bug:
    apply_when: Reproducible incorrect behavior.
    remove_when: Missing features.
    examples:
      - Crash when input is empty
    threshold: 0.7
    can_remove: false
  duplicate:
    context: similar_issues
    apply_when: The same report already exists.
  good first issue:
    can_apply: false
    threshold: 0.85
`);

		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value.prompt).toBe('Prefer specific area labels.');
			expect(result.value.onlyConfigured).toBe(true);
			expect(result.value.labels.bug).toMatchObject({
				applyWhen: 'Reproducible incorrect behavior.',
				removeWhen: 'Missing features.',
				examples: ['Crash when input is empty'],
				threshold: 0.7,
				canRemove: false,
			});
			expect(result.value.labels.duplicate).toMatchObject({
				context: 'similar_issues',
				applyWhen: 'The same report already exists.',
			});
			expect(result.value.labels['good first issue']).toMatchObject({
				canApply: false,
				threshold: 0.85,
			});
		}
	});

	it('treats an empty file as no overlay', () => {
		const result = parseLabelPolicy('');
		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value).toEqual({ labels: {} });
		}
	});

	it('rejects invalid YAML', () => {
		expect(parseLabelPolicy('labels: [').isErr()).toBe(true);
	});

	it('rejects an unknown context', () => {
		expect(parseLabelPolicy('labels:\n  bug:\n    context: entire_repo\n').isErr()).toBe(true);
	});
});

describe('mergeLabelPolicy', () => {
	const github = [
		{ name: 'bug', description: 'Something is broken.', color: 'd73a4a' },
		{ name: 'enhancement', description: 'New capability.', color: 'a2eeef' },
	];

	it('overlays matching GitHub labels', () => {
		const result = mergeLabelPolicy(github, {
			labels: {
				Bug: {
					applyWhen: 'Reproducible incorrect behavior.',
					threshold: 0.8,
				},
			},
		});

		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value).toEqual([
				{
					name: 'bug',
					description: 'Something is broken.',
					color: 'd73a4a',
					applyWhen: 'Reproducible incorrect behavior.',
					removeWhen: undefined,
					examples: undefined,
					threshold: 0.8,
					canApply: undefined,
					canRemove: undefined,
				},
				{ name: 'enhancement', description: 'New capability.', color: 'a2eeef' },
			]);
		}
	});

	it('errors on labels that do not exist on GitHub', () => {
		const result = mergeLabelPolicy(github, {
			labels: { typo: { applyWhen: 'Nope' } },
		});
		expect(result.isErr()).toBe(true);
	});

	it('attaches similar_issues context to matching labels', () => {
		const result = mergeLabelPolicy(
			[...github, { name: 'duplicate', description: 'Already reported.', color: 'cccccc' }],
			{
				labels: {
					duplicate: { context: 'similar_issues', applyWhen: 'Same report exists.' },
				},
			}
		);

		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value.find((label) => label.name === 'duplicate')).toMatchObject({
				context: 'similar_issues',
				applyWhen: 'Same report exists.',
			});
		}
	});

	it('keeps only configured labels when onlyConfigured is set', () => {
		const result = mergeLabelPolicy(github, {
			onlyConfigured: true,
			labels: {
				bug: { applyWhen: 'Reproducible incorrect behavior.' },
			},
		});

		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value).toEqual([
				{
					name: 'bug',
					description: 'Something is broken.',
					color: 'd73a4a',
					applyWhen: 'Reproducible incorrect behavior.',
					removeWhen: undefined,
					examples: undefined,
					threshold: undefined,
					canApply: undefined,
					canRemove: undefined,
				},
			]);
		}
	});
});

describe('readLabelPolicy', () => {
	it('reads .label.yml from cwd', async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'label-policy-'));
		tempDirs.push(dir);
		await writeFile(path.join(dir, '.label.yml'), 'prompt: Be conservative.\n');

		const result = await readLabelPolicy(dir);
		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value.prompt).toBe('Be conservative.');
		}
	});

	it('returns an empty policy when no file exists', async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'label-policy-'));
		tempDirs.push(dir);

		const result = await readLabelPolicy(dir);
		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value).toEqual({ labels: {} });
		}
	});

	it('reads a policy from an explicit config path', async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'label-policy-'));
		tempDirs.push(dir);
		await writeFile(path.join(dir, '.label.yml'), 'prompt: From default name.\n');
		await mkdir(path.join(dir, 'policies'));
		await writeFile(path.join(dir, 'policies', 'frontend.yml'), 'prompt: From custom path.\n');

		const result = await readLabelPolicy(dir, 'policies/frontend.yml');
		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value.prompt).toBe('From custom path.');
		}
	});

	it('errors when an explicit config path is missing', async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'label-policy-'));
		tempDirs.push(dir);

		const result = await readLabelPolicy(dir, 'missing.yml');
		expect(result.isErr()).toBe(true);
		if (result.isErr()) {
			expect(result.error).toBeInstanceOf(MissingLabelPolicyFileError);
		}
	});
});

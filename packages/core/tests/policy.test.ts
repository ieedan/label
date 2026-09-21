import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeLabelPolicy, parseLabelPolicy, readLabelPolicy } from '../src/policy.js';

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('parseLabelPolicy', () => {
	it('parses overlay fields', () => {
		const result = parseLabelPolicy(`
policy: Prefer specific area labels.
only_configured: true
labels:
  bug:
    apply_when: Reproducible incorrect behavior.
    not_when: Missing features.
    examples:
      - Crash when input is empty
    threshold: 0.7
  good first issue:
    auto: false
    threshold: 0.85
`);

		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value.policy).toBe('Prefer specific area labels.');
			expect(result.value.onlyConfigured).toBe(true);
			expect(result.value.labels.bug).toMatchObject({
				applyWhen: 'Reproducible incorrect behavior.',
				notWhen: 'Missing features.',
				examples: ['Crash when input is empty'],
				threshold: 0.7,
			});
			expect(result.value.labels['good first issue']).toMatchObject({
				auto: false,
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
					notWhen: undefined,
					examples: undefined,
					threshold: 0.8,
					auto: undefined,
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
					notWhen: undefined,
					examples: undefined,
					threshold: undefined,
					auto: undefined,
				},
			]);
		}
	});
});

describe('readLabelPolicy', () => {
	it('reads .label.yml from cwd', async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'label-policy-'));
		tempDirs.push(dir);
		await writeFile(path.join(dir, '.label.yml'), 'policy: Be conservative.\n');

		const result = await readLabelPolicy(dir);
		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value.policy).toBe('Be conservative.');
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
});

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { err, ok, type Result } from 'nevereverthrow';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { InvalidLabelPolicyError, UnknownPolicyLabelError } from './errors';
import type { RepoLabel } from './github';

export const LABEL_POLICY_FILENAMES = ['.label.yml', '.label.yaml'] as const;

export type LabelPolicyEntry = {
	description?: string;
	applyWhen?: string;
	notWhen?: string;
	examples?: string[];
	threshold?: number;
	auto?: boolean;
};

export type LabelPolicy = {
	policy?: string;
	labels: Record<string, LabelPolicyEntry>;
};

export type LabelDefinition = {
	name: string;
	description: string | null;
	color?: string;
	applyWhen?: string;
	notWhen?: string;
	examples?: string[];
	threshold?: number;
	auto?: boolean;
};

const labelPolicyEntrySchema = z.object({
	description: z.string().optional(),
	apply_when: z.string().optional(),
	not_when: z.string().optional(),
	examples: z.array(z.string()).optional(),
	threshold: z.coerce.number().min(0).max(1).optional(),
	auto: z.boolean().optional(),
});

const labelPolicySchema = z.object({
	policy: z.string().optional(),
	labels: z.record(z.string(), labelPolicyEntrySchema).optional(),
});

export function parseLabelPolicy(content: string): Result<LabelPolicy, InvalidLabelPolicyError> {
	let raw: unknown;
	try {
		raw = parseYaml(content);
	} catch (error) {
		return err(
			new InvalidLabelPolicyError(error instanceof Error ? error.message : String(error))
		);
	}

	if (raw === null || raw === undefined) {
		return ok({ labels: {} });
	}

	const parsed = labelPolicySchema.safeParse(raw);
	if (!parsed.success) {
		return err(
			new InvalidLabelPolicyError(parsed.error.issues[0]?.message ?? 'Invalid policy.')
		);
	}

	const labels: Record<string, LabelPolicyEntry> = {};
	for (const [name, entry] of Object.entries(parsed.data.labels ?? {})) {
		labels[name] = {
			description: entry.description,
			applyWhen: emptyToUndefined(entry.apply_when),
			notWhen: emptyToUndefined(entry.not_when),
			examples: entry.examples?.filter((example) => example.trim().length > 0),
			threshold: entry.threshold,
			auto: entry.auto,
		};
	}

	return ok({
		policy: emptyToUndefined(parsed.data.policy),
		labels,
	});
}

export function findLabelPolicyFile(cwd: string): string | undefined {
	let dir = path.resolve(cwd);

	while (true) {
		for (const filename of LABEL_POLICY_FILENAMES) {
			const filePath = path.join(dir, filename);
			if (existsSync(filePath)) return filePath;
		}

		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export async function readLabelPolicy(
	cwd: string
): Promise<Result<LabelPolicy, InvalidLabelPolicyError>> {
	const filePath = findLabelPolicyFile(cwd);
	if (!filePath) return ok({ labels: {} });

	const content = await readFile(filePath, 'utf8');
	return parseLabelPolicy(content);
}

export function mergeLabelPolicy(
	githubLabels: RepoLabel[],
	policy: LabelPolicy
): Result<LabelDefinition[], UnknownPolicyLabelError> {
	const byName = new Map(githubLabels.map((label) => [label.name.toLowerCase(), label]));

	for (const name of Object.keys(policy.labels)) {
		if (!byName.has(name.toLowerCase())) {
			return err(new UnknownPolicyLabelError(name));
		}
	}

	return ok(
		githubLabels.map((label) => {
			const matching = findEntry(policy.labels, label.name);
			if (!matching) return label;
			return {
				name: label.name,
				description: matching.description ?? label.description,
				color: label.color,
				applyWhen: matching.applyWhen,
				notWhen: matching.notWhen,
				examples: matching.examples,
				threshold: matching.threshold,
				auto: matching.auto,
			};
		})
	);
}

function findEntry(
	labels: Record<string, LabelPolicyEntry>,
	name: string
): LabelPolicyEntry | undefined {
	const needle = name.toLowerCase();
	for (const [key, entry] of Object.entries(labels)) {
		if (key.toLowerCase() === needle) return entry;
	}
	return undefined;
}

function emptyToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

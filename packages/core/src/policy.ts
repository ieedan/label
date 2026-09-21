import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { err, ok, type Result } from 'nevereverthrow';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
	InvalidLabelPolicyError,
	MissingLabelPolicyFileError,
	UnknownPolicyLabelError,
} from './errors';
import type { RepoLabel } from './github';

export const LABEL_POLICY_FILENAMES = ['.label.yml', '.label.yaml'] as const;

export const LABEL_CONTEXTS = ['similar_issues'] as const;

export type LabelContext = (typeof LABEL_CONTEXTS)[number];

export type LabelPolicyEntry = {
	description?: string;
	applyWhen?: string;
	removeWhen?: string;
	examples?: string[];
	threshold?: number;
	canApply?: boolean;
	canRemove?: boolean;
	context?: LabelContext;
};

export type LabelPolicy = {
	prompt?: string;
	onlyConfigured?: boolean;
	labels: Record<string, LabelPolicyEntry>;
};

export type LabelDefinition = {
	name: string;
	description: string | null;
	color?: string;
	applyWhen?: string;
	removeWhen?: string;
	examples?: string[];
	threshold?: number;
	canApply?: boolean;
	canRemove?: boolean;
	context?: LabelContext;
};

const labelPolicyEntrySchema = z.object({
	description: z.string().optional(),
	apply_when: z.string().optional(),
	remove_when: z.string().optional(),
	examples: z.array(z.string()).optional(),
	threshold: z.coerce.number().min(0).max(1).optional(),
	can_apply: z.boolean().optional(),
	can_remove: z.boolean().optional(),
	context: z.enum(LABEL_CONTEXTS).optional(),
});

const labelPolicySchema = z.object({
	prompt: z.string().optional(),
	only_configured: z.boolean().optional(),
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
			removeWhen: emptyToUndefined(entry.remove_when),
			examples: entry.examples?.filter((example) => example.trim().length > 0),
			threshold: entry.threshold,
			canApply: entry.can_apply,
			canRemove: entry.can_remove,
			context: entry.context,
		};
	}

	return ok({
		prompt: emptyToUndefined(parsed.data.prompt),
		onlyConfigured: parsed.data.only_configured,
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
	cwd: string,
	config?: string
): Promise<Result<LabelPolicy, InvalidLabelPolicyError | MissingLabelPolicyFileError>> {
	const filePath = config ? path.resolve(cwd, config) : findLabelPolicyFile(cwd);
	if (!filePath) return ok({ labels: {} });

	if (config && !existsSync(filePath)) {
		return err(new MissingLabelPolicyFileError(filePath));
	}

	const content = await readFile(filePath, 'utf8');
	const parsed = parseLabelPolicy(content);
	if (parsed.isErr()) {
		return err(new InvalidLabelPolicyError(parsed.error.detail, filePath));
	}
	return parsed;
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

	const merged = githubLabels.flatMap((label) => {
		const matching = findEntry(policy.labels, label.name);
		if (!matching) {
			return policy.onlyConfigured ? [] : [label];
		}
		return [
			{
				name: label.name,
				description: matching.description ?? label.description,
				color: label.color,
				applyWhen: matching.applyWhen,
				removeWhen: matching.removeWhen,
				examples: matching.examples,
				threshold: matching.threshold,
				canApply: matching.canApply,
				canRemove: matching.canRemove,
				...(matching.context ? { context: matching.context } : {}),
			},
		];
	});

	return ok(merged);
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

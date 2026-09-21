import * as core from '@ieedan/label-core';
import { Command } from 'commander';
import type { Result } from 'nevereverthrow';
import { z } from 'zod';
import {
	commonOptions,
	defaultCommandOptionsSchema,
	parseOptions,
	tryCommand,
} from '@/commands/utils';
import { loadEnv } from '@/utils/env';
import type { CLIError } from '@/utils/errors';
import { initLogging, intro, outro } from '@/utils/prompts';
import { formatDecisions } from '@/utils/table';

export const schema = defaultCommandOptionsSchema.extend({
	verbose: z.boolean(),
	dryRun: z.boolean(),
	remove: z.boolean(),
	repo: z.string().optional(),
	threshold: z.coerce.number(),
	all: z.boolean(),
	top: z.union([z.boolean(), z.coerce.number()]).optional(),
	includeClosed: z.boolean(),
	issues: z.boolean(),
	prs: z.boolean(),
	withConfidence: z.boolean(),
	prompt: z.string().optional(),
	config: z.string().optional(),
});

export type LabelOptions = z.infer<typeof schema>;

export const label = new Command('label')
	.description('Label GitHub issues and pull requests with Jev.')
	.argument('[numbers...]', 'Issue or pull request numbers.')
	.option(
		'-R, --repo <owner/name>',
		'GitHub repository. Defaults to the GitHub remote of the repository at --cwd.'
	)
	.option('--dry-run', 'Do not apply or remove labels; print decisions only.', false)
	.option('--remove', 'Remove labels that no longer apply.', false)
	.option('--all', 'Label every matching issue and pull request.', false)
	.option(
		'--top [n]',
		`Label the N most recently updated issues or pull requests (default ${core.DEFAULT_TOP_ISSUES}).`
	)
	.option('--include-closed', 'Include closed issues and pull requests.', false)
	.option('--issues', 'Limit to issues (exclude pull requests).', false)
	.option('--prs', 'Limit to pull requests (exclude issues).', false)
	.option('--with-confidence', 'Accepted for compatibility; confidence is always shown.', false)
	.option('--prompt <text>', 'Instructions for Jev. Combined with prompt from the config file.')
	.option(
		'-c, --config <path>',
		'Path to the label policy file (default: .label.yml or .label.yaml).'
	)
	.option(
		'--threshold <n>',
		'Minimum noul probability to apply a label.',
		String(core.DEFAULT_LABEL_THRESHOLD)
	)
	.addOption(commonOptions.cwd)
	.addOption(commonOptions.verbose)
	.action(async (numbers: string[], rawOptions) => {
		const options = parseOptions(schema, rawOptions);
		loadEnv(options.cwd);

		intro();
		const { spinner } = initLogging({ options });

		spinner.start('Asking Jev which labels to apply...');
		const result = await tryCommand(runLabel(numbers, options));
		spinner.stop(result.dryRun ? 'Dry run. No labels were changed.' : 'Updated labels.');

		process.stdout.write(
			`\n${formatDecisions(result.decisions, { remove: options.remove })}\n\n`
		);

		outro(
			result.dryRun
				? `Chose labels for ${result.decisions.length} item(s) in ${result.repo}.`
				: `Updated ${result.decisions.length} item(s) in ${result.repo}.`
		);
	});

export async function runLabel(
	numbers: string[],
	options: LabelOptions
): Promise<Result<core.LabelIssuesResult, CLIError>> {
	return core.labelIssues({
		repo: options.repo,
		numbers,
		all: options.all,
		top: options.top,
		includeClosed: options.includeClosed,
		issues: options.issues,
		prs: options.prs,
		dryRun: options.dryRun,
		remove: options.remove,
		threshold: options.threshold,
		prompt: options.prompt,
		cwd: options.cwd,
		config: options.config,
	});
}

import type { LabelDecision } from '@ieedan/label-core';
import pc from 'picocolors';
import { describe, expect, it } from 'vitest';
import { cli } from '@/cli';
import { formatDecisions } from '@/utils/table';

describe('cli', () => {
	it('registers the label command', () => {
		expect(cli.commands.map((command) => command.name())).toContain('label');
	});

	it('registers all, top, include-closed, issues, prs, with-confidence, prompt, remove, and config options', () => {
		const command = cli.commands.find((entry) => entry.name() === 'label');
		const flags = command?.options.map((option) => option.long) ?? [];
		expect(flags).toEqual(
			expect.arrayContaining([
				'--all',
				'--top',
				'--include-closed',
				'--issues',
				'--prs',
				'--with-confidence',
				'--prompt',
				'--remove',
				'--config',
			])
		);
	});
});

describe('formatDecisions', () => {
	const decisions: LabelDecision[] = [
		{
			item: {
				type: 'issue',
				number: 12,
				title: 'Crash on empty input',
				body: 'It blows up.',
				currentLabels: [],
				comments: [],
			},
			labels: [
				{
					name: 'bug',
					description: null,
					color: 'd73a4a',
					noul: 0.91,
					threshold: 0.6,
					apply: true,
					canApply: true,
					canRemove: true,
				},
				{
					name: 'enhancement',
					description: null,
					color: 'a2eeef',
					noul: 0.1,
					threshold: 0.6,
					apply: false,
					canApply: true,
					canRemove: true,
				},
			],
			chosen: ['bug'],
		},
		{
			item: {
				type: 'pull_request',
				number: 15,
				title: 'Add dark mode',
				body: null,
				currentLabels: [],
				comments: [],
			},
			labels: [
				{
					name: 'bug',
					description: null,
					color: 'd73a4a',
					noul: 0.2,
					threshold: 0.6,
					apply: false,
					canApply: true,
					canRemove: true,
				},
				{
					name: 'enhancement',
					description: null,
					color: 'a2eeef',
					noul: 0.88,
					threshold: 0.6,
					apply: true,
					canApply: true,
					canRemove: true,
				},
			],
			chosen: ['enhancement'],
		},
	];

	it('prints the issue title and chosen labels with scores', () => {
		const table = formatDecisions(decisions, { columns: 120 });
		expect(table).toContain('┌');
		expect(table).toContain('│');
		expect(table).toContain('└');
		expect(table).toContain('#12');
		expect(table).toContain('Crash on empty input');
		expect(table).toContain('bug');
		expect(table).toContain('0.91');
		expect(table).toContain('#15');
		expect(table).toContain('enhancement');
		expect(table).toContain('0.88');
		expect(table).not.toContain('0.10');
		expect(table).not.toContain('0.20');
	});

	it('colorizes applied labels with GitHub foreground colors', () => {
		const table = formatDecisions(decisions, { columns: 120 });
		if (pc.isColorSupported) {
			expect(table).toContain('38;2;215;58;74');
			expect(table).toContain('38;2;162;238;239');
			expect(table).not.toContain('48;2;');
		}
	});

	it('colors scores relative to the threshold', () => {
		const table = formatDecisions(
			[
				{
					...decisions[0]!,
					labels: [
						{
							name: 'bug',
							description: null,
							noul: 0.91,
							threshold: 0.6,
							apply: true,
							canApply: true,
							canRemove: true,
						},
						{
							name: 'docs',
							description: null,
							noul: 0.65,
							threshold: 0.6,
							apply: true,
							canApply: true,
							canRemove: true,
						},
						{
							name: 'enhancement',
							description: null,
							noul: 0.1,
							threshold: 0.6,
							apply: false,
							canApply: true,
							canRemove: true,
						},
					],
				},
			],
			{ columns: 120 }
		);

		expect(table).toContain('0.91');
		expect(table).toContain('0.65');
		expect(table).not.toContain('0.10');
		if (pc.isColorSupported) {
			expect(table).toContain('[32m');
			expect(table).toContain('[33m');
		}
	});

	it('marks suggest-only labels', () => {
		const table = formatDecisions(
			[
				{
					...decisions[0]!,
					labels: [
						{
							name: 'bug',
							description: null,
							noul: 0.91,
							threshold: 0.6,
							apply: true,
							canApply: true,
							canRemove: true,
						},
						{
							name: 'good first issue',
							description: null,
							noul: 0.8,
							threshold: 0.6,
							apply: true,
							canApply: false,
							canRemove: true,
						},
					],
					chosen: ['bug', 'good first issue'],
				},
			],
			{ columns: 120 }
		);
		expect(table).toContain('bug');
		expect(table).toContain('good first issue (suggest)');
	});

	it('marks labels that will be removed', () => {
		const table = formatDecisions(
			[
				{
					...decisions[0]!,
					item: { ...decisions[0]!.item, currentLabels: ['enhancement'] },
					labels: [
						{
							name: 'bug',
							description: null,
							noul: 0.91,
							threshold: 0.6,
							apply: true,
							canApply: true,
							canRemove: true,
						},
						{
							name: 'enhancement',
							description: null,
							noul: 0.1,
							threshold: 0.6,
							apply: false,
							canApply: true,
							canRemove: true,
						},
					],
					chosen: ['bug'],
				},
			],
			{ columns: 120, remove: true }
		);
		expect(table).toContain('bug');
		expect(table).toContain('enhancement (remove)');
		expect(table).toContain('0.10');
	});

	it('does not mark labels for removal unless remove is true', () => {
		const table = formatDecisions(
			[
				{
					...decisions[0]!,
					item: { ...decisions[0]!.item, currentLabels: ['enhancement'] },
					labels: [
						{
							name: 'bug',
							description: null,
							noul: 0.91,
							threshold: 0.6,
							apply: true,
							canApply: true,
							canRemove: true,
						},
						{
							name: 'enhancement',
							description: null,
							noul: 0.1,
							threshold: 0.6,
							apply: false,
							canApply: true,
							canRemove: true,
						},
					],
					chosen: ['bug'],
				},
			],
			{ columns: 120 }
		);
		expect(table).toContain('bug');
		expect(table).not.toContain('enhancement (remove)');
	});

	it('keeps table rows within the terminal width', () => {
		const table = formatDecisions(decisions, { columns: 64 });
		const lines = table.split('\n');
		const widths = new Set(
			lines.map(
				(line) =>
					line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
						.length
			)
		);
		expect(widths.size).toBe(1);
		expect([...widths][0]).toBeLessThanOrEqual(64);
	});
});

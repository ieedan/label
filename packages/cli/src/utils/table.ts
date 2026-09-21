import type { LabelDecision, LabelJudgment } from '@label/core';
import pc from 'picocolors';

const TITLE_MAX = 40;
const CLOSE_MARGIN = 0.1;
const FRAME_WIDTH = 10;
const MIN_TITLE_WIDTH = 12;
const MIN_LABELS_WIDTH = 16;
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

export function formatDecisions(
	decisions: LabelDecision[],
	options: { columns?: number } = {}
): string {
	const header = ['#', 'Title', 'Labels'].map((cell) => pc.bold(cell));
	const rows = decisions.map((decision) => [
		`#${decision.item.number}`,
		pc.bold(truncate(decision.item.title, TITLE_MAX)),
		formatLabels(decision),
	]);

	return formatTable([header, ...rows], options.columns ?? process.stdout.columns ?? 80);
}

function formatTable(rows: string[][], columns: number): string {
	const numberWidth = Math.max(...rows.map((row) => visibleLength(row[0] ?? '')));
	const available = Math.max(
		MIN_TITLE_WIDTH + MIN_LABELS_WIDTH,
		columns - FRAME_WIDTH - numberWidth
	);
	const titleNatural = Math.max(...rows.map((row) => visibleLength(row[1] ?? '')));
	const titleWidth = Math.min(
		titleNatural,
		Math.max(MIN_TITLE_WIDTH, Math.min(TITLE_MAX, Math.floor(available * 0.45)))
	);
	const labelsWidth = Math.max(MIN_LABELS_WIDTH, available - titleWidth);
	const widths = [numberWidth, titleWidth, labelsWidth];

	const physical = rows.flatMap((row) => wrapRow(row, widths));

	const line = (left: string, mid: string, right: string) =>
		`${left}${widths.map((width) => '─'.repeat(width + 2)).join(mid)}${right}`;

	const formatRow = (row: string[]) =>
		`│${row.map((cell, index) => ` ${padVisible(cell ?? '', widths[index] ?? 0)} `).join('│')}│`;

	return [
		line('┌', '┬', '┐'),
		formatRow(physical[0] ?? []),
		line('├', '┼', '┤'),
		...physical.slice(1).map(formatRow),
		line('└', '┴', '┘'),
	].join('\n');
}

function wrapRow(row: string[], widths: number[]): string[][] {
	const wrapped = row.map((cell, index) => wrapCell(cell ?? '', widths[index] ?? 0, index === 2));
	const height = Math.max(...wrapped.map((lines) => lines.length), 1);
	return Array.from({ length: height }, (_, line) => wrapped.map((lines) => lines[line] ?? ''));
}

function wrapCell(cell: string, width: number, wrapCommas: boolean): string[] {
	if (cell.length === 0) return [''];
	if (wrapCommas && cell.includes(', ')) {
		return wrapTokens(cell.split(', '), width);
	}
	return [visibleLength(cell) > width ? truncateVisible(cell, width) : cell];
}

function wrapTokens(tokens: string[], width: number): string[] {
	const lines: string[] = [];
	let current = '';

	for (const raw of tokens) {
		const token = visibleLength(raw) > width ? truncateVisible(raw, width) : raw;
		const next = current.length > 0 ? `${current}, ${token}` : token;
		if (current.length > 0 && visibleLength(next) > width) {
			lines.push(current);
			current = token;
		} else {
			current = next;
		}
	}

	if (current.length > 0) lines.push(current);
	return lines.length > 0 ? lines : ['—'];
}

function formatLabels(decision: LabelDecision): string {
	const chosen = decision.labels.filter((label) => label.apply);
	if (chosen.length === 0) return '—';
	return chosen
		.map((label) => `${colorLabel(formatLabelName(label), label)} (${colorScore(label)})`)
		.join(', ');
}

function formatLabelName(label: LabelJudgment): string {
	return label.auto === false ? `${label.name} (suggest)` : label.name;
}

function colorLabel(name: string, label: LabelJudgment): string {
	if (!pc.isColorSupported) return name;
	const rgb = parseHexColor(label.color);
	if (!rgb) return name;
	return `${ESC}[38;2;${rgb.r};${rgb.g};${rgb.b}m${name}${ESC}[0m`;
}

function colorScore(label: LabelJudgment): string {
	const score = label.noul.toFixed(2);
	if (label.noul < label.threshold) return pc.red(score);
	if (label.noul < label.threshold + CLOSE_MARGIN) return pc.yellow(score);
	return pc.green(score);
}

function parseHexColor(color: string | undefined): { r: number; g: number; b: number } | undefined {
	if (!color) return undefined;
	const hex = color.trim().replace(/^#/, '');
	if (!/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
	return {
		r: Number.parseInt(hex.slice(0, 2), 16),
		g: Number.parseInt(hex.slice(2, 4), 16),
		b: Number.parseInt(hex.slice(4, 6), 16),
	};
}

function truncate(value: string, max: number): string {
	const collapsed = value.replace(/\s+/g, ' ').trim();
	if (collapsed.length <= max) return collapsed;
	return `${collapsed.slice(0, max - 1)}…`;
}

function truncateVisible(value: string, width: number): string {
	if (visibleLength(value) <= width) return value;
	const max = Math.max(1, width - 1);
	let visible = 0;
	let index = 0;
	let out = '';
	while (index < value.length && visible < max) {
		if (value[index] === ESC && value[index + 1] === '[') {
			const end = value.indexOf('m', index);
			if (end === -1) break;
			out += value.slice(index, end + 1);
			index = end + 1;
			continue;
		}
		out += value[index];
		visible += 1;
		index += 1;
	}
	return `${out}…${ESC}[0m`;
}

function visibleLength(value: string): number {
	return value.replace(ANSI, '').length;
}

function padVisible(value: string, width: number): string {
	return value + ' '.repeat(Math.max(0, width - visibleLength(value)));
}

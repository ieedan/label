import pc from 'picocolors';
import pkg from '@/../package.json';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const INTERVAL_MS = 80;
const CLEAR_LINE = '\r\x1b[K';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

export function intro() {
	console.log(`${pc.bold(pkg.name)} ${pc.dim(`v${pkg.version}`)}`);
}

export function outro(message: string) {
	console.log(message);
}

function createVerboseLogger({
	options,
}: {
	options: { verbose: boolean };
}): (msg: string) => void {
	return (msg: string) => {
		if (!options.verbose) return;
		console.error(msg);
	};
}

export type Spinner = ReturnType<typeof spinner>;

/**
 * Creates a verbose logger and a spinner. We don't want to use a spinner in verbose mode because we often want to log within spinners and maintain the logs.
 */
export function initLogging({ options }: { options: { verbose: boolean } }) {
	const verbose = createVerboseLogger({ options });
	return {
		verbose,
		spinner: spinner({ verbose: options.verbose ? verbose : undefined }),
	};
}

/** A spinner compatible with verbose logging */
function spinner({ verbose }: { verbose?: (msg: string) => void } = {}) {
	const loading = createSpinner();

	return {
		message: (msg?: string) => {
			if (verbose) {
				verbose(msg ?? '');
			} else {
				loading.message(msg ?? '');
			}
		},
		stop: (msg?: string) => {
			if (verbose) {
				verbose(msg ?? '');
			} else {
				loading.stop(msg);
			}
		},
		start: (msg?: string) => {
			if (verbose) {
				verbose(msg ?? '');
			} else {
				loading.start(msg ?? '');
			}
		},
		error: (msg?: string) => {
			if (verbose) {
				verbose(msg ?? '');
			} else {
				loading.error(msg);
			}
		},
	};
}

let restoreCursorOnExit = false;

function createSpinner() {
	const stream = process.stderr;
	let interval: ReturnType<typeof setInterval> | undefined;
	let message = '';
	let frame = 0;
	let cursorHidden = false;

	const tty = Boolean(stream.isTTY);

	function hideCursor() {
		if (!tty || cursorHidden) return;
		stream.write(HIDE_CURSOR);
		cursorHidden = true;
	}

	function showCursor() {
		if (!cursorHidden) return;
		stream.write(SHOW_CURSOR);
		cursorHidden = false;
	}

	function render() {
		stream.write(`${CLEAR_LINE}${FRAMES[frame]} ${message}`);
		frame = (frame + 1) % FRAMES.length;
	}

	function clearTimer() {
		if (!interval) return;
		clearInterval(interval);
		interval = undefined;
	}

	function finish(text?: string) {
		clearTimer();
		showCursor();
		if (tty) {
			stream.write(`${CLEAR_LINE}${text ?? message}\n`);
			return;
		}
		if (text && text !== message) stream.write(`${text}\n`);
	}

	if (!restoreCursorOnExit) {
		restoreCursorOnExit = true;
		process.once('exit', () => {
			if (process.stderr.isTTY) process.stderr.write(SHOW_CURSOR);
		});
	}

	return {
		start(msg: string) {
			message = msg;
			if (!tty) {
				stream.write(`${message}\n`);
				return;
			}
			clearTimer();
			hideCursor();
			frame = 0;
			render();
			interval = setInterval(render, INTERVAL_MS);
		},
		message(msg: string) {
			message = msg;
			if (!tty) stream.write(`${message}\n`);
		},
		stop(msg?: string) {
			finish(msg);
		},
		error(msg?: string) {
			finish(msg);
		},
	};
}

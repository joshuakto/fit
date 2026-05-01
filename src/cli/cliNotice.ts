/**
 * Console-based sync notice for CLI usage.
 *
 * Implements ISyncNotice by writing progress messages to stderr,
 * allowing the main stdout channel to remain clean for structured output.
 */

import type { ISyncNotice } from '../fitNotice';

/**
 * CLI implementation of ISyncNotice.
 * Prints sync progress messages to stderr so stdout stays clean for JSON output.
 */
export class CliNotice implements ISyncNotice {
	private lastMessage: string = '';

	setMessage(message: string, isError?: boolean): void {
		this.lastMessage = message;
		if (isError) {
			process.stderr.write(`[FIT ERROR] ${message}\n`);
		} else {
			process.stderr.write(`[FIT] ${message}\n`);
		}
	}

	remove(_finalClass?: string, _duration?: number): void {
		// No-op for CLI: the message was already printed when set
	}

	show(initialMessage?: string, _addClasses?: string[], _duration?: number): void {
		if (initialMessage) {
			this.setMessage(initialMessage);
		}
	}

	getLastMessage(): string {
		return this.lastMessage;
	}
}

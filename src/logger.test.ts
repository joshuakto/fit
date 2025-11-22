/**
 * Tests for Logger
 */

import { LogFileAdapter, Logger } from "@/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UTF8_BOM = '\uFEFF';

/**
 * Create a mock LogFileAdapter for testing
 */
function createMockAdapter(initialContent: string | null = null): LogFileAdapter & {
	content: string | null;
	writeCalls: string[];
} {
	const state = {
		content: initialContent,
		writeCalls: [] as string[]
	};

	return {
		get content() { return state.content; },
		get writeCalls() { return state.writeCalls; },
		async read(): Promise<string | null> {
			return state.content;
		},
		async write(data: string): Promise<void> {
			state.writeCalls.push(data);
			state.content = data;
		}
	};
}

/**
 * Helper to strip timestamp from log entries for stable assertions.
 * Replaces [2025-01-15T12:34:56.789Z] with [TIMESTAMP]
 */
function stripTimestamps(content: string): string {
	return content.replace(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z\]/g, '[TIMESTAMP]');
}

describe('Logger', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('initialization', () => {
		it('should create logger', () => {
			const adapter = createMockAdapter();
			const logger = new Logger({
				adapter
			});

			expect(logger).toBeInstanceOf(Logger);
		});

		it('should create logger with default maxLogSize', async () => {
			const adapter = createMockAdapter();
			const logger = new Logger({
				adapter
			});

			// Should use default 1MB limit - we can't directly inspect but we can
			// verify it doesn't crash with normal usage
			logger.log('test', 'data');
			await logger.flush();

			expect(adapter.content).not.toBeNull();
		});

		it('should accept custom maxLogSize', async () => {
			const adapter = createMockAdapter();
			const logger = new Logger({
				adapter,
				maxLogSize: 500
			});

			// Log enough to trigger truncation with small limit
			for (let i = 0; i < 10; i++) {
				logger.log(`tag${i}`, 'x'.repeat(100));
			}
			await logger.flush();

			const content = adapter.content!;
			// Should be truncated to around 500 chars (75% = 375 kept)
			expect(content.length).toBeLessThanOrEqual(600); // some buffer for header
		});
	});

	describe('logging within size limits', () => {
		it('should write log entries with BOM prefix', async () => {
			const adapter = createMockAdapter();
			const logger = new Logger({
				adapter,
				maxLogSize: 10000
			});

			logger.log('TestTag', { key: 'value' });
			await logger.flush();

			const content = adapter.content!;
			expect(content.charCodeAt(0)).toBe(0xFEFF); // UTF-8 BOM
			expect(content).toContain('TestTag');
			expect(content).toContain('"key": "value"');
		});

		it('should append multiple log entries', async () => {
			const adapter = createMockAdapter();
			const logger = new Logger({
				adapter,
				maxLogSize: 10000
			});

			logger.log('First');
			logger.log('Second');
			logger.log('Third');
			await logger.flush();

			const content = adapter.content!;
			expect(content).toContain('First');
			expect(content).toContain('Second');
			expect(content).toContain('Third');
		});

		it('should preserve existing log content when appending', async () => {
			const existingContent = UTF8_BOM + '[2025-01-01T00:00:00.000Z] Existing\n';
			const adapter = createMockAdapter(existingContent);
			const logger = new Logger({
				adapter,
				maxLogSize: 10000
			});

			logger.log('NewEntry');
			await logger.flush();

			const content = adapter.content!;
			expect(content).toContain('Existing');
			expect(content).toContain('NewEntry');
			// Should not duplicate BOM
			expect(content.indexOf(UTF8_BOM)).toBe(0);
			expect(content.indexOf(UTF8_BOM, 1)).toBe(-1);
		});

		it('should add BOM to file without one', async () => {
			const existingContent = '[2025-01-01T00:00:00.000Z] NoBomContent\n';
			const adapter = createMockAdapter(existingContent);
			const logger = new Logger({
				adapter,
				maxLogSize: 10000
			});

			logger.log('NewEntry');
			await logger.flush();

			const content = adapter.content!;
			expect(content.charCodeAt(0)).toBe(0xFEFF);
		});
	});

	describe('truncation when over size limits', () => {
		it('should truncate log at entry boundary when exceeding max size', async () => {
			const adapter = createMockAdapter();
			const logger = new Logger({
				adapter,
				maxLogSize: 500
			});

			// Log entries with identifiable markers - need enough content to exceed 500 bytes
			logger.log('[ENTRY_A]', 'first entry content ' + 'x'.repeat(100));
			logger.log('[ENTRY_B]', 'second entry content ' + 'x'.repeat(100));
			logger.log('[ENTRY_C]', 'third entry content ' + 'x'.repeat(100));
			logger.log('[ENTRY_D]', 'fourth entry content ' + 'x'.repeat(100));
			logger.log('[ENTRY_E]', 'fifth entry content ' + 'x'.repeat(100));
			await logger.flush();

			const content = adapter.content!;

			// Should have truncation header
			expect(content).toContain('[Log truncated');

			// Most recent entries should be preserved
			expect(content).toContain('[ENTRY_E]');

			// Should still have BOM
			expect(content.charCodeAt(0)).toBe(0xFEFF);
		});

		it('should keep approximately 75% of max size after truncation', async () => {
			const maxLogSize = 1000;
			const adapter = createMockAdapter();
			const logger = new Logger({
				adapter,
				maxLogSize
			});

			// Log many entries to ensure we exceed limit
			for (let i = 0; i < 20; i++) {
				logger.log(`[ENTRY_${i.toString().padStart(2, '0')}]`, 'x'.repeat(50));
			}
			await logger.flush();

			const content = adapter.content!;

			// Should be around 750 chars (75% of 1000), plus some variance for headers
			expect(content.length).toBeLessThanOrEqual(maxLogSize);
			expect(content.length).toBeGreaterThan(maxLogSize * 0.5);
		});

		it('should preserve BOM after truncation', async () => {
			const adapter = createMockAdapter();
			const logger = new Logger({
				adapter,
				maxLogSize: 300
			});

			for (let i = 0; i < 10; i++) {
				logger.log(`Entry${i}`, 'data'.repeat(20));
			}
			await logger.flush();

			const content = adapter.content!;
			expect(content.charCodeAt(0)).toBe(0xFEFF);
			// BOM should only appear once
			expect(content.split(UTF8_BOM).length).toBe(2); // split creates 2 parts for 1 occurrence
		});
	});

	describe('enormous first entry truncation', () => {
		it('should handle single entry larger than max size', async () => {
			const adapter = createMockAdapter();
			const logger = new Logger({
				adapter,
				maxLogSize: 500
			});

			// Log a single enormous entry
			logger.log('[HUGE_ENTRY]', 'x'.repeat(2000));
			await logger.flush();

			const content = adapter.content!;

			// Should be truncated
			expect(content.length).toBeLessThanOrEqual(600);
			// Should have BOM
			expect(content.charCodeAt(0)).toBe(0xFEFF);
			// Should have truncation header
			expect(content).toContain('[Log truncated');
		});

		it('should handle enormous entry when file already has content', async () => {
			const existingContent = UTF8_BOM + '[2025-01-01T00:00:00.000Z] [EXISTING]\n';
			const adapter = createMockAdapter(existingContent);
			const logger = new Logger({
				adapter,
				maxLogSize: 500
			});

			// Add huge entry that will push existing out
			logger.log('[HUGE]', 'y'.repeat(2000));
			await logger.flush();

			const content = adapter.content!;

			expect(content.length).toBeLessThanOrEqual(600);
			expect(content.charCodeAt(0)).toBe(0xFEFF);
		});

		it('should force-truncate pathological content without entry markers', async () => {
			// Pre-populate with content that has no valid log entry markers
			const pathologicalContent = UTF8_BOM + 'x'.repeat(1000);
			const adapter = createMockAdapter(pathologicalContent);
			const logger = new Logger({
				adapter,
				maxLogSize: 500
			});

			logger.log('NewEntry');
			await logger.flush();

			const content = adapter.content!;

			// Should not exceed limit even with pathological content
			expect(content.length).toBeLessThanOrEqual(600);
			expect(content.charCodeAt(0)).toBe(0xFEFF);
		});
	});

	describe('snapshot tests', () => {
		// NOTE: These snapshots intentionally contain UTF-8 BOM (\uFEFF) at the start.
		// The BOM is part of the log file format and should NOT be removed.
		// It ensures proper UTF-8 encoding when the file is read by external tools.
		// IMPORTANT: BOM only appears at the very start of the file, NOT before each log entry.

		it('should produce expected log format for simple entry', async () => {
			const adapter = createMockAdapter();
			const logger = new Logger({
				adapter,
				maxLogSize: 10000
			});

			logger.log('SimpleTag');
			await logger.flush();

			const content = stripTimestamps(adapter.content!);
			expect(content).toBe(
				UTF8_BOM + '[TIMESTAMP] SimpleTag\n'
			);
		});

		it('should produce expected log format for entry with object data', async () => {
			const adapter = createMockAdapter();
			const logger = new Logger({
				adapter,
				maxLogSize: 10000
			});

			logger.log('DataTag', {
				name: 'test',
				count: 42,
				nested: { inner: 'value' }
			});
			await logger.flush();

			const content = stripTimestamps(adapter.content!);
			expect(content).toBe(
				`${UTF8_BOM}[TIMESTAMP] DataTag: {
  "name": "test",
  "count": 42,
  "nested": {
    "inner": "value"
  }
}
`
			);
		});

		it('should produce expected log format for multiple entries (BOM only at start)', async () => {
			const adapter = createMockAdapter();
			const logger = new Logger({
				adapter,
				maxLogSize: 10000
			});

			logger.log('FirstEntry');
			logger.log('SecondEntry');
			logger.log('ThirdEntry');
			await logger.flush();

			const content = stripTimestamps(adapter.content!);
			expect(content).toBe(
				`${UTF8_BOM}[TIMESTAMP] FirstEntry
[TIMESTAMP] SecondEntry
[TIMESTAMP] ThirdEntry
`
			);
		});

		it('should produce expected format after truncation', async () => {
			const adapter = createMockAdapter();
			const logger = new Logger({
				adapter,
				maxLogSize: 400
			});

			// Generate enough content to exceed limit
			logger.log('[A]', 'a'.repeat(100));
			logger.log('[B]', 'b'.repeat(100));
			logger.log('[C]', 'c'.repeat(100));
			logger.log('[D]', 'd'.repeat(100));
			await logger.flush(); // File now > 400 bytes

			// This next log triggers truncation
			logger.log('[E]', 'e'.repeat(100));
			await logger.flush();

			const content = stripTimestamps(adapter.content!);
			expect(content).toBe(
				`${UTF8_BOM}[Log truncated - keeping last ~0KB]
[TIMESTAMP] [D]: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
[TIMESTAMP] [E]: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
`
			);
		});
	});

	describe('sanitization behavior (tested indirectly)', () => {
		it('should truncate long strings in logged data', async () => {
			const adapter = createMockAdapter();
			const logger = new Logger({
				adapter,
				maxLogSize: 100000
			});

			const longString = 'x'.repeat(3000);
			logger.log('test', { data: longString });
			await logger.flush();

			const content = adapter.content!;
			expect(content).toContain('... [truncated');
			expect(content).toContain('1000 chars]'); // 3000 - 2000 = 1000 truncated
		});

		it('should extract Error properties and custom fields', async () => {
			const adapter = createMockAdapter();
			const logger = new Logger({
				adapter,
				maxLogSize: 100000
			});

			// Simulate Octokit error with additional properties
			const error = new Error('test error message');
			Object.assign(error, {
				status: 422,
				request: { method: 'POST', url: 'https://api.github.com/repos/owner/repo/git/blobs' },
				response: { status: 422, data: { message: 'input too large' } }
			});
			logger.log('error', error);
			await logger.flush();

			const content = adapter.content!;
			expect(content).toContain('"name": "Error"');
			expect(content).toContain('"message": "test error message"');
			expect(content).toContain('"status": 422');
			expect(content).toContain('"method": "POST"');
			expect(content).toContain('"response"');
		});

		it('should truncate large body/data from API-like objects with size info', async () => {
			const adapter = createMockAdapter();
			const logger = new Logger({
				adapter,
				maxLogSize: 100000
			});

			const largePayload = 'X'.repeat(1000);
			const apiError = {
				method: 'POST',
				url: 'https://api.example.com',
				body: largePayload,
				data: largePayload
			};

			logger.log('api-error', apiError);
			await logger.flush();

			const content = adapter.content!;
			expect(content).toContain('"method": "POST"');
			// Should have preview + size info
			expect(content).toMatch(/"body": "X{500}\.\.\. \[1000 bytes total\]"/);
			expect(content).toMatch(/"data": "X{500}\.\.\. \[1000 bytes total\]"/);
			// Should not contain full payload
			expect(content).not.toContain('X'.repeat(1000));
		});

		it('should preserve small body/data from API-like objects', async () => {
			const adapter = createMockAdapter();
			const logger = new Logger({
				adapter,
				maxLogSize: 100000
			});

			const smallPayload = JSON.stringify({ error: 'file too large', limit: 100 });
			const apiError = {
				method: 'POST',
				url: 'https://api.example.com',
				status: 422,
				body: smallPayload
			};

			logger.log('api-error', apiError);
			await logger.flush();

			const content = adapter.content!;
			expect(content).toContain('"method": "POST"');
			expect(content).toContain('"status": 422');
			// Small payloads should be preserved in full
			// Small payloads should be preserved (will be JSON-escaped in the log)
			expect(content).toContain('\\"error\\":');
			expect(content).toContain('\\"limit\\":100');
		});

		it('should preserve body/data in non-API objects', async () => {
			const adapter = createMockAdapter();
			const logger = new Logger({
				adapter,
				maxLogSize: 100000
			});

			const regularObject = {
				body: 'This should be kept',
				data: 'This too'
			};

			logger.log('regular', regularObject);
			await logger.flush();

			const content = adapter.content!;
			expect(content).toContain('"body": "This should be kept"');
			expect(content).toContain('"data": "This too"');
		});

		it('should handle deeply nested objects', async () => {
			const adapter = createMockAdapter();
			const logger = new Logger({
				adapter,
				maxLogSize: 100000
			});

			// Create deeply nested object
			let obj: any = { value: 'deep' };
			for (let i = 0; i < 15; i++) {
				obj = { nested: obj };
			}

			logger.log('deep', obj);
			await logger.flush();

			const content = adapter.content!;
			// Should have depth limit message somewhere
			expect(content).toContain('[nested too deep]');
		});
	});
});

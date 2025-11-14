import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {withSlowOperationMonitoring} from './asyncMonitoring';
import {fitLogger} from '../logger';

// Mock fitLogger
vi.mock('../logger', () => ({
	fitLogger: {
		log: vi.fn()
	}
}));

describe('withSlowOperationMonitoring', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('should not log anything for fast operations', async () => {
		const promise = Promise.resolve('fast result');

		const result = await withSlowOperationMonitoring(
			promise,
			'Fast operation',
			{warnAfterMs: 10000}
		);

		expect(result).toBe('fast result');
		expect(fitLogger.log).not.toHaveBeenCalled();
	});

	it('should log warning once after threshold is exceeded', async () => {
		let resolver: (value: string) => void;
		const slowPromise = new Promise<string>((resolve) => {
			resolver = resolve;
		});

		const resultPromise = withSlowOperationMonitoring(
			slowPromise,
			'Slow operation',
			{warnAfterMs: 5000}
		);

		// Advance time past the warning threshold
		await vi.advanceTimersByTimeAsync(5100);

		// Should have logged warning
		expect(fitLogger.log).toHaveBeenCalledWith(
			'[Performance Warning] Slow operation detected',
			expect.objectContaining({
				operation: 'Slow operation',
				thresholdSeconds: '5.0',
				message: expect.stringContaining('5.0s')
			})
		);

		// Complete the operation
		resolver!('done');
		await resultPromise;

		// Should not log completion
		expect(fitLogger.log).toHaveBeenCalledTimes(1);
	});

	it('should NOT log repeated warnings (only once)', async () => {
		let resolver: (value: string) => void;
		const slowPromise = new Promise<string>((resolve) => {
			resolver = resolve;
		});

		const resultPromise = withSlowOperationMonitoring(
			slowPromise,
			'Very slow operation',
			{warnAfterMs: 5000}
		);

		// First warning at 5s
		await vi.advanceTimersByTimeAsync(5100);
		expect(fitLogger.log).toHaveBeenCalledTimes(1);

		// Advance more time - should NOT log additional warnings
		await vi.advanceTimersByTimeAsync(10000);
		expect(fitLogger.log).toHaveBeenCalledTimes(1); // Still only 1

		// Complete the operation
		resolver!('done');
		await resultPromise;

		// Still only 1 log
		expect(fitLogger.log).toHaveBeenCalledTimes(1);
	});

	it('should propagate errors from the monitored promise', async () => {
		const error = new Error('Operation failed');
		const failingPromise = Promise.reject(error);

		await expect(
			withSlowOperationMonitoring(failingPromise, 'Failing operation')
		).rejects.toThrow('Operation failed');

		// Should not log anything for fast failures
		expect(fitLogger.log).not.toHaveBeenCalled();
	});

	it('should not log after slow operation fails', async () => {
		let rejecter: (error: Error) => void;
		const failingPromise = new Promise<string>((_resolve, reject) => {
			rejecter = reject;
		});

		const resultPromise = withSlowOperationMonitoring(
			failingPromise,
			'Slow failing operation',
			{warnAfterMs: 5000}
		);

		// Advance past threshold - warning logged
		await vi.advanceTimersByTimeAsync(5100);
		expect(fitLogger.log).toHaveBeenCalledTimes(1);
		expect(fitLogger.log).toHaveBeenCalledWith(
			'[Performance Warning] Slow operation detected',
			expect.anything()
		);

		// Fail the operation
		rejecter!(new Error('Failed'));
		await expect(resultPromise).rejects.toThrow('Failed');

		// Should not log failure (only the earlier warning)
		expect(fitLogger.log).toHaveBeenCalledTimes(1);
	});

	it('should use default threshold of 10s', async () => {
		let resolver: (value: string) => void;
		const slowPromise = new Promise<string>((resolve) => {
			resolver = resolve;
		});

		const resultPromise = withSlowOperationMonitoring(
			slowPromise,
			'Operation with default threshold'
		);

		// Should not warn before 10s
		await vi.advanceTimersByTimeAsync(9000);
		expect(fitLogger.log).not.toHaveBeenCalled();

		// Should warn after 10s
		await vi.advanceTimersByTimeAsync(1100);
		expect(fitLogger.log).toHaveBeenCalledWith(
			'[Performance Warning] Slow operation detected',
			expect.objectContaining({
				thresholdSeconds: '10.0'
			})
		);

		resolver!('done');
		await resultPromise;
	});
});

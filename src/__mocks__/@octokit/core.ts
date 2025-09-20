export class Octokit {
  constructor(options?: Record<string, unknown>) {}
  request(): Promise<{ data: Record<string, unknown> }> {
    return Promise.resolve({ data: {} });
  }
}

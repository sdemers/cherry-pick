let mockExecCalls: { cmd: string; args: string[] }[] = [];

const mockGetInput = jest.fn();
const mockSetOutput = jest.fn();
const mockSetFailed = jest.fn();
const mockInfo = jest.fn();
const mockError = jest.fn();
const mockWarning = jest.fn();
const mockExec = jest.fn();
const mockAppendFileSync = jest.fn();

jest.mock('@actions/core', () => ({
  getInput: mockGetInput,
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
  info: mockInfo,
  error: mockError,
  warning: mockWarning,
}));

jest.mock('@actions/exec', () => ({
  exec: mockExec,
}));

jest.mock('fs', () => ({
  appendFileSync: mockAppendFileSync,
}));

const stubPullRequest = {
  html_url: 'https://github.com/test-owner/test-repo/pull/123',
  title: 'Test PR',
  body: 'Test body',
  head: { ref: 'feature-branch' },
};

const mockOctokit = {
  rest: {
    pulls: {
      get: jest.fn(),
      listCommits: jest.fn(),
      create: jest.fn(),
    },
  },
  paginate: jest.fn(),
};

jest.mock('@actions/github', () => ({
  context: {
    repo: { owner: 'test-owner', repo: 'test-repo' },
  },
  getOctokit: () => mockOctokit,
}));

const stubCommits = [
  {
    sha: 'abc123def456',
    commit: { message: 'First commit\nDetails', tree: { sha: 'tree-1' } },
    parents: [{ sha: 'parent-1' }],
  },
  {
    sha: '789012ghi345',
    commit: { message: 'Second commit', tree: { sha: 'tree-2' } },
    parents: [{ sha: 'parent-2' }],
  },
];

function setupExec(results?: { isCherryPickFail?: boolean; firstCherryPickFail?: boolean }) {
  mockExecCalls = [];
  let callCount = 0;

  mockExec.mockImplementation((cmd: string, args: string[], options?: any) => {
    const idx = callCount++;
    mockExecCalls.push({ cmd, args });

    const isCherryPick = cmd === 'git' && args[0] === 'cherry-pick' && args[1] === '--no-commit';
    const isDiff = cmd === 'git' && args[0] === 'diff';

    let code = 0;
    let out = '';
    let err = '';

    if (isCherryPick && results) {
      if (results.isCherryPickFail) {
        code = 1;
        err = 'error: could not apply 789... Second commit';
      }
      if (results.firstCherryPickFail) {
        const targetSha = args[args.length - 1];
        if (targetSha === 'abc123def456') {
          code = 1;
          err = 'error: could not apply abc... First commit';
        }
      }
    }

    if (isDiff && code === 1) {
      out = 'src/conflict.ts\npackage-lock.json';
    }

    if (options?.listeners?.stdout) {
      options.listeners.stdout(Buffer.from(out));
    }
    if (options?.listeners?.stderr) {
      options.listeners.stderr(Buffer.from(err));
    }
    return code;
  });
}

describe('Cherry Pick Action', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    setupExec();

    mockGetInput.mockImplementation((name: string) => {
      switch (name) {
        case 'pr_number': return '123';
        case 'target_branch': return 'main';
        case 'github_token': return 'fake-token';
        default: return '';
      }
    });

    mockOctokit.rest.pulls.get.mockResolvedValue({ data: { ...stubPullRequest } });
    mockOctokit.paginate.mockResolvedValue([...stubCommits]);
    mockOctokit.rest.pulls.create.mockResolvedValue({
      data: { number: 456, html_url: 'https://github.com/test-owner/test-repo/pull/456' },
    });
  });

  it('should cherry-pick to a single branch and create PR', async () => {
    const { run } = await import('./index');
    await run();

    const execCommands = mockExecCalls.map(c => `${c.cmd} ${c.args.join(' ')}`);

    expect(execCommands).toContain('git config user.name github-actions[bot]');
    expect(execCommands).toContain('git fetch --no-tags origin main');
    expect(execCommands).toContain('git fetch --no-tags origin pull/123/head');

    expect(mockOctokit.rest.pulls.create).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      title: 'Test PR (main)',
      head: 'feature-branch-on-main',
      base: 'main',
      body: 'Test body\n\nCherry-picked from PR #123',
    });

    expect(mockSetOutput).toHaveBeenCalledWith('cherry_pick_pr_url', 'https://github.com/test-owner/test-repo/pull/456');
    expect(mockSetOutput).toHaveBeenCalledWith('cherry_pick_pr_number', '456');
  });

  it('should cherry-pick to multiple branches', async () => {
    mockGetInput.mockImplementation((name: string) => {
      switch (name) {
        case 'pr_number': return '123';
        case 'target_branch': return 'main release/v2';
        case 'github_token': return 'fake-token';
        default: return '';
      }
    });

    const mockCreate = jest.fn();
    let createCallCount = 0;
    mockCreate
      .mockResolvedValueOnce({ data: { number: 456, html_url: 'https://github.com/.../pull/456' } })
      .mockResolvedValueOnce({ data: { number: 789, html_url: 'https://github.com/.../pull/789' } });
    mockOctokit.rest.pulls.create = mockCreate;

    const { run } = await import('./index');
    await run();

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate).toHaveBeenNthCalledWith(1, expect.objectContaining({ base: 'main', head: 'feature-branch-on-main' }));
    expect(mockCreate).toHaveBeenNthCalledWith(2, expect.objectContaining({ base: 'release/v2', head: 'feature-branch-on-release/v2' }));

    expect(mockSetOutput).toHaveBeenCalledWith('cherry_pick_pr_url', 'https://github.com/.../pull/456,https://github.com/.../pull/789');
    expect(mockSetOutput).toHaveBeenCalledWith('cherry_pick_pr_number', '456,789');
  });

  it('should continue to next branch if one fails', async () => {
    mockGetInput.mockImplementation((name: string) => {
      switch (name) {
        case 'pr_number': return '123';
        case 'target_branch': return 'main release/v2';
        case 'github_token': return 'fake-token';
        default: return '';
      }
    });

    setupExec({ firstCherryPickFail: true });

    const mockCreate = jest.fn();
    mockCreate.mockResolvedValue({ data: { number: 789, html_url: 'https://github.com/.../pull/789' } });
    mockOctokit.rest.pulls.create = mockCreate;

    const { run } = await import('./index');
    await run();

    expect(mockSetFailed).toHaveBeenCalled();
    expect(mockSetFailed.mock.calls[0][0]).toContain('release/v2');
  });

  it('should handle merge commits with -m 1', async () => {
    mockOctokit.paginate.mockResolvedValue([
      {
        sha: 'merge-sha',
        commit: { message: 'Merge PR', tree: { sha: 'tree-merge' } },
        parents: [{ sha: 'parent-a' }, { sha: 'parent-b' }],
      },
    ]);

    const { run } = await import('./index');
    await run();

    const cherryPickCalls = mockExecCalls.filter(c =>
      c.cmd === 'git' && c.args[0] === 'cherry-pick'
    );

    expect(cherryPickCalls[0].args).toContain('-m');
    expect(cherryPickCalls[0].args).toContain('1');
  });
});

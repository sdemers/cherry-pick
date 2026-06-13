let mockExecOutput = { exitCode: 0, stdout: '', stderr: '' };
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

const mockOctokit = {
  rest: {
    pulls: {
      get: jest.fn(),
      listCommits: jest.fn(),
      create: jest.fn(),
    },
    git: {
      getRef: jest.fn(),
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

function setupExec() {
  mockExecCalls = [];
  mockExec.mockImplementation((cmd: string, args: string[], options?: any) => {
    mockExecCalls.push({ cmd, args });
    const { exitCode, stdout, stderr } = mockExecOutput;
    if (options?.listeners?.stdout) {
      options.listeners.stdout(Buffer.from(stdout));
    }
    if (options?.listeners?.stderr) {
      options.listeners.stderr(Buffer.from(stderr));
    }
    return exitCode;
  });
}

describe('Cherry Pick Action', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    setupExec();

    mockExecOutput = { exitCode: 0, stdout: '', stderr: '' };

    mockGetInput.mockImplementation((name: string) => {
      switch (name) {
        case 'pr_number': return '123';
        case 'target_branch': return 'main';
        case 'github_token': return 'fake-token';
        default: return '';
      }
    });

    mockOctokit.rest.pulls.get.mockResolvedValue({
      data: {
        html_url: 'https://github.com/test-owner/test-repo/pull/123',
        title: 'Test PR',
        body: 'Test body',
      },
    });

    mockOctokit.paginate.mockResolvedValue([
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
    ]);

    mockOctokit.rest.pulls.create.mockResolvedValue({
      data: {
        number: 456,
        html_url: 'https://github.com/test-owner/test-repo/pull/456',
      },
    });
  });

  it('should cherry-pick all commits and create PR', async () => {
    const { run } = await import('./index');
    await run();

    const execCommands = mockExecCalls.map(c => `${c.cmd} ${c.args.join(' ')}`);

    expect(execCommands).toContain('git config user.name github-actions[bot]');
    expect(execCommands).toContain('git config user.email github-actions[bot]@users.noreply.github.com');
    expect(execCommands).toContain('git fetch --no-tags origin main');
    expect(execCommands).toContain('git fetch --no-tags origin pull/123/head');

    expect(mockOctokit.rest.pulls.create).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      title: 'Test PR (main)',
      head: 'cherry-pick-123-to-main',
      base: 'main',
      body: 'Cherry-picked from PR #123\n\nhttps://github.com/test-owner/test-repo/pull/123',
    });

    expect(mockSetOutput).toHaveBeenCalledWith('cherry_pick_pr_url', 'https://github.com/test-owner/test-repo/pull/456');
    expect(mockSetOutput).toHaveBeenCalledWith('cherry_pick_pr_number', 456);
  });

  it('should handle git cherry-pick failure', async () => {
    let callCount = 0;
    const callResults: Record<number, { code: number; stdout?: string; stderr?: string }> = {
      // cherry-pick commands will be calls 7 and 8 (0-indexed), make them succeed
    };
    mockExec.mockImplementation((cmd: string, args: string[], options?: any) => {
      const idx = callCount++;
      mockExecCalls.push({ cmd, args });

      const isCherryPick = cmd === 'git' && args[0] === 'cherry-pick' && args[1] === '--no-commit';

      let code = 0;
      let out = '';
      let err = '';

      if (isCherryPick) {
        // First commit succeeds, second fails
        if (args[args.length - 1] === '789012ghi345') {
          code = 1;
          err = 'error: could not apply 789... Second commit';
          out = 'src/conflict.ts\npackage-lock.json';
        }
      }

      if (cmd === 'git' && args[0] === 'diff') {
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

    const { run } = await import('./index');
    await run();

    expect(mockSetFailed).toHaveBeenCalled();
    expect(mockSetFailed.mock.calls[0][0]).toContain('Conflict');
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

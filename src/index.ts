import * as core from '@actions/core';
import * as github from '@actions/github';
import * as exec from '@actions/exec';
import * as fs from 'fs';

async function git(args: string[], options?: { silent?: boolean }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const exitCode = await exec.exec('git', args, {
    silent: options?.silent ?? true,
    ignoreReturnCode: true,
    listeners: {
      stdout: (data: Buffer) => { stdout += data.toString(); },
      stderr: (data: Buffer) => { stderr += data.toString(); },
    },
  });
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

function addToSummary(message: string) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    fs.appendFileSync(summaryFile, message + '\n');
  }
}

async function cherryPickToBranch(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  pullRequest: { title: string; body: string | null; html_url: string },
  sourceBranch: string,
  commits: { sha: string; commit: { message: string }; parents: { sha: string }[] }[],
  targetBranch: string
): Promise<{ prUrl: string; prNumber: number }> {
  const cherryPickBranch = `${sourceBranch}-on-${targetBranch}`;

  core.info(`Cherry-picking PR #${prNumber} (${commits.length} commits) to ${targetBranch}`);
  addToSummary(`\n### Cherry Pick: PR #${prNumber} → \`${targetBranch}\`\n`);
  addToSummary(`Found ${commits.length} commits\n`);

  await git(['fetch', '--no-tags', 'origin', targetBranch]);
  await git(['fetch', '--no-tags', 'origin', `pull/${prNumber}/head`]);

  const { exitCode: checkoutCode, stderr: checkoutErr } = await git(['checkout', '-b', cherryPickBranch, `origin/${targetBranch}`]);
  if (checkoutCode !== 0) {
    throw new Error(`Failed to create branch from ${targetBranch}: ${checkoutErr}`);
  }

  let cherryPickedCount = 0;
  for (const commit of commits) {
    const sha = commit.sha;
    const msg = commit.commit.message.split('\n')[0];
    core.info(`Cherry-picking ${sha.substring(0, 7)}: ${msg}`);

    const args = ['cherry-pick', '--no-commit'];
    if (commit.parents.length > 1) {
      args.push('-m', '1');
    }
    args.push(sha);

    const result = await git(args);

    if (result.exitCode !== 0) {
      const { stdout: conflictFiles } = await git(['diff', '--name-only', '--diff-filter=U']);
      const conflicted = conflictFiles
        ? conflictFiles.split('\n').map(f => `  - ${f}`).join('\n')
        : '  (unknown)';

      core.error(`Failed to cherry-pick ${sha.substring(0, 7)}`);
      core.error(`Conflicted files:\n${conflicted}`);
      core.info(result.stderr);

      addToSummary(`❌ Conflict on commit \`${sha.substring(0, 7)}\` (${msg})\n`);
      addToSummary(`Conflicted files:\n\`\`\`\n${conflicted}\n\`\`\`\n`);

      if (cherryPickedCount > 0) {
        await git(['cherry-pick', '--abort']);
        await git(['push', 'origin', cherryPickBranch]);
        addToSummary(`ℹ️ Branch \`${cherryPickBranch}\` pushed with ${cherryPickedCount}/${commits.length} commits applied\n`);
      }

      throw new Error(
        `Conflict cherry-picking ${sha.substring(0, 7)}: ${msg}\n\n` +
        `Conflicted files:\n${conflicted}\n\n` +
        `Resolve locally:\n` +
        `  git fetch origin ${cherryPickBranch}\n` +
        `  git checkout ${cherryPickBranch}\n` +
        `  git cherry-pick ${sha}  # resolve conflicts, then git add . && git cherry-pick --continue\n` +
        `  git push origin ${cherryPickBranch}`
      );
    }

    await git(['add', '-A']);
    await git(['commit', '--allow-empty', '-m', commit.commit.message]);

    cherryPickedCount++;
    core.info(`✅ Cherry-picked ${sha.substring(0, 7)}`);
    addToSummary(`✅ Cherry-picked \`${sha.substring(0, 7)}\` (${msg})\n`);
  }

  await git(['push', 'origin', cherryPickBranch]);

  const { data: newPr } = await octokit.rest.pulls.create({
    owner,
    repo,
    title: `${pullRequest.title} (${targetBranch})`,
    head: cherryPickBranch,
    base: targetBranch,
    body: `${pullRequest.body}\n\nCherry-picked from PR #${prNumber}`
  });

  core.info(`Created PR: ${newPr.html_url}`);
  addToSummary(`✅ New PR: [#${newPr.number}](${newPr.html_url})\n`);

  return { prUrl: newPr.html_url, prNumber: newPr.number };
}

export async function run(): Promise<void> {
  try {
    const prNumber = parseInt(core.getInput('pr_number', { required: true }));
    const targetBranches = core.getInput('target_branch', { required: true })
      .split(/[\s,]+/)
      .map(b => b.trim())
      .filter(b => b.length > 0);
    const token = core.getInput('github_token', { required: true });

    if (targetBranches.length === 0) {
      throw new Error('At least one target branch is required');
    }

    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const { data: pullRequest } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    const sourceBranch = pullRequest.head.ref;
    const commits = await octokit.paginate(octokit.rest.pulls.listCommits, { owner, repo, pull_number: prNumber });

    if (commits.length === 0) {
      throw new Error(`PR #${prNumber} has no commits`);
    }

    await git(['config', 'user.name', 'github-actions[bot]']);
    await git(['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);

    addToSummary(`## Cherry Pick: PR #${prNumber} → ${targetBranches.join(', ')}\n`);
    addToSummary(`Source branch: \`${sourceBranch}\`\n`);

    const results: { target: string; prUrl?: string; prNumber?: number; error?: string }[] = [];

    for (const targetBranch of targetBranches) {
      try {
        const result = await cherryPickToBranch(octokit, owner, repo, prNumber, pullRequest, sourceBranch, commits, targetBranch);
        results.push({ target: targetBranch, prUrl: result.prUrl, prNumber: result.prNumber });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        core.error(`Failed to cherry-pick to ${targetBranch}: ${message}`);
        addToSummary(`❌ Failed to cherry-pick to \`${targetBranch}\`:\n\`\`\`\n${message}\n\`\`\`\n`);
        results.push({ target: targetBranch, error: message });
      }
    }

    const succeeded = results.filter(r => r.prUrl);
    const failed = results.filter(r => r.error);

    if (succeeded.length > 0) {
      const urls = succeeded.map(r => r.prUrl!).join(',');
      const numbers = succeeded.map(r => r.prNumber!.toString()).join(',');
      core.setOutput('cherry_pick_pr_url', urls);
      core.setOutput('cherry_pick_pr_number', numbers);

      addToSummary(`\n### Summary\n`);
      addToSummary(`Succeeded: ${succeeded.length}/${targetBranches.length}\n`);
      for (const r of succeeded) {
        addToSummary(`- \`${r.target}\`: [#${r.prNumber}](${r.prUrl})\n`);
      }
    }

    if (failed.length > 0) {
      throw new Error(`Failed to cherry-pick to ${failed.length} branch(es): ${failed.map(r => r.target).join(', ')}`);
    }

  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
      addToSummary(`\n### Failed ❌\n${error.message}\n`);
    }
  }
}

if (!process.env.JEST_WORKER_ID) {
  run();
}

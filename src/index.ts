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

export async function run(): Promise<void> {
  try {
    const prNumber = parseInt(core.getInput('pr_number', { required: true }));
    const targetBranch = core.getInput('target_branch', { required: true });
    const token = core.getInput('github_token', { required: true });

    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const { data: pullRequest } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    const commits = await octokit.paginate(octokit.rest.pulls.listCommits, { owner, repo, pull_number: prNumber });

    if (commits.length === 0) {
      throw new Error(`PR #${prNumber} has no commits`);
    }

    const cherryPickBranch = `cherry-pick-${prNumber}-to-${targetBranch}`;

    core.info(`Cherry-picking PR #${prNumber} (${commits.length} commits) to ${targetBranch}`);
    addToSummary(`## Cherry Pick: PR #${prNumber} → \`${targetBranch}\`\n`);
    addToSummary(`Found ${commits.length} commits\n`);

    await git(['config', 'user.name', 'github-actions[bot]']);
    await git(['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);

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
          addToSummary(`\nℹ️ Branch \`${cherryPickBranch}\` pushed with ${cherryPickedCount}/${commits.length} commits applied\n`);
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
    core.setOutput('cherry_pick_pr_url', newPr.html_url);
    core.setOutput('cherry_pick_pr_number', newPr.number);

    addToSummary(`\n### Success 🎉\nNew PR: [#${newPr.number}](${newPr.html_url})\n`);

  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
      addToSummary(`\n### Failed ❌\n${error.message}\n`);
    }
  }
}

run();

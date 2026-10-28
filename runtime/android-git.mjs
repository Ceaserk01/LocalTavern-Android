// Android has no system git executable. This adapter implements the simple-git
// operations used by SillyTavern's extension and server-plugin managers with the
// same isomorphic-git dependency already used by its built-in clone backend.
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';

export const CheckRepoActions = Object.freeze({ IS_REPO_ROOT: 'root' });

export default function androidGit(options = {}) {
    const dir = typeof options === 'string' ? options : options.baseDir || process.cwd();
    return new AndroidGit(dir);
}

class AndroidGit {
    constructor(dir) {
        this.dir = path.resolve(dir);
        this.options = { fs, dir: this.dir };
    }

    async checkIsRepo() {
        try {
            const bare = await git.getConfig({ ...this.options, path: 'core.bare' });
            return path.resolve(await git.findRoot({ fs, filepath: this.dir })) === this.dir
                && bare !== true && bare !== 'true';
        } catch {
            return false;
        }
    }

    async fetch(remote = 'origin', flags = []) {
        if (!Array.isArray(flags)) throw new Error('Unsupported fetch options');
        const unsupported = flags.filter(flag => flag !== '--unshallow');
        if (unsupported.length) throw new Error(`Unsupported fetch option: ${unsupported.join(', ')}`);
        return git.fetch({
            ...this.options, http, remote,
            singleBranch: false,
            ...(flags.includes('--unshallow') ? { depth: 2147483647 } : {}),
        });
    }

    async revparse(args) {
        if (args.length === 1 && args[0] === '--is-shallow-repository') {
            try { return fs.readFileSync(path.join(this.dir, '.git', 'shallow'), 'utf8').trim() ? 'true' : 'false'; }
            catch (error) { if (error.code === 'ENOENT') return 'false'; throw error; }
        }
        if (args[0] === '--abbrev-ref') {
            const branch = await git.currentBranch(this.options);
            if (!branch) throw new Error('Detached HEAD has no tracking branch');
            if (args[1] === 'HEAD') return branch;
            if (args[1] !== '@{u}') throw new Error('Unsupported abbreviated ref');
            const remote = await git.getConfig({ ...this.options, path: `branch.${branch}.remote` }) || 'origin';
            const merge = await git.getConfig({ ...this.options, path: `branch.${branch}.merge` }) || `refs/heads/${branch}`;
            return `${remote}/${merge.replace(/^refs\/heads\//, '')}`;
        }
        const short = args[0] === '--short';
        if (args.length !== (short ? 2 : 1)) throw new Error('Unsupported revparse options');
        const oid = await git.resolveRef({ ...this.options, ref: args[short ? 1 : 0] });
        return short ? oid.slice(0, 7) : oid;
    }

    async branch(args = []) {
        const current = await git.currentBranch(this.options) || '';
        const remoteOnly = args.includes('-r');
        if (args.some(arg => !['-r', '--list', 'origin/*'].includes(arg))) throw new Error('Unsupported branch options');
        const names = await git.listBranches({ ...this.options, ...(remoteOnly ? { remote: 'origin' } : {}) });
        const branches = {};
        for (const name of names) {
            const label = remoteOnly ? `origin/${name}` : name;
            const oid = await git.resolveRef({ ...this.options, ref: label });
            const { commit } = await git.readCommit({ ...this.options, oid });
            branches[label] = {
                current: !remoteOnly && name === current,
                name: label,
                commit: oid.slice(0, 7),
                label: commit.message.split('\n')[0],
            };
        }
        return { current, all: Object.keys(branches), branches };
    }

    async branchLocal() { return this.branch(); }

    async getRemotes() {
        const remotes = await git.listRemotes(this.options);
        return remotes.map(({ remote, url }) => ({ name: remote, refs: { fetch: url, push: url } }));
    }

    async log({ from, to } = {}) {
        const target = await git.log({ ...this.options, ref: to || 'HEAD' });
        const excluded = from ? new Set((await git.log({ ...this.options, ref: from })).map(item => item.oid)) : new Set();
        const all = target.filter(item => !excluded.has(item.oid)).map(item => ({
            hash: item.oid, message: item.commit.message.trim(),
            date: new Date(item.commit.committer.timestamp * 1000).toISOString(),
        }));
        return { total: all.length, all, latest: all[0] || null };
    }

    async remote(args) {
        if (args.length !== 3 || args[0] !== 'set-branches' || args[2] !== '*') {
            throw new Error('Unsupported remote operation');
        }
        const remote = args[1];
        await git.setConfig({ ...this.options, path: `remote.${remote}.fetch`, value: `+refs/heads/*:refs/remotes/${remote}/*` });
    }

    async checkout(branch) {
        await git.checkout({ ...this.options, ref: branch });
    }

    async checkoutBranch(localBranch, trackingBranch) {
        const separator = trackingBranch.indexOf('/');
        if (separator < 1) throw new Error('A remote tracking branch is required');
        const remote = trackingBranch.slice(0, separator);
        const remoteBranch = trackingBranch.slice(separator + 1);
        // Preserve slash-containing branch names, e.g. feature/mobile.
        if (localBranch !== remoteBranch) {
            const oid = await git.resolveRef({ ...this.options, ref: trackingBranch });
            await git.writeRef({ ...this.options, ref: `refs/heads/${localBranch}`, value: oid });
        }
        await git.checkout({ ...this.options, ref: localBranch, remote });
        await git.setConfig({ ...this.options, path: `branch.${localBranch}.remote`, value: remote });
        await git.setConfig({ ...this.options, path: `branch.${localBranch}.merge`, value: `refs/heads/${remoteBranch}` });
    }

    async pull(remote = 'origin', branch) {
        // Extensions have no author identity configured. A fast-forward update
        // preserves local edits and fails safely when histories diverge.
        return git.fastForward({ ...this.options, http, remote, ref: branch, singleBranch: true });
    }
}

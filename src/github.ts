/** The few GitHub REST calls the app needs. All go straight from the iPad to api.github.com with the user's token. */

const API = 'https://api.github.com'

export class GitHubError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export interface RepoRef { owner: string; repo: string }
export const repoKey = (r: RepoRef) => `${r.owner}/${r.repo}`
export function parseRepo(s: string): RepoRef | null {
  const m = /^\s*(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?\s*$/.exec(s)
  return m ? { owner: m[1]!, repo: m[2]! } : null
}

export interface TreeEntry { path: string; sha: string; size: number }

export class GitHub {
  constructor(private token: string, private fetchImpl: typeof fetch = fetch.bind(globalThis)) {}

  private async call(path: string, init: RequestInit = {}, accept = 'application/vnd.github+json'): Promise<Response> {
    let res: Response
    try {
      res = await this.fetchImpl(`${API}${path}`, {
        ...init,
        cache: 'no-store',
        headers: { Authorization: `Bearer ${this.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', ...(init.headers ?? {}) },
      })
    } catch {
      throw new GitHubError(0, '인터넷에 연결되지 않음')
    }
    if (!res.ok) {
      let msg = res.statusText
      try { msg = ((await res.json()) as { message?: string }).message ?? msg } catch { /* not json */ }
      if (res.status === 401) msg = '토큰이 맞지 않거나 만료됨'
      else if (res.status === 404) msg = '저장소나 파일을 찾을 수 없음 (토큰의 저장소 범위를 확인)'
      else if (res.status === 403 && /rate limit/i.test(msg)) msg = 'GitHub 요청 한도 초과. 잠시 뒤 다시'
      throw new GitHubError(res.status, msg)
    }
    return res
  }

  async user(): Promise<string> {
    return ((await (await this.call('/user')).json()) as { login: string }).login
  }

  async defaultBranch(r: RepoRef): Promise<string> {
    return ((await (await this.call(`/repos/${r.owner}/${r.repo}`)).json()) as { default_branch: string }).default_branch
  }

  /** Head commit of a branch and its full file list */
  async tree(r: RepoRef, branch: string): Promise<{ commit: string; files: TreeEntry[]; truncated: boolean }> {
    const c = (await (await this.call(`/repos/${r.owner}/${r.repo}/commits/${encodeURIComponent(branch)}`)).json()) as { sha: string; commit: { tree: { sha: string } } }
    const t = (await (await this.call(`/repos/${r.owner}/${r.repo}/git/trees/${c.commit.tree.sha}?recursive=1`)).json()) as {
      tree: { path: string; type: string; sha: string; size?: number }[]; truncated: boolean
    }
    return { commit: c.sha, truncated: t.truncated, files: t.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 })) }
  }

  async exists(r: RepoRef, path: string, branch: string): Promise<boolean> {
    try {
      await this.call(`/repos/${r.owner}/${r.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`)
      return true
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return false
      throw e
    }
  }

  async blob(r: RepoRef, sha: string): Promise<ArrayBuffer> {
    return (await this.call(`/repos/${r.owner}/${r.repo}/git/blobs/${sha}`, {}, 'application/vnd.github.raw+json')).arrayBuffer()
  }

  /**
   * Create a new file. Without a sha GitHub refuses to overwrite an existing path (422),
   * so this can only ever add a file, never change one.
   */
  async createFile(r: RepoRef, path: string, text: string, message: string, branch: string): Promise<{ commit: string }> {
    const res = await this.call(`/repos/${r.owner}/${r.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content: utf8ToBase64(text), branch }),
    })
    return { commit: ((await res.json()) as { commit: { sha: string } }).commit.sha }
  }
}

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

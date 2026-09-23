import { FormEvent, useCallback, useEffect, useState } from 'react';

interface Overview {
  users: number;
  collectibles: number;
  failedJobs: number;
  storageBytes: number;
}

interface Job {
  id: string;
  type: string;
  status: string;
  attemptCount: number;
  errorMessage?: string;
  createdAt: string;
  collectible: { name: string };
}

const TOKEN_KEY = 'bagcollect:admin-token';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const response = await fetch(`/api/admin${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || '请求失败');
  return body as T;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextOverview, nextJobs] = await Promise.all([
        api<Overview>('/overview'),
        api<Job[]>('/jobs')
      ]);
      setOverview(nextOverview);
      setJobs(nextJobs);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [token, load]);

  async function login(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const result = await api<{ accessToken: string }>('/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      sessionStorage.setItem(TOKEN_KEY, result.accessToken);
      setToken(result.accessToken);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '登录失败');
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <main className="login-shell">
        <form className="login-card" onSubmit={login}>
          <p className="eyebrow">PRIVATE CABINET · ADMIN</p>
          <h1>BagCollect</h1>
          <p>管理云端收藏与图片处理任务。</p>
          <label>管理员账号<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label>
          <label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>
          {error && <div className="error">{error}</div>}
          <button disabled={loading}>{loading ? '登录中…' : '登录'}</button>
        </form>
      </main>
    );
  }

  return (
    <main className="dashboard">
      <header>
        <div><p className="eyebrow">BAGCOLLECT OPERATIONS</p><h1>运行概览</h1></div>
        <div className="actions">
          <button className="secondary" onClick={() => void load()} disabled={loading}>刷新</button>
          <button className="secondary" onClick={() => { sessionStorage.removeItem(TOKEN_KEY); setToken(null); }}>退出</button>
        </div>
      </header>
      {error && <div className="error">{error}</div>}
      <section className="stats">
        <article><span>用户</span><strong>{overview?.users ?? '—'}</strong></article>
        <article><span>收藏</span><strong>{overview?.collectibles ?? '—'}</strong></article>
        <article><span>失败任务</span><strong>{overview?.failedJobs ?? '—'}</strong></article>
        <article><span>对象存储</span><strong>{overview ? formatBytes(overview.storageBytes) : '—'}</strong></article>
      </section>
      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">PROCESSING QUEUE</p><h2>最近图片任务</h2></div><span>{jobs.length} 条</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>收藏</th><th>任务</th><th>状态</th><th>尝试</th><th>时间</th></tr></thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td><strong>{job.collectible.name}</strong>{job.errorMessage && <small>{job.errorMessage}</small>}</td>
                  <td>{job.type}</td><td><span className={`status status--${job.status.toLowerCase()}`}>{job.status}</span></td>
                  <td>{job.attemptCount}</td><td>{new Date(job.createdAt).toLocaleString('zh-CN')}</td>
                </tr>
              ))}
              {!jobs.length && <tr><td colSpan={5} className="empty">暂无任务</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

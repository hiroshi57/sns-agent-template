import { NextResponse } from 'next/server';
import https from 'https';

export const runtime = 'nodejs';

const GH_REPO = 'YOUR_GITHUB_USERNAME/YOUR_REPO';
const GH_TOKEN = process.env['GITHUB_TOKEN'] ?? '';

const WORKFLOWS = [
  { id: 'x-daily-transfer.yml',        label: 'X 投稿',           group: 'sns' },
  { id: 'instagram-daily.yml',          label: 'Instagram/Threads', group: 'sns' },
  { id: 'tiktok-daily.yml',             label: 'TikTok',            group: 'sns' },
  { id: 'note-daily.yml',               label: 'note',              group: 'sns' },
  { id: 'micro-apps-promo.yml',         label: 'MicroApps アフィリ', group: 'app' },
  { id: 'pdca-cycle.yml',               label: 'PDCA 分析',         group: 'sys' },
  { id: 'x-session-refresh.yml',        label: 'X セッション維持',   group: 'sys' },
  { id: 'vercel-dashboard-deploy.yml',  label: 'ダッシュボード更新',  group: 'sys' },
  { id: 'forte-to-sns.yml',             label: 'Forte→SNS',         group: 'sys' },
];

function fetchGitHub(endpoint: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path: endpoint,
      headers: {
        'User-Agent': 'chatwork-x-dashboard/2.0',
        'Accept': 'application/vnd.github+json',
        ...(GH_TOKEN ? { 'Authorization': `Bearer ${GH_TOKEN}` } : {}),
      },
    };
    https.get(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', reject);
  });
}

export async function GET() {
  try {
    const results = await Promise.all(WORKFLOWS.map(async wf => {
      const data = await fetchGitHub(
        `/repos/${GH_REPO}/actions/workflows/${wf.id}/runs?per_page=5`
      ) as { workflow_runs?: unknown[] } | null;
      return { ...wf, runs: (data?.workflow_runs ?? []).slice(0, 5) };
    }));
    return NextResponse.json({ workflows: results });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

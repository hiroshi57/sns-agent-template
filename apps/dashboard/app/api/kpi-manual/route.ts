import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

interface ManualKpi {
  date:      string;
  platform:  string;
  imp?:      number;
  pv?:       number;
  clicks?:   number;
  revenue?:  number;
  note?:     string;
  savedAt?:  string;
}

const KV_KEY     = 'kpi:manual';
const MAX_ENTRIES = 180;

/** Vercel KV が設定されている場合のみ使用するヘルパー */
function isKvConfigured(): boolean {
  return Boolean(
    process.env['KV_REST_API_URL'] && process.env['KV_REST_API_TOKEN'],
  );
}

async function kvGet<T>(key: string): Promise<T | null> {
  const url   = process.env['KV_REST_API_URL']!;
  const token = process.env['KV_REST_API_TOKEN']!;
  const res   = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const json = await res.json() as { result: T | null };
  return json.result;
}

async function kvSet(key: string, value: unknown): Promise<void> {
  const url   = process.env['KV_REST_API_URL']!;
  const token = process.env['KV_REST_API_TOKEN']!;
  const res   = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(value),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`KV SET failed (${res.status}): ${text}`);
  }
}

export async function GET() {
  if (!isKvConfigured()) {
    return NextResponse.json({
      entries: [],
      _note: 'KV_REST_API_URL / KV_REST_API_TOKEN が未設定のため手動 KPI は利用できません',
    });
  }
  try {
    const entries = await kvGet<ManualKpi[]>(KV_KEY) ?? [];
    return NextResponse.json({ entries });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!isKvConfigured()) {
    return NextResponse.json(
      { error: 'KV_REST_API_URL / KV_REST_API_TOKEN が未設定です。Vercel 環境変数を設定してください。' },
      { status: 503 },
    );
  }
  try {
    const body = await req.json() as ManualKpi;
    if (!body.date || !body.platform) {
      return NextResponse.json({ error: 'date と platform は必須です' }, { status: 400 });
    }
    const entries = await kvGet<ManualKpi[]>(KV_KEY) ?? [];
    entries.push({ ...body, savedAt: new Date().toISOString() });
    const trimmed = entries.slice(-MAX_ENTRIES);
    await kvSet(KV_KEY, trimmed);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

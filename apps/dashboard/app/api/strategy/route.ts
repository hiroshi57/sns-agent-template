import { NextResponse } from 'next/server';
import { fetchRawJson } from '../../lib/github-data';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const strategy = await fetchRawJson<Record<string, unknown>>('data/strategy.json');
    if (!strategy) return NextResponse.json({ exists: false, _source: 'github-raw' });
    return NextResponse.json({ exists: true, strategy, _source: 'github-raw' });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

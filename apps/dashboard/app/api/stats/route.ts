import { NextResponse } from 'next/server';
import { buildStats } from '../../lib/github-data';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const stats = await buildStats();
    return NextResponse.json(stats);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

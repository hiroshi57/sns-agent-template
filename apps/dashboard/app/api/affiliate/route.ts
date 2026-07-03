import { NextResponse } from 'next/server';
import { buildAffiliate } from '../../lib/github-data';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const data = await buildAffiliate();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

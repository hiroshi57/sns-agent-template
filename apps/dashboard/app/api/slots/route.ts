import { NextResponse } from 'next/server';
import { buildSlots } from '../../lib/github-data';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const data = await buildSlots();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

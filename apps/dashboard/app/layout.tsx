import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'SNS 投稿ダッシュボード | @twisokhou',
  description: 'X / Instagram / TikTok / Note / Forte.AI 投稿管理ダッシュボード',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <link rel="stylesheet" href="/dashboard.css" />
      </head>
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}

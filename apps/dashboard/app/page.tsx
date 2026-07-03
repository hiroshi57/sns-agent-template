'use client';

import Script from 'next/script';

export const dynamic = 'force-dynamic';

const GH_REPO = 'YOUR_GITHUB_USERNAME/YOUR_REPO';

export default function DashboardPage() {
  return (
    <>
      {/* Chart.js CDN — loaded before dashboard.js */}
      <Script
        src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"
        strategy="beforeInteractive"
      />
      {/* Dashboard logic — all API data is sanitized via esc() before DOM insertion */}
      <Script src="/dashboard.js" strategy="afterInteractive" />

      <div className="header">
        <div className="header-left">
          <div className="header-logo">🕊️</div>
          <div>
            <div className="header-title">SNS 投稿ダッシュボード</div>
            <div className="header-sub">@twisokhou — 世界のトレンド報道局</div>
          </div>
        </div>
        <div className="header-right">
          <div className="clock" id="clock"></div>
          {/* onClick calls window.loadAll exposed by dashboard.js */}
          <button className="btn" onClick={() => (window as Window & typeof globalThis & { loadAll?: () => void }).loadAll?.()}>
            ↻ 更新
          </button>
          <a
            className="btn btn-primary"
            href={`https://github.com/${GH_REPO}/actions`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Actions ↗
          </a>
        </div>
      </div>

      <div className="nav">
        {[
          { name: 'today',     label: '本日',       color: '#a78bfa' },
          { name: 'weekly',    label: '週間',       color: '#22c55e' },
          { name: 'review',    label: '週次レビュー', color: '#fb923c' },
          { name: 'history',   label: '配信履歴',   color: '#38bdf8' },
          { name: 'actions',   label: 'Actions',  color: '#f59e0b' },
          { name: 'affiliate', label: 'アフィリ', color: '#a78bfa' },
          { name: 'pdca',      label: 'PDCA',     color: '#fb923c' },
        ].map((t, i) => (
          <div
            key={t.name}
            className={`tab${i === 0 ? ' active' : ''}`}
            onClick={() => (window as Window & typeof globalThis & { switchTab?: (n: string) => void }).switchTab?.(t.name)}
          >
            <span className="dot" style={{ background: t.color }}></span>
            {t.label}
          </div>
        ))}
      </div>

      <div className="main">

        {/* 本日 */}
        <div className="tab-content active" id="tab-today">
          <div className="section-title">KPI — 本日</div>
          <div className="kpi-row" id="kpi-today"></div>
          <div className="section-title">プラットフォーム別</div>
          <div className="platform-row" id="platform-row-today"></div>
          <div className="section-title">スロット実行</div>
          <div className="card">
            <div className="slot-grid" id="slot-panel"></div>
          </div>
          <div className="grid2">
            <div className="card">
              <div className="card-title">直近の投稿</div>
              <ul className="recent-list" id="recent-list"></ul>
            </div>
            <div className="card">
              <div className="card-title">本日 テーマ分布 (X)</div>
              <div className="chart-wrap"><canvas id="themeChart"></canvas></div>
            </div>
          </div>
        </div>

        {/* 週間 */}
        <div className="tab-content" id="tab-weekly">
          <div className="section-title">7日間 投稿推移</div>
          <div className="card">
            <div className="chart-wrap"><canvas id="trendChart"></canvas></div>
          </div>
          <div className="section-title">KPI 達成状況（直近7日・目標 15件/日）</div>
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: '.72rem', color: '#475569' }}>目標: 15件/日</span>
              <span style={{ fontSize: '.72rem', color: '#475569' }} id="kpi-achieve-rate"></span>
            </div>
            <div className="weekly-kpi" id="weekly-kpi-bars"></div>
          </div>
          <div className="grid2">
            <div className="card">
              <div className="card-title">ソース別（本日）</div>
              <div className="chart-wrap-sm"><canvas id="sourceChart"></canvas></div>
            </div>
            <div className="card">
              <div className="card-title">X スロット別（本日）</div>
              <div className="chart-wrap-sm"><canvas id="xSlotChart"></canvas></div>
            </div>
          </div>
        </div>

        {/* 週次レビュー */}
        <div className="tab-content" id="tab-review">
          <div className="section-title">週次レビューサマリー</div>
          <div className="kpi-row" id="review-kpi-row"></div>
          <div className="section-title">プラットフォーム別 日次実績（7日間）</div>
          <div className="card" id="review-pf-table">
            <div className="empty">読み込み中...</div>
          </div>
          <div className="section-title">Imp / PV（週次 手動入力データ）</div>
          <div className="card" id="review-imp-pv">
            <div className="empty">読み込み中...</div>
          </div>
          <div className="grid2">
            <div className="card" id="review-theme-coverage">
              <div className="empty">読み込み中...</div>
            </div>
            <div className="card" id="review-insight">
              <div className="empty">読み込み中...</div>
            </div>
          </div>
        </div>

        {/* 配信履歴 */}
        <div className="tab-content" id="tab-history">
          <div className="section-title">配信履歴（直近30日）</div>
          <div className="card" id="history-panel">
            <div className="empty">読み込み中...</div>
          </div>
        </div>

        {/* Actions */}
        <div className="tab-content" id="tab-actions">
          <div className="section-title">GitHub Actions — 全ワークフロー</div>
          <div className="card" id="actions-all">
            <div className="empty">読み込み中...</div>
          </div>
        </div>

        {/* アフィリ */}
        <div className="tab-content" id="tab-affiliate">
          <div className="section-title">現在のランキング商品</div>
          <div className="card" id="affiliate-products">
            <div className="empty">読み込み中...</div>
          </div>
          <div className="section-title">投稿履歴</div>
          <div className="card" id="affiliate-log">
            <div className="empty">読み込み中...</div>
          </div>
        </div>

        {/* PDCA */}
        <div className="tab-content" id="tab-pdca">
          <div className="section-title">現在の投稿戦略</div>
          <div className="grid2">
            <div className="card" id="strategy-panel">
              <div className="empty">読み込み中...</div>
            </div>
            <div className="card">
              <div className="card-title">7日間 スロット集計</div>
              <div className="chart-wrap"><canvas id="pdcaSlotChart"></canvas></div>
            </div>
          </div>
          <div className="card">
            <div className="card-title">スロット実行履歴（直近35件）</div>
            <div className="chart-wrap"><canvas id="slotHistChart"></canvas></div>
          </div>
        </div>

      </div>
    </>
  );
}

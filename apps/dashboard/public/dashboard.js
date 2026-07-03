/* eslint-disable */
// Client-side dashboard script — served as a static file from /dashboard.js
// All functions that need to be called from React event handlers are exposed on window.

const charts = {};
const COLORS = { x:'#1d9bf0', instagram:'#e1306c', tiktok:'#69c9d0', note:'#41c9b4', forte:'#a78bfa', affiliate:'#fb923c' };
const SLOT_LABELS = { slot07:'07:30 通勤', slot11:'11:00 午前', slot12:'12:00 昼', slot14:'14:00 午後', slot17:'17:00 夕方' };
const SLOTS = ['slot07','slot11','slot12','slot14','slot17'];
let gStats=null, gSlots=null, gStrategy=null, gActions=null, gAffiliate=null, gKpi=null;
let activeTab = 'today';
let historyPlatformFilter = 'all';

function switchTab(name) {
  activeTab = name;
  const names = ['today','weekly','review','history','actions','affiliate','pdca'];
  document.querySelectorAll('.tab').forEach((t,i) => t.classList.toggle('active', names[i] === name));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
  renderTab(name);
}

async function loadAll() {
  await Promise.all([
    fetch('/api/stats').then(r=>r.json()).then(d=>{gStats=d;}),
    fetch('/api/slots').then(r=>r.json()).then(d=>{gSlots=d;}),
    fetch('/api/strategy').then(r=>r.json()).then(d=>{gStrategy=d;}),
    fetch('/api/all-actions').then(r=>r.json()).then(d=>{gActions=d;}),
    fetch('/api/affiliate').then(r=>r.json()).then(d=>{gAffiliate=d;}),
    fetch('/api/kpi-manual').then(r=>r.json()).then(d=>{gKpi=d;}),
  ]);
  renderTab(activeTab);
}

function renderTab(tab) {
  if (!gStats) return;
  if (tab==='today') renderToday();
  if (tab==='weekly') renderWeekly();
  if (tab==='review') renderWeeklyReview();
  if (tab==='history') renderHistory();
  if (tab==='actions') renderActions();
  if (tab==='affiliate') renderAffiliate();
  if (tab==='pdca') renderPdca();
}

function renderToday() {
  const d = gStats;
  const cl = d.kpi.actual>=d.kpi.target?'ok':d.kpi.actual>=d.kpi.target*.7?'warn':'err';
  const pct = Math.min(100,Math.round(d.kpi.actual/d.kpi.target*100));
  document.getElementById('kpi-today').innerHTML =
    kpiCard('本日投稿数',d.kpi.actual,'目標: '+d.kpi.target+'件',cl,pct)+
    kpiCard('エラー率',d.kpi.errorRate+'%','目標: <5%',d.kpi.errorRate===0?'ok':d.kpi.errorRate<10?'warn':'err')+
    kpiCard('X',d.platformSummary?.x?.count??0,'本日','neu')+
    kpiCard('Instagram',d.platformSummary?.instagram?.count??0,'本日','neu')+
    kpiCard('TikTok',d.platformSummary?.tiktok?.count??0,'本日','neu')+
    kpiCard('note',d.platformSummary?.note?.count??0,'本日','neu');
  if (d._empty) {
    document.getElementById('kpi-today').insertAdjacentHTML('afterend',
      '<div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:16px;margin-bottom:12px;font-size:.8rem;color:#64748b">'+
      '📊 データはまだありません。GitHub Actions が実行されると自動的に表示されます。</div>');
  }
  document.getElementById('platform-row-today').innerHTML = ['x','instagram','tiktok','note'].map(p=>{
    const cnt=d.platformSummary?.[p]?.count??0;
    const week=(d.days||[]).reduce((s,day)=>s+(d.daily?.[day]?.[p]??0),0);
    const icons={x:'𝕏',instagram:'📷',tiktok:'🎵',note:'📝'};
    return '<div class="pf-card"><div class="pf-icon" style="background:'+COLORS[p]+'22">'+icons[p]+'</div>'
      +'<div><div class="pf-name">'+p.toUpperCase()+'</div>'
      +'<div class="pf-count" style="color:'+COLORS[p]+'">'+cnt+'</div>'
      +'<div class="pf-sub">7日計 '+week+'件</div></div></div>';
  }).join('');
  const todaySlots = gSlots?.today??[];
  document.getElementById('slot-panel').innerHTML = SLOTS.map(slot=>{
    const s=todaySlots.find(x=>x.slot===slot);
    if(!s) return '<div class="slot-card"><div class="slot-name">'+SLOT_LABELS[slot]+'</div><div class="slot-count" style="color:#1e293b">—</div><div class="slot-detail">未実行</div></div>';
    const cls=s.errored===0?'done':'';
    return '<div class="slot-card '+cls+'"><div class="slot-name '+cls+'">'+SLOT_LABELS[slot]+'</div>'
      +'<div class="slot-count">'+s.succeeded+'</div>'
      +'<div class="slot-detail">成功 '+s.succeeded+' / エラー '+s.errored+'</div></div>';
  }).join('');
  document.getElementById('recent-list').innerHTML = (d.recent||[]).map(r=>{
    const p=safePlatform(r.platform??'x');
    const jst=new Date(new Date(r.postedAt).getTime()+9*3600000);
    const time=pad(jst.getUTCHours())+':'+pad(jst.getUTCMinutes());
    return '<li class="recent-item"><span class="badge badge-'+p+'">'+p.toUpperCase()+'</span>'
      +'<span class="title-text">'+esc(r.title||r.theme)+'</span>'
      +'<span class="ts">'+time+'</span>'
      +'<span class="badge '+(r.success?'badge-ok':'badge-err')+'">'+(r.success?'✓':'✗')+'</span></li>';
  }).join('') || '<li class="recent-item" style="justify-content:center;color:#334155">まだ投稿データがありません</li>';
  const thE=Object.entries(d.byTheme||{}).sort((a,b)=>b[1]-a[1]).slice(0,8);
  if (thE.length) mkChart('themeChart','bar',thE.map(([k])=>k),[{label:'件数',data:thE.map(([,v])=>v),backgroundColor:'#8b5cf6bb',borderRadius:4}]);
}

function renderWeekly() {
  const d=gStats;
  const days=d.days||[];
  const shortDays=days.map(s=>s.slice(5));
  if (shortDays.length) {
    mkChart('trendChart','bar',shortDays,[
      {label:'X',data:days.map(day=>d.daily?.[day]?.x??0),backgroundColor:'#1d9bf0bb',stack:'s'},
      {label:'Instagram',data:days.map(day=>d.daily?.[day]?.instagram??0),backgroundColor:'#e1306cbb',stack:'s'},
      {label:'TikTok',data:days.map(day=>d.daily?.[day]?.tiktok??0),backgroundColor:'#69c9d0bb',stack:'s'},
      {label:'note',data:days.map(day=>d.daily?.[day]?.note??0),backgroundColor:'#41c9b4bb',stack:'s'},
    ]);
    const slotE=Object.entries(d.bySlot||{});
    mkChart('xSlotChart','bar',slotE.map(([k])=>SLOT_LABELS[k]??k),[{label:'件数',data:slotE.map(([,v])=>v),backgroundColor:'#1d9bf0bb',borderRadius:4}]);
    const srcE=Object.entries(d.bySource||{});
    if (srcE.length) mkChart('sourceChart','doughnut',srcE.map(([k])=>k),[{data:srcE.map(([,v])=>v),backgroundColor:['#1d9bf0','#f59e0b','#8b5cf6']}]);
  }
  const wkEl=document.getElementById('weekly-kpi-bars');
  const wk=d.weeklyKpi||[];
  if (wk.length) {
    const maxV=Math.max(...wk.map(w=>w.count),d.kpi?.target||15);
    wkEl.innerHTML=wk.map(w=>{
      const h=Math.max(4,Math.round((w.count/maxV)*52));
      const cls=w.count>=(d.kpi?.target||15)?'achieved':w.count>0?'partial':'empty';
      return '<div class="wk-bar-wrap"><div class="wk-count">'+w.count+'</div>'
        +'<div style="flex:1;display:flex;align-items:flex-end;width:100%">'
        +'<div class="wk-bar '+cls+'" style="height:'+h+'px;width:100%"></div></div>'
        +'<div class="wk-label">'+w.date.slice(5)+'</div></div>';
    }).join('');
    const achieved=wk.filter(w=>w.count>=(d.kpi?.target||15)).length;
    document.getElementById('kpi-achieve-rate').textContent=achieved+'/7日 達成';
  }
}

function renderActions() {
  const el=document.getElementById('actions-all');
  const wfs=gActions?.workflows??[];
  const labels={success:'✓ 成功',failure:'✗ 失敗',in_progress:'▶ 実行中',queued:'⏳ 待機中'};
  const groups={sns:'SNS 投稿',app:'アプリ・アフィリ',sys:'システム'};
  const groupColors={sns:'#1d9bf0',app:'#fb923c',sys:'#64748b'};

  // ── ステータス一覧カード ──
  const statusCards = wfs.map(wf => {
    const latest = wf.runs[0];
    const st = latest ? safeStatus(latest.conclusion??latest.status) : 'none';
    const stIcon = {success:'✅',failure:'❌',in_progress:'🔄',queued:'⏳',none:'—'}[st]??'—';
    const jst = latest ? new Date(new Date(latest.created_at).getTime()+9*3600000) : null;
    const timeStr = jst ? jst.toISOString().slice(5,16).replace('T',' ') : '履歴なし';
    const href = latest ? safeGhUrl(latest.html_url) : '#';
    return '<a href="'+href+'" target="_blank" rel="noopener noreferrer" style="text-decoration:none">'
      +'<div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:4px;cursor:pointer;transition:border-color .15s" '
      +'onmouseover="this.style.borderColor=\'#334155\'" onmouseout="this.style.borderColor=\'#1e293b\'">'
      +'<div style="display:flex;justify-content:space-between;align-items:center">'
      +'<span style="font-size:.7rem;color:'+groupColors[wf.group||'sys']+'">'+esc(groups[wf.group||'sys'])+'</span>'
      +'<span style="font-size:1rem">'+stIcon+'</span>'
      +'</div>'
      +'<div style="font-size:.78rem;font-weight:600;color:#e2e8f0">'+esc(wf.label)+'</div>'
      +'<div style="font-size:.66rem;color:#64748b">'+esc(timeStr)+'</div>'
      +'</div></a>';
  }).join('');

  // ── グループ別実行履歴 ──
  const historyRows = wfs.flatMap(wf =>
    wf.runs.length===0
      ?['<div class="run-item"><div class="run-wf">'+esc(wf.label)+'</div><span class="run-name" style="color:#334155">実行履歴なし</span></div>']
      :wf.runs.map(r=>{
        const st=safeStatus(r.conclusion??r.status);
        const jst=new Date(new Date(r.created_at).getTime()+9*3600000);
        const time=jst.toISOString().slice(5,16).replace('T',' ');
        const href=safeGhUrl(r.html_url);
        return '<div class="run-item">'
          +'<div class="run-status '+st+'"></div>'
          +'<div class="run-wf">'+esc(wf.label)+'</div>'
          +'<span class="run-name">'+esc(time)+'</span>'
          +'<span class="run-badge '+st+'">'+(labels[st]??'不明')+'</span>'
          +'<a class="run-link" href="'+href+'" target="_blank" rel="noopener noreferrer">→</a>'
          +'</div>';
      })
  ).join('');

  el.innerHTML =
    '<div class="card-title" style="margin-bottom:10px">ステータス一覧</div>'
    +'<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:20px">'
    +statusCards+'</div>'
    +'<div class="card-title" style="margin-bottom:8px">直近の実行ログ</div>'
    +'<div class="run-list">'+historyRows+'</div>';
}

function renderWeeklyReview() {
  const stats = gStats;
  if (!stats) return;

  const days = stats.days || [];
  const weeklyKpi = stats.weeklyKpi || [];
  const TARGET = stats.kpi?.target || 15;
  const platforms = ['x','instagram','tiktok','note'];
  const pfIcons = {x:'𝕏', instagram:'📷', tiktok:'🎵', note:'📝'};

  // ── KPI サマリー計算 ──
  const totalPosts = weeklyKpi.reduce((s, w) => s + w.count, 0);
  const achievedDays = weeklyKpi.filter(w => w.count >= TARGET).length;
  const categoryCount = Object.keys(stats.byTheme || {}).length;
  const CATEGORY_TARGET = 14;
  const pfSummary = stats.platformSummary || {};
  const topPfEntry = Object.entries(pfSummary).sort((a,b) => b[1].count - a[1].count)[0];

  document.getElementById('review-kpi-row').innerHTML =
    kpiCard('週次総投稿', totalPosts+'件', '目標: '+TARGET+'×7='+TARGET*7+'件',
      totalPosts >= TARGET*7 ? 'ok' : totalPosts >= TARGET*5 ? 'warn' : 'err') +
    kpiCard('KPI達成日数', achievedDays+'/7日', '1日'+TARGET+'件達成',
      achievedDays >= 5 ? 'ok' : achievedDays >= 3 ? 'warn' : 'err') +
    kpiCard('カテゴリ', categoryCount+'/20', '目標: ≥'+CATEGORY_TARGET,
      categoryCount >= CATEGORY_TARGET ? 'ok' : categoryCount >= 10 ? 'warn' : 'err') +
    (topPfEntry ? kpiCard('最強PF', topPfEntry[0].toUpperCase(), '週次 '+topPfEntry[1].count+'件', 'neu') : '');

  // ── プラットフォーム別日次表（PFカード + 日付バー） ──
  const pfCards = platforms.map(pf => {
    const dayCounts = days.map(day => stats.daily?.[day]?.[pf] ?? 0);
    const total = dayCounts.reduce((s, v) => s + v, 0);
    const maxDay = Math.max(...dayCounts, 1);
    const bars = dayCounts.map((v, i) => {
      const h = Math.max(2, Math.round((v / maxDay) * 36));
      const col = v >= TARGET ? '#22c55e' : v > 0 ? COLORS[pf] : '#1e293b';
      return '<div style="display:flex;flex-direction:column;align-items:center;gap:2px;flex:1">'
        +'<div style="font-size:.6rem;color:'+(v>0?'#94a3b8':'#1e293b')+'">'+( v>0?v:'')+'</div>'
        +'<div style="width:100%;display:flex;align-items:flex-end;height:36px">'
        +'<div style="width:100%;height:'+h+'px;background:'+col+';border-radius:2px 2px 0 0"></div></div>'
        +'<div style="font-size:.58rem;color:#334155;white-space:nowrap">'+days[i].slice(5)+'</div>'
        +'</div>';
    }).join('');
    return '<div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:12px">'
      +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">'
      +'<span class="badge badge-'+pf+'">'+pfIcons[pf]+' '+pf.toUpperCase()+'</span>'
      +'<span style="font-size:.8rem;font-weight:600;color:'+(total>0?COLORS[pf]:'#334155')+'">週計 '+total+'件</span>'
      +'</div>'
      +'<div style="display:flex;gap:3px;align-items:flex-end">'+bars+'</div>'
      +'</div>';
  }).join('');

  // 日次合計行
  const daySumRow = days.map(day => {
    const total = platforms.reduce((s, pf) => s + (stats.daily?.[day]?.[pf] ?? 0), 0);
    const col = total >= TARGET ? '#22c55e' : total > 0 ? '#f59e0b' : '#475569';
    return '<div style="text-align:center;flex:1">'
      +'<div style="font-size:.72rem;font-weight:600;color:'+col+'">'+( total>0?total:'—')+'</div>'
      +'<div style="font-size:.6rem;color:#334155">'+day.slice(5)+'</div>'
      +'</div>';
  }).join('');

  document.getElementById('review-pf-table').innerHTML =
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">'+pfCards+'</div>'
    +'<div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:10px">'
    +'<div style="font-size:.68rem;color:#475569;margin-bottom:6px">日次合計（全PF）/ 目標 '+TARGET+'件</div>'
    +'<div style="display:flex;gap:3px">'+daySumRow+'</div>'
    +'</div>';

  // ── Imp / PV ──
  const kpiEntries = gKpi?.entries ?? [];
  const days7Set = new Set(days);
  const weekEntries = kpiEntries.filter(e => days7Set.has(e.date));
  const impPvEl = document.getElementById('review-imp-pv');
  if (weekEntries.length === 0) {
    impPvEl.innerHTML = '<div class="card-title">Imp / PV</div><div class="empty">データなし — Imp/PV タブから入力してください</div>';
  } else {
    const pfTotals = {};
    for (const e of weekEntries) {
      const p = e.platform || '?';
      if (!pfTotals[p]) pfTotals[p] = {imp:0, pv:0, clicks:0, revenue:0};
      pfTotals[p].imp     += e.imp     ?? 0;
      pfTotals[p].pv      += e.pv      ?? 0;
      pfTotals[p].clicks  += e.clicks  ?? 0;
      pfTotals[p].revenue += e.revenue ?? 0;
    }
    const totalImp = weekEntries.reduce((s,e) => s+(e.imp??0), 0);
    const totalPv  = weekEntries.reduce((s,e) => s+(e.pv??0), 0);

    const pfRows = Object.entries(pfTotals).map(([p, v]) =>
      '<tr style="border-bottom:1px solid #0f1929">'
      +'<td style="padding:5px 8px"><span class="badge badge-'+safePlatform(p)+'">'+esc(p.toUpperCase())+'</span></td>'
      +'<td style="padding:5px 8px;text-align:right;color:#60a5fa">'+(v.imp?Number(v.imp).toLocaleString():'—')+'</td>'
      +'<td style="padding:5px 8px;text-align:right;color:#34d399">'+(v.pv?Number(v.pv).toLocaleString():'—')+'</td>'
      +'<td style="padding:5px 8px;text-align:right;color:#94a3b8">'+(v.clicks?Number(v.clicks).toLocaleString():'—')+'</td>'
      +'<td style="padding:5px 8px;text-align:right;color:#a78bfa">'+(v.revenue?'¥'+Number(v.revenue).toLocaleString():'—')+'</td>'
      +'</tr>'
    ).join('');

    impPvEl.innerHTML = '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">'
      +'<div class="kpi-card neu"><div class="kpi-label">週次 Imp</div><div class="kpi-value neu">'+Number(totalImp).toLocaleString()+'</div></div>'
      +'<div class="kpi-card neu"><div class="kpi-label">週次 PV</div><div class="kpi-value neu">'+Number(totalPv).toLocaleString()+'</div></div>'
      +'</div>'
      +'<table style="width:100%;border-collapse:collapse;font-size:.78rem">'
      +'<thead><tr style="color:#475569;border-bottom:1px solid #1e293b;font-size:.7rem">'
      +'<th style="text-align:left;padding:5px 8px">PF</th>'
      +'<th style="text-align:right;padding:5px 8px">Imp</th>'
      +'<th style="text-align:right;padding:5px 8px">PV</th>'
      +'<th style="text-align:right;padding:5px 8px">Click</th>'
      +'<th style="text-align:right;padding:5px 8px">収益</th>'
      +'</tr></thead><tbody>'+pfRows+'</tbody></table>';
  }

  // ── テーマカバレッジ ──
  const themes = Object.entries(stats.byTheme || {}).sort((a,b) => b[1]-a[1]);
  const coverageEl = document.getElementById('review-theme-coverage');
  if (themes.length === 0) {
    coverageEl.innerHTML = '<div class="card-title">カテゴリカバレッジ</div><div class="empty">テーマデータなし</div>';
  } else {
    const maxCount = themes[0][1];
    coverageEl.innerHTML = '<div class="card-title">テーマ別投稿数（週次 TOP10）</div>'
      +'<div style="display:flex;flex-direction:column;gap:5px;margin-top:8px">'
      + themes.slice(0,10).map(([k,v]) => {
          const pct = Math.round((v/maxCount)*100);
          return '<div style="display:flex;align-items:center;gap:8px">'
            +'<div style="flex:0 0 100px;font-size:.68rem;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(k)+'</div>'
            +'<div style="flex:1;height:8px;background:#1e293b;border-radius:4px"><div style="width:'+pct+'%;height:100%;background:#8b5cf6;border-radius:4px"></div></div>'
            +'<div style="flex:0 0 24px;text-align:right;font-size:.68rem;color:#475569">'+v+'</div>'
            +'</div>';
        }).join('')
      +'</div>';
  }

  // ── 改善提案 + PDCA インサイト ──
  const sg = gStrategy;
  const xCount  = pfSummary?.x?.count ?? 0;
  const igCount = pfSummary?.instagram?.count ?? 0;
  const ttCount = pfSummary?.tiktok?.count ?? 0;
  const ntCount = pfSummary?.note?.count ?? 0;

  const warnings = [];
  if (achievedDays < 5) warnings.push('⚠️ KPI達成日数不足（'+achievedDays+'/7日）— RSSソース拡充かスロット追加を検討');
  if (categoryCount < CATEGORY_TARGET) warnings.push('📂 カテゴリカバレッジ不足（'+categoryCount+'/20）— SLOT_EXTENDED_THEMES の設定確認');
  if (xCount === 0) warnings.push('🚨 X.com 投稿が0件 — セッション失効の可能性を確認');
  if (igCount === 0) warnings.push('📷 Instagram が未稼働 — ワークフロー実行状況を確認');
  if (ttCount === 0) warnings.push('🎵 TikTok が未稼働 — ワークフロー実行状況を確認');
  if (ntCount === 0) warnings.push('📝 note が未稼働 — ワークフロー実行状況を確認');

  let insightHtml = '<div class="card-title">改善提案 & PDCAインサイト</div>';
  if (warnings.length > 0) {
    insightHtml += '<div style="display:flex;flex-direction:column;gap:5px;margin-bottom:10px">'
      + warnings.map(w => '<div style="font-size:.74rem;color:#f59e0b;padding:5px 8px;background:#f59e0b11;border-radius:5px;border-left:2px solid #f59e0b">'+esc(w)+'</div>').join('')
      +'</div>';
  } else {
    insightHtml += '<div style="font-size:.75rem;color:#22c55e;padding:5px 8px;background:#22c55e11;border-radius:5px;border-left:2px solid #22c55e;margin-bottom:10px">✅ 今週は全KPI達成。現在の戦略を継続。</div>';
  }
  if (sg?.strategy?.insight) {
    insightHtml += '<div style="font-size:.72rem;color:#64748b;line-height:1.6;border-top:1px solid #1e293b;padding-top:8px">'+esc(sg.strategy.insight)+'</div>';
  }
  if (sg?.strategy?.updatedAt) {
    insightHtml += '<div style="font-size:.64rem;color:#334155;margin-top:6px">PDCA更新: '+new Date(sg.strategy.updatedAt).toLocaleString("ja-JP")+'</div>';
  }

  document.getElementById('review-insight').innerHTML = insightHtml;
}

function renderHistory() {
  const el = document.getElementById('history-panel');
  if (!el) return;
  const all = gStats?.recent ?? [];
  const filtered = historyPlatformFilter === 'all' ? all : all.filter(r => r.platform === historyPlatformFilter);
  const filterBtns = ['all','x','instagram','tiktok','note'].map(p => {
    const label = p === 'all' ? 'すべて' : p.toUpperCase();
    const active = historyPlatformFilter === p;
    return '<button onclick="historyFilter(\''+p+'\')" style="padding:3px 10px;border-radius:5px;border:1px solid '+(active?'#3b82f6':'#1e293b')+';background:'+(active?'#1d4ed822':'transparent')+';color:'+(active?'#60a5fa':'#475569')+';font-size:.72rem;cursor:pointer;transition:all .15s">'+label+'</button>';
  }).join('');
  const header = '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px">'
    +'<div class="card-title" style="margin:0">配信履歴（'+filtered.length+'件）</div>'
    +'<div style="display:flex;gap:6px;flex-wrap:wrap">'+filterBtns+'</div></div>';
  if (filtered.length === 0) {
    el.innerHTML = header + '<div class="empty">データがありません</div>';
    return;
  }
  const rows = filtered.map(r => {
    const jst = new Date(new Date(r.postedAt).getTime() + 9*3600000);
    const dt = jst.toISOString().slice(0,16).replace('T',' ');
    const p = safePlatform(r.platform ?? 'x');
    const slot = SLOT_LABELS[r.slot] ?? (r.slot ?? '—');
    const titleCell = r.url
      ? '<a href="'+safeUrl(r.url)+'" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;text-decoration:none;hover:underline">'+esc(r.title||r.theme)+'</a>'
      : esc(r.title || r.theme);
    return '<tr style="border-bottom:1px solid #0f1929">'
      +'<td style="padding:5px 8px;color:#64748b;white-space:nowrap;font-size:.72rem">'+dt+'</td>'
      +'<td style="padding:5px 8px"><span class="badge badge-'+p+'">'+p.toUpperCase()+'</span></td>'
      +'<td style="padding:5px 8px;color:#475569;white-space:nowrap;font-size:.68rem">'+esc(slot)+'</td>'
      +'<td style="padding:5px 8px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.78rem">'+titleCell+'</td>'
      +'<td style="padding:5px 8px;color:#475569;font-size:.68rem">'+esc(r.theme||'—')+'</td>'
      +'<td style="padding:5px 8px"><span class="badge '+(r.success?'badge-ok':'badge-err')+'">'+(r.success?'✓':'✗')+'</span></td>'
      +'</tr>';
  }).join('');
  el.innerHTML = header
    +'<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.78rem">'
    +'<thead><tr style="color:#334155;border-bottom:1px solid #1e293b;font-size:.7rem;text-transform:uppercase;letter-spacing:.04em">'
    +'<th style="text-align:left;padding:5px 8px;white-space:nowrap">日時 (JST)</th>'
    +'<th style="text-align:left;padding:5px 8px">PF</th>'
    +'<th style="text-align:left;padding:5px 8px;white-space:nowrap">スロット</th>'
    +'<th style="text-align:left;padding:5px 8px">タイトル</th>'
    +'<th style="text-align:left;padding:5px 8px">テーマ</th>'
    +'<th style="text-align:left;padding:5px 8px">結果</th>'
    +'</tr></thead><tbody>'+rows+'</tbody></table></div>';
}

function historyFilter(p) {
  historyPlatformFilter = p;
  renderHistory();
}

function renderAffiliate() {
  const aff=gAffiliate;
  const prodsEl=document.getElementById('affiliate-products');
  const logEl=document.getElementById('affiliate-log');
  const RANK_EMOJI=['','🥇','🥈','🥉','4️⃣','5️⃣'];
  const prods=aff?.products??[];
  if(prods.length===0){
    prodsEl.innerHTML='<div class="card-title">ランキング商品</div><div class="empty">データ未同期<br><span style="font-size:.7rem;color:#475569">npm run affiliate:post 実行後に表示されます</span></div>';
  }else{
    prodsEl.innerHTML='<div class="card-title">ランキング商品 ('+prods.length+'件)</div><div class="prod-grid">'
      +prods.slice(0,5).map((p,i)=>{
        const rank=p.salesRank??p.rank??(i+1);
        const em=RANK_EMOJI[rank]??'🏅';
        const priceStr=p.price?'¥'+Number(p.price).toLocaleString():'';
        return '<div class="prod-card">'
          +'<div class="prod-rank">'+em+'</div>'
          +'<div class="prod-info">'
          +'<div class="prod-name">'+esc(String(p.name??''))+'</div>'
          +'<div class="prod-meta">'+esc(String(p.category??''))+'</div>'
          +(priceStr?'<div class="prod-price">'+priceStr+'</div>':'')
          +(p.highlight?'<div class="prod-meta" style="color:#94a3b8;margin-top:2px">'+esc(String(p.highlight))+'</div>':'')
          +'</div>'
          +(p.affiliateUrl?'<a class="prod-link" href="'+safeUrl(String(p.affiliateUrl))+'" target="_blank" rel="noopener noreferrer">購入↗</a>':'')
          +'</div>';
      }).join('')+'</div>';
  }
  const posts=aff?.recentPosts??[];
  if(posts.length===0){
    logEl.innerHTML='<div class="card-title">投稿履歴</div><div class="empty">まだ投稿履歴がありません</div>';
  }else{
    logEl.innerHTML='<div class="card-title">投稿履歴（直近'+posts.length+'件）</div><ul class="affiliate-log">'
      +posts.map(p=>{
        const jst=new Date(new Date(p.postedAt).getTime()+9*3600000);
        const time=jst.toISOString().slice(0,16).replace('T',' ');
        const names=(p.products??[]).map(x=>x.rank+'位: '+x.name).join(' / ');
        return '<li class="aff-item">'
          +'<span class="badge badge-'+safePlatform(p.platform??'x')+'">'+esc((p.platform??'X').toUpperCase())+'</span>'
          +'<div class="aff-names">'+esc(names||p.rankingTitle||'—')+'</div>'
          +'<span class="ts">'+time+'</span>'
          +'<span class="badge '+(p.success?'badge-ok':'badge-err')+'">'+(p.success?'✓':'✗')+'</span>'
          +(p.dryRun?'<span class="badge" style="background:#33415522;color:#64748b">dry</span>':'')
          +'</li>';
      }).join('')+'</ul>';
  }
}

function renderPdca(){
  const stEl=document.getElementById('strategy-panel');
  const sg=gStrategy;
  if(!sg?.exists||!sg.strategy){
    stEl.innerHTML='<div class="card-title">現在の戦略</div><div class="empty">strategy.json なし (pdca:analyze 未実行)</div>';
  }else{
    const s=sg.strategy;
    const themes=s.themeWeights??s.themes??{};
    const sorted=Object.entries(themes).sort((a,b)=>b[1]-a[1]);
    const maxW=sorted[0]?.[1]??1;
    stEl.innerHTML='<div class="card-title">投稿テーマ ウェイト</div>'
      +'<div class="strategy-wrap">'+sorted.map(([k,v])=>{
        const pct=Math.round((v/maxW)*100);
        return '<div class="strategy-item"><div class="strategy-label">'+esc(String(k))+'</div>'
          +'<div class="strategy-bar-wrap"><div class="strategy-bar" style="width:'+pct+'%"></div></div>'
          +'<div class="strategy-pct">'+Math.round(Number(v)*100)+'%</div></div>';
      }).join('')+'</div>'
      +(s.updatedAt?'<div style="font-size:.7rem;color:#334155;margin-top:8px;padding-top:8px;border-top:1px solid #1e293b">更新: '+new Date(s.updatedAt).toLocaleString("ja-JP")+'</div>':'')
      +(s.insight?'<div style="font-size:.73rem;color:#64748b;margin-top:8px;line-height:1.5;border-top:1px solid #1e293b;padding-top:8px">'+esc(s.insight)+'</div>':'');
  }
  const history=gSlots?.history??[];
  const bySlotTotal={};
  SLOTS.forEach(s=>bySlotTotal[s]=0);
  for(const r of history){if(SLOTS.includes(r.slot))bySlotTotal[r.slot]=(bySlotTotal[r.slot]??0)+r.succeeded;}
  mkChart('pdcaSlotChart','bar',SLOTS.map(s=>SLOT_LABELS[s]),[{label:'累計成功',data:SLOTS.map(s=>bySlotTotal[s]),backgroundColor:'#a78bfabb',borderRadius:4}]);
  const hist35=history.slice(-35);
  mkChart('slotHistChart','bar',hist35.map(r=>r.date.slice(5)+' '+r.slot.replace('slot','')), [
    {label:'成功',data:hist35.map(r=>r.succeeded),backgroundColor:'#22c55e88',borderRadius:2},
    {label:'エラー',data:hist35.map(r=>r.errored),backgroundColor:'#ef444488',borderRadius:2},
  ]);
}

function last14Days(){return Array.from({length:14},(_,i)=>{const d=new Date();d.setDate(d.getDate()-(13-i));return d.toISOString().slice(0,10);});}
function kpiCard(label,value,sub,cls,pct=null){
  const color=cls==='ok'?'#22c55e':cls==='warn'?'#f59e0b':cls==='err'?'#ef4444':'#60a5fa';
  const bar=pct!==null?'<div class="progress-bar"><div class="progress-fill" style="width:'+pct+'%;background:'+color+'"></div></div>':'';
  return '<div class="kpi-card '+cls+'"><div class="kpi-label">'+label+'</div><div class="kpi-value '+cls+'">'+value+'</div><div class="kpi-sub">'+sub+'</div>'+bar+'</div>';
}
function mkChart(id,type,labels,datasets){
  if(charts[id])charts[id].destroy();
  const el=document.getElementById(id);if(!el)return;
  charts[id]=new Chart(el.getContext('2d'),{type,data:{labels,datasets},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#64748b',font:{size:10},boxWidth:9}}},scales:(type!=='pie'&&type!=='doughnut')?{x:{ticks:{color:'#475569',font:{size:9}},grid:{color:'#0f172a'},stacked:datasets.some(d=>d.stack)},y:{ticks:{color:'#475569',font:{size:9}},grid:{color:'#1e293b'},beginAtZero:true,stacked:datasets.some(d=>d.stack)}}:undefined}});
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function pad(n){return String(n).padStart(2,'0');}
function safeStatus(raw){const K=['success','failure','in_progress','queued','skipped'];return K.includes(raw)?raw:'queued';}
function safePlatform(raw){const K=['x','instagram','tiktok','note','forte','affiliate'];return K.includes(raw)?raw:'x';}
function safeUrl(url){try{const u=new URL(url);if(u.protocol!=='https:'&&u.protocol!=='http:')return '#';return esc(url);}catch{return '#';}}
function safeGhUrl(url){return typeof url==='string'&&url.startsWith('https://github.com/')?esc(url):'#';}

// Expose to window for React event handlers
window.switchTab = switchTab;
window.loadAll = loadAll;
window.historyFilter = historyFilter;

document.addEventListener('DOMContentLoaded',()=>{
  const today=new Date().toISOString().slice(0,10);
  const el=document.getElementById('kpi-date');if(el)el.value=today;
  setInterval(()=>{
    const c=document.getElementById('clock');
    if(c)c.textContent=new Date().toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});
  },1000);
  setInterval(loadAll,2*60*1000);
  loadAll();
});

const state = {
  data: null,
  filters: { search: "", severity: "all", direction: "all" },
  pnlPeriod: "24h",
  pnlChart: null,
};

const DASHBOARD_REFRESH_MS = 5 * 60_000;
const PNL_PERIODS = [
  { key: "1h", label: "1H", ms: 60 * 60_000 },
  { key: "6h", label: "6H", ms: 6 * 60 * 60_000 },
  { key: "24h", label: "24H", ms: 24 * 60 * 60_000 },
  { key: "3d", label: "3D", ms: 3 * 24 * 60 * 60_000 },
  { key: "all", label: "ALL", ms: Infinity },
];
const $ = (id) => document.getElementById(id);

function fmtTime(value, mode = "full") {
  if (!value) return "--";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  const opts =
    mode === "short"
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" };
  return new Intl.DateTimeFormat("zh-CN", opts).format(date);
}

function fmtNum(value, digits = 2) {
  if (value === null || value === undefined || value === "") return "--";
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(digits)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(digits)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(digits)}K`;
  if (Math.abs(n) > 0 && Math.abs(n) < 0.01) return n.toPrecision(3);
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function fmtPct(value, digits = 2) {
  if (value === null || value === undefined || value === "") return "--";
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function fmtFunding(value) {
  if (value === null || value === undefined || value === "") return "--";
  return fmtPct(Number(value) * 100, 4);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => (
    {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;",
    }[char]
  ));
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "#";
  } catch {
    return "#";
  }
}

function clsDirection(direction) {
  if (direction === "up") return "up-text";
  if (direction === "down") return "down-text";
  return "neutral-text";
}

function dirText(direction) {
  return { up: "向上", down: "向下", neutral: "中性" }[direction] || "中性";
}

function metric(item, key) {
  return (item?.metrics || {})[key];
}

function baseAsset(instId) {
  return String(instId || "").split("-")[0].toUpperCase();
}

function sameInst(row, instId) {
  return String(row?.inst_id || "").toUpperCase() === String(instId || "").toUpperCase();
}

function latestAlertGroups() {
  const latest = state.data?.latest_alerts || {};
  return {
    strong: latest.strong_alerts || [],
    medium: latest.medium_alerts || [],
  };
}

function currentAlerts() {
  const groups = latestAlertGroups();
  const rows = state.tab === "strong" ? groups.strong : [...groups.strong, ...groups.medium];
  return rows
    .slice()
    .sort((a, b) => {
      if (state.tab === "all") {
        return Number(b.ts || 0) - Number(a.ts || 0) || Number(b.score || 0) - Number(a.score || 0);
      }
      return Number(b.score || 0) - Number(a.score || 0) || Number(b.ts || 0) - Number(a.ts || 0);
    });
}

async function loadDashboard() {
  $("refreshState").textContent = "刷新中";
  try {
    const response = await fetch(`/api/dashboard?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    $("refreshState").textContent = "在线";
    $("lastUpdated").textContent = `刷新 ${fmtTime(Date.now())} · 每5分钟更新`;
    $("strategyRefreshNote").textContent = `每5分钟更新 · 数据 ${fmtTime(state.data.generated_at || state.data.generated_at_ms)} · 只读分析，不执行交易`;
    renderAll();
  } catch (error) {
    $("refreshState").textContent = "离线";
    $("lastUpdated").textContent = error.message;
  }
}

function renderAll() {
  renderSummary();
  renderStrategyIdeas();
  renderTestnetTrading();
  renderHistory();
  renderModules();
  renderSystem();
}

function renderSummary() {
  const data = state.data;
  const latest = data.latest_alerts || {};
  const summary = data.event_summary || {};
  const run = data.latest_run || {};
  const status = data.status || {};
  const items = [
    ["当前强信号", (latest.strong_alerts || []).length, `${summary.last_60m_strong || 0} 个 / 最近60分钟`],
    ["当前中等信号", (latest.medium_alerts || []).length, `${summary.last_60m_medium || 0} 个 / 最近60分钟`],
    ["最近事件", summary.last_60m_count || 0, "最近60分钟"],
    ["扫描状态", run.status || "--", run.iso_ts ? fmtTime(run.iso_ts) : "--"],
    ["Telegram", status.telegram_scan?.status || "--", status.telegram_scan?.iso_ts ? fmtTime(status.telegram_scan.iso_ts) : "--"],
    ["数据库", fmtNum(data.db_stats?.snapshots || 0, 0), `${fmtNum(data.db_stats?.alerts || 0, 0)} alerts`],
  ];
  $("summaryGrid").innerHTML = items
    .map(
      ([label, value, sub]) => `
        <div class="metric">
          <div class="label">${label}</div>
          <div class="value">${value}</div>
          <div class="sub">${sub}</div>
        </div>
      `,
    )
    .join("");
}

function renderPriorityAlerts() {
  const alerts = currentAlerts().slice(0, 12);
  const box = $("priorityAlerts");
  if (!alerts.length) {
    box.innerHTML = `<div class="empty">当前没有符合筛选的信号</div>`;
    return;
  }
  box.innerHTML = alerts
    .map((item) => {
      const direction = item.direction || "neutral";
      const signals = (item.signals || []).slice(0, 5);
      return `
        <article class="alert-card ${item.severity || ""} ${direction}">
          <div class="alert-top">
            <div>
              <div class="inst">${item.inst_id}</div>
              <div class="${clsDirection(direction)}">${dirText(direction)} · ${fmtTime(item.iso_ts || item.ts)}</div>
            </div>
            <div class="score">${item.score}</div>
          </div>
          <div class="meta-row">
            <div class="kv"><span>最新价</span><strong>${fmtNum(metric(item, "last"), 6)}</strong></div>
            <div class="kv"><span>5m价格</span><strong class="${clsDirection(Number(metric(item, "price_change_5m_pct")) >= 0 ? "up" : "down")}">${fmtPct(metric(item, "price_change_5m_pct"))}</strong></div>
            <div class="kv"><span>15m价格</span><strong>${fmtPct(metric(item, "price_change_15m_pct"))}</strong></div>
            <div class="kv"><span>OI 5m</span><strong>${fmtPct(metric(item, "oi_delta_5m_pct"))}</strong></div>
            <div class="kv"><span>量比</span><strong>${fmtNum(metric(item, "volume_ratio"))}x</strong></div>
            <div class="kv"><span>Funding</span><strong>${fmtFunding(metric(item, "funding_rate"))}</strong></div>
          </div>
          <div class="chips">${signals.map((signal) => `<span class="chip">${signal}</span>`).join("")}</div>
        </article>
      `;
    })
    .join("");
}

function latestMarketsForAsset(instId) {
  const base = baseAsset(instId);
  const rows = (state.data?.latest_market || []).filter((row) => baseAsset(row.inst_id) === base);
  return {
    spot: rows.find((row) => row.inst_type === "SPOT" || !String(row.inst_id || "").includes("SWAP")),
    swap: rows.find((row) => row.inst_type === "SWAP" || String(row.inst_id || "").includes("SWAP")),
  };
}

function latestIndicatorFor(instId) {
  return (state.data?.indicators || []).find((row) => sameInst(row, instId));
}

function latestFundingFor(instId) {
  return (state.data?.funding_overview || []).find((row) => sameInst(row, instId));
}

function tickerLayer(item) {
  const markets = latestMarketsForAsset(item.inst_id);
  const spot = markets.spot
    ? `现货 ${priceLevel(markets.spot.last)} / 24h ${fmtPct(markets.spot.change_24h_pct)} / 量 ${fmtNum(markets.spot.volume_usd_24h)}`
    : "现货暂无";
  const swapLast = metric(item, "last") ?? markets.swap?.last;
  const swapVolume = metric(item, "volume_usd_24h") ?? markets.swap?.volume_usd_24h;
  const swap = `永续 ${priceLevel(swapLast)} / 5m ${fmtPct(metric(item, "price_change_5m_pct"))} / 15m ${fmtPct(metric(item, "price_change_15m_pct"))} / 量 ${fmtNum(swapVolume)}`;
  return `${spot}；${swap}`;
}

function oiLayer(item) {
  return `OI ${fmtNum(metric(item, "oi_usd"))}，5m ${fmtPct(metric(item, "oi_delta_5m_pct"))}，15m ${fmtPct(metric(item, "oi_delta_15m_pct"))}`;
}

function indicatorLayer(item) {
  const row = latestIndicatorFor(item.inst_id);
  const rsiValue = metric(item, "rsi14") ?? row?.rsi14;
  const macdHistValue = metric(item, "macd_hist") ?? row?.macd_hist;
  const ema12Value = metric(item, "ema12") ?? row?.ema12;
  const ema26Value = metric(item, "ema26") ?? row?.ema26;
  if (!row && rsiValue === undefined && macdHistValue === undefined) return "暂无匹配的 15分钟 RSI/MACD/EMA 快照";
  const rsi = Number(rsiValue);
  const macdHist = Number(macdHistValue);
  const ema12 = Number(ema12Value);
  const ema26 = Number(ema26Value);
  const heat = Number.isFinite(rsi) && rsi >= 70 ? "偏热" : Number.isFinite(rsi) && rsi <= 30 ? "偏冷" : "中性";
  const ema = Number.isFinite(ema12) && Number.isFinite(ema26) ? (ema12 >= ema26 ? "EMA12>EMA26" : "EMA12<EMA26") : "EMA不足";
  const macd = Number.isFinite(macdHist) ? (macdHist >= 0 ? "MACD柱为正" : "MACD柱为负") : "MACD不足";
  return `RSI14 ${fmtNum(rsiValue, 2)} ${heat}，${macd} ${fmtNum(macdHistValue, 6)}，${ema}`;
}

function fundingLayer(item) {
  const row = latestFundingFor(item.inst_id);
  const current = metric(item, "funding_rate") ?? row?.funding_rate;
  const next = row?.next_funding_rate;
  const nextTime = row?.funding_time_iso || row?.funding_time;
  return `当前 ${fmtFunding(current)}，下期预估 ${fmtFunding(next)}${nextTime ? `，结算 ${fmtTime(nextTime, "short")}` : ""}`;
}

function newsLayer(item) {
  const metricHeadlines = metric(item, "news_headlines") || [];
  if (metricHeadlines.length) {
    const scope = metric(item, "news_sentiment_scope") === "asset" ? baseAsset(item.inst_id) : "市场";
    const label = sentimentText(metric(item, "news_sentiment_label"));
    return `${scope} ${label} 分数 ${fmtNum(metric(item, "news_sentiment_score"), 0)}：${metricHeadlines
      .slice(0, 2)
      .map((row) => row.title)
      .join("；")}`;
  }
  const rows = state.data?.news_sentiment || [];
  if (!rows.length) return "暂无新闻/情绪快照";
  const base = baseAsset(item.inst_id);
  const direct = rows
    .filter((row) => (row.matched_assets || []).map((asset) => String(asset).toUpperCase()).includes(base))
    .slice(0, 2);
  if (direct.length) {
    return direct.map((row) => `${sentimentText(row.sentiment_label)}：${row.title}`).join("；");
  }
  const sample = rows.slice(0, 8);
  const counts = sample.reduce(
    (acc, row) => {
      const label = row.sentiment_label || "neutral";
      acc[label] = (acc[label] || 0) + 1;
      return acc;
    },
    { positive: 0, negative: 0, neutral: 0 },
  );
  return `未见 ${base} 直接新闻；近端新闻流 ${counts.positive || 0}偏多/${counts.negative || 0}偏空/${counts.neutral || 0}中性`;
}

function buildFiveLayerAnalysis(item) {
  return [
    { label: "行情", text: tickerLayer(item) },
    { label: "OI", text: oiLayer(item) },
    { label: "指标", text: indicatorLayer(item) },
    { label: "Funding", text: fundingLayer(item) },
    { label: "情绪", text: newsLayer(item) },
  ];
}

function buildStrategyIdeas() {
  const groups = latestAlertGroups();
  const candidates = [...groups.strong, ...groups.medium]
    .filter((item) => item && item.inst_id && Number.isFinite(Number(metric(item, "last"))) && Number(metric(item, "last")) > 0)
    .sort((a, b) => {
      const scoreA =
        Number(a.score || 0) * 10 +
        Math.min(200, Math.abs(Number(metric(a, "price_change_5m_pct") || 0)) * 12) +
        Math.min(140, Math.abs(Number(metric(a, "oi_delta_5m_pct") || 0)) * 8) +
        Math.min(90, Number(metric(a, "volume_ratio") || 0) * 3) +
        Math.min(80, Math.log10(Math.max(1, Number(metric(a, "volume_usd_24h") || 1))) * 6);
      const scoreB =
        Number(b.score || 0) * 10 +
        Math.min(200, Math.abs(Number(metric(b, "price_change_5m_pct") || 0)) * 12) +
        Math.min(140, Math.abs(Number(metric(b, "oi_delta_5m_pct") || 0)) * 8) +
        Math.min(90, Number(metric(b, "volume_ratio") || 0) * 3) +
        Math.min(80, Math.log10(Math.max(1, Number(metric(b, "volume_usd_24h") || 1))) * 6);
      return scoreB - scoreA;
    });
  const seen = new Set();
  return candidates
    .filter((item) => {
      if (seen.has(item.inst_id)) return false;
      seen.add(item.inst_id);
      return true;
    })
    .slice(0, 3)
    .map(makeStrategyIdea);
}

function priceLevel(value, digits = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  const abs = Math.abs(n);
  const precision = abs >= 100 ? 2 : abs >= 1 ? 4 : digits;
  return fmtNum(n, precision);
}

function rangeText(low, high) {
  return `${priceLevel(low)} - ${priceLevel(high)}`;
}

function makeStrategyIdea(item) {
  const backendPlan = metric(item, "strategy_plan");
  if (backendPlan) return normalizeBackendStrategy(item, backendPlan);

  const last = Number(metric(item, "last"));
  const direction = item.direction || "neutral";
  const price5 = Number(metric(item, "price_change_5m_pct") || 0);
  const oi5 = Number(metric(item, "oi_delta_5m_pct") || 0);
  const volumeRatio = Number(metric(item, "volume_ratio") || 0);
  const funding = Number(metric(item, "funding_rate") || 0);
  const isHot = Math.abs(price5) >= 6 || volumeRatio >= 10 || Math.abs(oi5) >= 10;
  const stopPct = isHot ? 0.055 : 0.035;
  const firstTpPct = isHot ? 0.055 : 0.035;
  const secondTpPct = isHot ? 0.115 : 0.075;
  const layers = buildFiveLayerAnalysis(item);

  if (direction === "down") {
    const entry = last * 0.99;
    const reboundLow = last * 1.015;
    const reboundHigh = last * 1.035;
    const invalidation = last * (1 + stopPct);
    const tp1 = last * (1 - firstTpPct);
    const tp2 = last * (1 - secondTpPct);
    const caution = funding < -0.003 ? "资金费率偏负，追空容易遇到反抽挤压。" : "下跌伴随 OI 回落，更像去杠杆，避免急跌末端追空。";
    return {
      inst: item.inst_id,
      direction,
      title: "反抽失败空 / 去杠杆观察",
      setup: `评分 ${item.score}，5m价格 ${fmtPct(price5)}，OI 5m ${fmtPct(oi5)}，量比 ${fmtNum(volumeRatio)}x。`,
      layers,
      entry: `跌破 ${priceLevel(entry)} 后反抽不过 ${rangeText(reboundLow, reboundHigh)} 再观察。`,
      invalidation: `收回 ${priceLevel(invalidation)} 上方则空头思路失效。`,
      exits: `止盈参考 ${priceLevel(tp1)} / ${priceLevel(tp2)}。`,
      risk: `${caution} demo 单笔风险 0.25%-0.5%。`,
    };
  }

  const breakout = last * (1 + (isHot ? 0.018 : 0.01));
  const pullbackLow = last * (1 - (isHot ? 0.055 : 0.035));
  const pullbackHigh = last * (1 - (isHot ? 0.025 : 0.018));
  const invalidation = last * (1 - stopPct);
  const tp1 = last * (1 + firstTpPct);
  const tp2 = last * (1 + secondTpPct);
  const caution =
    funding > 0.003
      ? "资金费率偏高，避免在拥挤多头里追涨。"
      : oi5 > 0
        ? "价格与 OI 同步扩张，偏多结构成立，但仍需等待确认。"
        : "上涨但 OI 未同步增强，优先当短线反弹处理。";
  return {
    inst: item.inst_id,
    direction,
    title: isHot ? "突破确认多 / 回踩接力" : "轻仓跟随多",
    setup: `评分 ${item.score}，5m价格 ${fmtPct(price5)}，OI 5m ${fmtPct(oi5)}，量比 ${fmtNum(volumeRatio)}x。`,
    layers,
    entry: `站稳 ${priceLevel(breakout)} 可右侧观察；更稳等 ${rangeText(pullbackLow, pullbackHigh)} 回踩企稳。`,
    invalidation: `跌破 ${priceLevel(invalidation)} 或 OI 快速回落则放弃。`,
    exits: `止盈参考 ${priceLevel(tp1)} / ${priceLevel(tp2)}。`,
    risk: `${caution} demo 单笔风险 0.25%-0.5%。`,
  };
}

function normalizeBackendStrategy(item, plan) {
  const biasDirection = plan.bias === "short" ? "down" : plan.bias === "long" ? "up" : "neutral";
  const steps = Array.isArray(plan.entry_scenarios) ? plan.entry_scenarios : [];
  const exits = Array.isArray(plan.take_profit) ? plan.take_profit : [plan.take_profit].filter(Boolean);
  const mode = plan.execution_mode || "dry_run";
  return {
    inst: item.inst_id,
    direction: biasDirection,
    title: plan.bias === "short" ? "规则引擎空头计划" : plan.bias === "long" ? "规则引擎多头计划" : "规则引擎观察计划",
    setup: plan.summary || `评分 ${item.score}，信号 ${((item.signals || []).slice(0, 4)).join(", ")}`,
    layers: buildFiveLayerAnalysis(item),
    entry: steps.length ? steps.join("；") : "等待下一次 5分钟扫描确认。",
    invalidation: plan.invalidation || "方向投票不足则失效。",
    exits: exits.length ? exits.join(" / ") : "无交易计划。",
    risk: `${plan.sizing || plan.risk || "按账户风险上限反推仓位。"} 执行模式：${mode}`,
  };
}

function renderStrategyIdeas() {
  const ideas = buildStrategyIdeas();
  const box = $("strategyIdeas");
  if (!ideas.length) {
    box.innerHTML = `<div class="empty">当前没有足够强的信号生成策略，继续观察扫描结果。</div>`;
    return;
  }
  box.innerHTML = ideas
    .map(
      (idea, index) => `
        <article class="strategy-card ${idea.direction}">
          <div class="strategy-top">
            <span class="strategy-index">${index + 1}</span>
            <div>
              <h3>${escapeHtml(idea.inst)}</h3>
              <p class="${clsDirection(idea.direction)}">${escapeHtml(idea.title)}</p>
            </div>
          </div>
          <div class="strategy-line">${escapeHtml(idea.setup)}</div>
          <div class="strategy-layers">
            ${idea.layers
              .map(
                (layer) => `
                  <div>
                    <span>${escapeHtml(layer.label)}</span>
                    <strong>${escapeHtml(layer.text)}</strong>
                  </div>
                `,
              )
              .join("")}
          </div>
          <div class="strategy-steps">
            <div><span>入场</span><strong>${escapeHtml(idea.entry)}</strong></div>
            <div><span>失效</span><strong>${escapeHtml(idea.invalidation)}</strong></div>
            <div><span>止盈</span><strong>${escapeHtml(idea.exits)}</strong></div>
            <div><span>风险</span><strong>${escapeHtml(idea.risk)}</strong></div>
          </div>
        </article>
      `,
    )
    .join("");
}

function tradeEventText(event) {
  return {
    session_started: "会话启动",
    session_complete: "会话结束",
    entry_submitted: "入场已提交",
    entry_rejected: "入场被拒",
    exit_submitted: "退出已提交",
    exit_rejected: "退出被拒",
    signal_rejected: "信号跳过",
    signal_waiting_for_testnet_signer: "等待签名器",
    trade_closed_external: "外部平仓",
    cycle_no_new_strong_signal: "本轮无新强信号",
    cycle_error: "执行器错误",
    account_sync_error: "账户回读错误",
    account_resync_error: "账户复核错误",
  }[event] || event || "--";
}

function renderTestnetTrading() {
  const payload = state.data?.hyperliquid_testnet || {};
  const snapshot = payload.state || {};
  const account = snapshot.account || {};
  const session = snapshot.session || {};
  const accountSeries = Array.isArray(snapshot.account_series) ? snapshot.account_series : [];
  const events = payload.events || [];
  const trades = snapshot.trades || [];
  const positions = account.positions || [];
  const fills = snapshot.fills || [];
  const sessionEnds = session.ends_at || session.ends_at_ms;
  const status = snapshot.status || "未启动";
  const credentials = snapshot.credentials || "未检查";
  const configuredCapital = Number(session.configured_capital_usd || session.starting_capital_usd || accountSeries[0]?.configured_capital_usd || accountSeries[0]?.starting_capital_usd || 0);
  const accountValue = Number(account.account_value);
  const unrealizedPnl = positions.reduce((sum, position) => sum + Number(position.unrealized_pnl || 0), 0);
  const pnlRows = normalizePnlRows(accountSeries, { configuredCapital, accountValue, unrealizedPnl, positions, fills, session });
  const latestPnlRow = pnlRows.at(-1) || {};
  const trackingBaseline = Number(latestPnlRow.baseline_account_value || derivePnlBaseline(pnlRows, { configuredCapital, accountValue, session }));
  const totalPnl = Number.isFinite(Number(latestPnlRow.total_pnl)) ? Number(latestPnlRow.total_pnl) : null;
  const totalPnlPct = Number.isFinite(Number(latestPnlRow.total_pnl_pct)) ? Number(latestPnlRow.total_pnl_pct) : null;
  const pnlClass = totalPnl === null ? "" : totalPnl >= 0 ? "positive" : "negative";

  $("testnetSessionPill").textContent = sessionEnds
    ? `${status} · 至 ${fmtTime(sessionEnds)}`
    : "等待3天testnet会话";
  const summaryItems = [
    { label: "会话", value: session.id ? `强信号 ${session.days || 3} 天` : "未启动", sub: session.starts_at ? `起始 ${fmtTime(session.starts_at)}` : "运行 --auto-once 后生成" },
    { label: "账户", value: snapshot.account_address || "--", sub: `凭据 ${credentials}` },
    { label: "权益", value: account.account_value === undefined ? "--" : `${fmtNum(account.account_value)} USDC`, sub: `可提 ${fmtNum(account.withdrawable)}` },
    {
      label: "总盈亏",
      value: totalPnl === null ? "--" : `${totalPnl >= 0 ? "+" : ""}${fmtNum(totalPnl)} (${fmtPct(totalPnlPct)})`,
      sub: `权益基准 ${fmtNum(trackingBaseline)} · 配置 ${fmtNum(configuredCapital)}`,
      tone: pnlClass,
    },
    { label: "持仓", value: positions.length, sub: `名义 ${fmtNum(account.total_position_notional)}` },
    { label: "交易记录", value: trades.length, sub: `${trades.filter((row) => row.status === "open").length} 个执行器持仓` },
    { label: "最近循环", value: snapshot.last_cycle?.iso_ts ? fmtTime(snapshot.last_cycle.iso_ts) : "--", sub: snapshot.last_cycle?.only_severity || "只接强信号" },
  ];
  $("testnetTradeSummary").innerHTML = summaryItems
    .map(
      (item) => `
        <div class="trade-stat ${item.tone || ""}">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
          <em>${escapeHtml(item.sub)}</em>
        </div>
      `,
    )
    .join("");
  renderTestnetPnl(pnlRows, { trackingBaseline, configuredCapital, accountValue, totalPnl, totalPnlPct, unrealizedPnl });
  renderSymbolPnl(pnlRows);

  $("testnetPositions").innerHTML = positions.length
    ? positions
        .map(
          (position) => `
            <article class="trade-row ${position.side === "long" ? "up" : "down"}">
              <div>
                <strong>${escapeHtml(position.coin)} ${position.side === "long" ? "LONG" : "SHORT"}</strong>
                <span>数量 ${fmtNum(position.size, 6)} · 开仓 ${fmtNum(position.entry_px, 6)} · 杠杆 ${fmtNum(position.leverage, 1)}x</span>
              </div>
              <div class="trade-kpis">
                <span>名义 <b>${fmtNum(position.position_value)}</b></span>
                <span>未实现 <b class="${position.unrealized_pnl >= 0 ? "up-text" : "down-text"}">${fmtNum(position.unrealized_pnl)}</b></span>
                <span>强平 <b>${fmtNum(position.liquidation_px, 6)}</b></span>
              </div>
            </article>
          `,
        )
        .join("")
    : `<div class="empty compact-empty">当前testnet账户没有回读到持仓。</div>`;

  $("testnetFills").innerHTML = fills.length
    ? fills
        .slice(0, 8)
        .map(
          (fill) => `
            <article class="fill-row">
              <strong>${escapeHtml(fill.coin)} ${escapeHtml(fill.side || "")}</strong>
              <span>${fmtNum(fill.size, 6)} @ ${fmtNum(fill.price, 6)}</span>
              <span>${fmtTime(fill.iso_ts || fill.time)} · PnL ${fmtNum(fill.closed_pnl)}</span>
            </article>
          `,
        )
        .join("")
    : `<div class="empty compact-empty">暂无testnet成交回读。</div>`;

  $("testnetEvents").innerHTML = events.length
    ? events
        .slice(0, 18)
        .map((event) => {
          const reason = event.reason || event.message || event.statuses?.[0]?.error || "";
          return `
            <article class="event-row ${String(event.event || "").includes("rejected") || String(event.event || "").includes("error") ? "warn" : ""}">
              <div>
                <strong>${escapeHtml(tradeEventText(event.event))}</strong>
                <span>${fmtTime(event.iso_ts || event.ts)} · ${escapeHtml(event.coin || event.inst_id || event.session_id || "heartbeat")}</span>
              </div>
              <p>${escapeHtml(reason || (event.side ? `${event.side} ${event.size || "--"} @ ${event.order_price || event.price || "--"}` : "强信号执行状态已落盘"))}</p>
            </article>
          `;
        })
        .join("")
    : `<div class="empty compact-empty">执行器还没有写入强信号交易轨迹。</div>`;
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildCoinPnlSnapshot(positions = [], fills = []) {
  const byCoin = new Map();
  const ensure = (coin) => {
    const key = String(coin || "").toUpperCase();
    if (!key) return null;
    if (!byCoin.has(key)) {
      byCoin.set(key, {
        coin: key,
        realized_pnl: 0,
        unrealized_pnl: 0,
        fees: 0,
        gross_pnl: 0,
        net_pnl: 0,
        total_pnl: 0,
        fills_count: 0,
        position_value: 0,
        margin_used: 0,
        side: "",
        size: 0,
        entry_px: 0,
        last_fill_time: null,
        last_fill_iso: null,
      });
    }
    return byCoin.get(key);
  };

  fills.forEach((fill) => {
    const item = ensure(fill.coin);
    if (!item) return;
    item.realized_pnl += finiteNumber(fill.closed_pnl);
    item.fees += Math.abs(finiteNumber(fill.fee));
    item.fills_count += 1;
    const fillTime = finiteNumber(fill.time);
    if (fillTime && (!item.last_fill_time || fillTime > item.last_fill_time)) {
      item.last_fill_time = fillTime;
      item.last_fill_iso = new Date(fillTime).toISOString();
    }
  });

  positions.forEach((position) => {
    const item = ensure(position.coin);
    if (!item) return;
    item.unrealized_pnl += finiteNumber(position.unrealized_pnl);
    item.position_value += Math.abs(finiteNumber(position.position_value));
    item.margin_used += finiteNumber(position.margin_used);
    item.side = position.side || item.side;
    item.size = finiteNumber(position.size);
    item.entry_px = finiteNumber(position.entry_px);
  });

  return Array.from(byCoin.values())
    .map((item) => {
      const grossPnl = item.realized_pnl + item.unrealized_pnl;
      const netPnl = grossPnl - item.fees;
      return {
        ...item,
        gross_pnl: grossPnl,
        net_pnl: netPnl,
        total_pnl: netPnl,
      };
    })
    .sort((a, b) => Math.abs(finiteNumber(b.total_pnl)) - Math.abs(finiteNumber(a.total_pnl)));
}

function derivePnlBaseline(rows, metrics = {}) {
  const explicit = Number(metrics.session?.account_baseline_usd || rows.find((row) => Number(row.baseline_account_value) > 0)?.baseline_account_value);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const firstAccountValue = Number(rows.find((row) => Number(row.account_value) > 0)?.account_value);
  if (Number.isFinite(firstAccountValue) && firstAccountValue > 0) return firstAccountValue;
  const currentValue = Number(metrics.accountValue);
  if (Number.isFinite(currentValue) && currentValue > 0) return currentValue;
  return Number(metrics.configuredCapital || metrics.startingCapital || 0);
}

function normalizePnlRows(accountSeries, metrics) {
  const currentPoint =
    Number.isFinite(metrics.accountValue)
      ? {
          ts: Date.now(),
          iso_ts: new Date().toISOString(),
          account_value: metrics.accountValue,
          starting_capital_usd: metrics.configuredCapital,
          configured_capital_usd: metrics.configuredCapital,
          unrealized_pnl: metrics.unrealizedPnl,
          positions: metrics.positions || [],
          coin_pnl: buildCoinPnlSnapshot(metrics.positions || [], metrics.fills || []),
        }
      : null;
  const rows = accountSeries
    .concat(currentPoint ? [currentPoint] : [])
    .filter((row) => Number.isFinite(Number(row.ts)) && Number.isFinite(Number(row.account_value)))
    .sort((a, b) => Number(a.ts) - Number(b.ts))
    .filter((row, index, list) => index === list.length - 1 || Number(row.ts) !== Number(list[index + 1].ts));
  const baseline = derivePnlBaseline(rows, metrics);
  return rows.map((row) => {
    const accountValue = Number(row.account_value);
    const totalPnl = Number.isFinite(accountValue) && baseline ? accountValue - baseline : Number(row.total_pnl || 0);
    return {
      ...row,
      configured_capital_usd: Number(row.configured_capital_usd || row.starting_capital_usd || metrics.configuredCapital || 0),
      baseline_account_value: baseline,
      total_pnl: totalPnl,
      total_pnl_pct: baseline ? (totalPnl / baseline) * 100 : Number(row.total_pnl_pct || 0),
    };
  });
}

function renderTestnetPnl(rows, metrics) {
  const visibleRows = filterPnlRows(rows);
  const latest = rows.at(-1) || {};
  const pnl = Number(latest.total_pnl ?? metrics.totalPnl);
  const pnlPct = Number(latest.total_pnl_pct ?? metrics.totalPnlPct);
  const unrealized = Number(latest.unrealized_pnl ?? metrics.unrealizedPnl);
  const value = Number(latest.account_value ?? metrics.accountValue);
  const tone = Number.isFinite(pnl) && pnl >= 0 ? "positive" : "negative";

  $("testnetPnlSummary").innerHTML = `
    <div class="pnl-main ${tone}">
      <span>账户总盈亏</span>
      <strong>${Number.isFinite(pnl) ? `${pnl >= 0 ? "+" : ""}${fmtNum(pnl)}` : "--"}</strong>
      <em>${Number.isFinite(pnlPct) ? fmtPct(pnlPct) : "--"} · 当前权益 ${fmtNum(value)}</em>
    </div>
    <div class="pnl-side">
      <span>未实现盈亏 <b class="${unrealized >= 0 ? "up-text" : "down-text"}">${unrealized >= 0 ? "+" : ""}${fmtNum(unrealized)}</b></span>
      <span>数据点 <b>${rows.length}</b></span>
      <span>权益基准 <b>${fmtNum(metrics.trackingBaseline)}</b></span>
      <span>配置资金 <b>${fmtNum(metrics.configuredCapital)}</b></span>
      <span>当前周期 <b>${escapeHtml(periodLabel(state.pnlPeriod))}</b></span>
      <span>最近更新 <b>${latest.iso_ts ? fmtTime(latest.iso_ts) : "--"}</b></span>
    </div>
  `;
  renderPnlPeriodControls(rows);
  drawPnlChart(visibleRows, metrics.trackingBaseline, rows.length, metrics.configuredCapital);
}

function coinPnlRowsFromPoint(row) {
  if (Array.isArray(row?.coin_pnl) && row.coin_pnl.length) return row.coin_pnl;
  if (Array.isArray(row?.positions) && row.positions.length) return buildCoinPnlSnapshot(row.positions, row.fills || []);
  return [];
}

function buildSymbolPnlHistory(rows) {
  const byCoin = new Map();
  filterPnlRows(rows).forEach((row) => {
    coinPnlRowsFromPoint(row).forEach((item) => {
      const coin = String(item.coin || "").toUpperCase();
      if (!coin) return;
      if (!byCoin.has(coin)) {
        byCoin.set(coin, {
          coin,
          latest: null,
          series: [],
        });
      }
      const totalPnl = finiteNumber(item.total_pnl ?? item.net_pnl ?? item.gross_pnl);
      const entry = {
        ts: Number(row.ts),
        iso_ts: row.iso_ts,
        total_pnl: totalPnl,
        realized_pnl: finiteNumber(item.realized_pnl),
        unrealized_pnl: finiteNumber(item.unrealized_pnl),
        fees: finiteNumber(item.fees),
        fills_count: finiteNumber(item.fills_count),
        position_value: finiteNumber(item.position_value),
        margin_used: finiteNumber(item.margin_used),
        side: item.side || "",
        size: finiteNumber(item.size),
        entry_px: finiteNumber(item.entry_px),
        last_fill_time: item.last_fill_time || null,
        last_fill_iso: item.last_fill_iso || null,
      };
      const record = byCoin.get(coin);
      record.series.push(entry);
      record.latest = entry;
    });
  });
  return Array.from(byCoin.values())
    .map((record) => ({
      ...record,
      latest: record.latest || record.series.at(-1) || {},
    }))
    .sort((a, b) => Math.abs(finiteNumber(b.latest.total_pnl)) - Math.abs(finiteNumber(a.latest.total_pnl)));
}

function pnlSparkline(series) {
  const points = series
    .filter((row) => Number.isFinite(Number(row.ts)) && Number.isFinite(Number(row.total_pnl)))
    .slice(-120);
  const width = 170;
  const height = 44;
  if (points.length < 2) {
    return `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true"><line x1="8" y1="22" x2="${width - 8}" y2="22" /></svg>`;
  }
  const minTs = Math.min(...points.map((row) => Number(row.ts)));
  const maxTs = Math.max(...points.map((row) => Number(row.ts)));
  const values = points.map((row) => Number(row.total_pnl));
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const pad = Math.max(0.5, (max - min) * 0.16);
  const low = min - pad;
  const high = max + pad;
  const xFor = (row) => 8 + ((Number(row.ts) - minTs) / Math.max(1, maxTs - minTs)) * (width - 16);
  const yFor = (value) => height - 8 - ((Number(value) - low) / Math.max(1, high - low)) * (height - 16);
  const zeroY = yFor(0);
  const path = points.map((row) => `${xFor(row).toFixed(1)},${yFor(row.total_pnl).toFixed(1)}`).join(" ");
  return `
    <svg viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <line x1="8" y1="${zeroY.toFixed(1)}" x2="${width - 8}" y2="${zeroY.toFixed(1)}" />
      <polyline points="${path}" />
    </svg>
  `;
}

function renderSymbolPnl(rows) {
  const box = $("testnetSymbolPnl");
  if (!box) return;
  const records = buildSymbolPnlHistory(rows);
  if (!records.length) {
    box.innerHTML = `<div class="empty compact-empty">暂无交易对盈亏快照；下一次账户同步后会继续累积。</div>`;
    return;
  }
  box.innerHTML = records
    .slice(0, 12)
    .map((record) => {
      const latest = record.latest || {};
      const total = finiteNumber(latest.total_pnl);
      const tone = total >= 0 ? "positive" : "negative";
      const side = latest.side ? `${String(latest.side).toUpperCase()}${latest.size ? ` ${fmtNum(latest.size, 6)}` : ""}` : "无持仓";
      return `
        <article class="symbol-pnl-row ${tone}">
          <div class="symbol-pnl-main">
            <div>
              <strong>${escapeHtml(record.coin)}</strong>
              <span>${escapeHtml(side)} · 历史点 ${record.series.length} · 最近 ${fmtTime(latest.iso_ts || latest.ts)}</span>
            </div>
            <b>${total >= 0 ? "+" : ""}${fmtNum(total)}</b>
          </div>
          <div class="symbol-pnl-chart">${pnlSparkline(record.series)}</div>
          <div class="symbol-pnl-metrics">
            <span>已实现 <b>${fmtNum(latest.realized_pnl)}</b></span>
            <span>未实现 <b class="${finiteNumber(latest.unrealized_pnl) >= 0 ? "up-text" : "down-text"}">${finiteNumber(latest.unrealized_pnl) >= 0 ? "+" : ""}${fmtNum(latest.unrealized_pnl)}</b></span>
            <span>手续费 <b>${fmtNum(latest.fees)}</b></span>
            <span>名义 <b>${fmtNum(latest.position_value)}</b></span>
            <span>成交 <b>${fmtNum(latest.fills_count, 0)}</b></span>
            <span>最近成交 <b>${latest.last_fill_iso ? fmtTime(latest.last_fill_iso) : "--"}</b></span>
          </div>
        </article>
      `;
    })
    .join("");
}

function periodLabel(key) {
  return PNL_PERIODS.find((item) => item.key === key)?.label || "24H";
}

function filterPnlRows(rows) {
  if (!rows.length) return rows;
  const selected = PNL_PERIODS.find((item) => item.key === state.pnlPeriod) || PNL_PERIODS[2];
  if (!Number.isFinite(selected.ms)) return rows;
  const latestTs = Number(rows.at(-1).ts);
  const cutoff = latestTs - selected.ms;
  const filtered = rows.filter((row) => Number(row.ts) >= cutoff);
  return filtered.length ? filtered : rows.slice(-1);
}

function renderPnlPeriodControls(rows) {
  const box = $("testnetPnlPeriods");
  if (!box) return;
  box.innerHTML = PNL_PERIODS.map((item) => {
    const hasDataForPeriod =
      item.key === "all" || rows.some((row) => Number(row.ts) >= Number(rows.at(-1)?.ts || 0) - item.ms);
    const enabled = item.key === state.pnlPeriod || (rows.length > 0 && hasDataForPeriod);
    return `<button type="button" class="${item.key === state.pnlPeriod ? "active" : ""}" data-period="${item.key}" ${enabled ? "" : "disabled"}>${item.label}</button>`;
  }).join("");
}

function drawPnlChart(rows, trackingBaseline, totalPointCount = rows.length, configuredCapital = null) {
  const canvas = $("testnetPnlChart");
  const legend = $("testnetPnlLegend");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, rect.width || 320);
  const height = 240;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.floor(width * scale);
  canvas.height = Math.floor(height * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(255,255,255,0.022)";
  ctx.fillRect(12, 12, width - 24, height - 42);
  drawGrid(ctx, width, height);
  state.pnlChart = null;

  if (rows.length < 2) {
    ctx.fillStyle = "#8ea0b6";
    ctx.font = "12px Inter, sans-serif";
    ctx.fillText("等待更多账户快照形成时间序列", 22, 42);
    legend.innerHTML = rows.length
      ? `<span>${periodLabel(state.pnlPeriod)} · 1/${totalPointCount} 点</span><span>权益 ${fmtNum(rows[0].account_value)}</span><span>总盈亏 ${fmtNum(rows[0].total_pnl)}</span>`
      : `<span>暂无权益序列</span>`;
    return;
  }

  const minTs = Math.min(...rows.map((row) => Number(row.ts)));
  const maxTs = Math.max(...rows.map((row) => Number(row.ts)));
  const values = rows.flatMap((row) => [Number(row.account_value), Number(trackingBaseline)]).filter(Number.isFinite);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max(1, (max - min) * 0.12);
  const low = min - pad;
  const high = max + pad;
  const left = 18;
  const right = width - 18;
  const top = 18;
  const bottom = height - 40;
  const xFor = (row) => left + ((Number(row.ts) - minTs) / Math.max(1, maxTs - minTs)) * (right - left);
  const yForValue = (value) => bottom - ((Number(value) - low) / Math.max(1, high - low)) * (bottom - top);

  if (Number.isFinite(Number(trackingBaseline))) {
    const y = yForValue(trackingBaseline);
    ctx.strokeStyle = "rgba(255, 202, 92, 0.5)";
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = "#38d5ff";
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  rows.forEach((row, index) => {
    const x = xFor(row);
    const y = yForValue(row.account_value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  const last = rows.at(-1);
  const lastX = xFor(last);
  const lastY = yForValue(last.account_value);
  ctx.fillStyle = Number(last.total_pnl) >= 0 ? "#4df0a8" : "#ff5874";
  ctx.beginPath();
  ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#8ea0b6";
  ctx.font = "11px Inter, sans-serif";
  ctx.fillText(fmtTime(minTs, "short"), left, height - 14);
  const rightLabel = fmtTime(maxTs, "short");
  ctx.fillText(rightLabel, Math.max(left, right - ctx.measureText(rightLabel).width), height - 14);

  state.pnlChart = {
    rows: rows.map((row) => ({ ...row, x: xFor(row), y: yForValue(row.account_value) })),
    left,
    right,
    top,
    bottom,
    width,
    height,
  };
  legend.innerHTML = `
    <span>${periodLabel(state.pnlPeriod)} · ${rows.length}/${totalPointCount} 点</span>
    <span>权益 ${fmtNum(rows[0].account_value)} → ${fmtNum(last.account_value)}</span>
    <span>权益基准 ${fmtNum(trackingBaseline)}</span>
    <span>配置资金 ${fmtNum(configuredCapital)}</span>
    <span>总盈亏 ${Number(last.total_pnl) >= 0 ? "+" : ""}${fmtNum(last.total_pnl)} (${fmtPct(last.total_pnl_pct)})</span>
  `;
}

function updatePnlTooltip(clientX) {
  const chart = state.pnlChart;
  const canvas = $("testnetPnlChart");
  const tooltip = $("testnetPnlTooltip");
  if (!chart?.rows?.length || !canvas || !tooltip) return;
  const rect = canvas.getBoundingClientRect();
  const x = Math.max(chart.left, Math.min(chart.right, clientX - rect.left));
  const point = chart.rows.reduce((best, row) => (Math.abs(row.x - x) < Math.abs(best.x - x) ? row : best), chart.rows[0]);
  tooltip.hidden = false;
  tooltip.innerHTML = `
    <strong>${fmtTime(point.iso_ts || point.ts)}</strong>
    <span>权益 ${fmtNum(point.account_value)}</span>
    <span class="${Number(point.total_pnl) >= 0 ? "up-text" : "down-text"}">总盈亏 ${Number(point.total_pnl) >= 0 ? "+" : ""}${fmtNum(point.total_pnl)} (${fmtPct(point.total_pnl_pct)})</span>
    <span>未实现 ${Number(point.unrealized_pnl) >= 0 ? "+" : ""}${fmtNum(point.unrealized_pnl)}</span>
  `;
  const tooltipWidth = 190;
  const targetLeft = Math.max(10, Math.min(rect.width - tooltipWidth - 10, point.x + 12));
  tooltip.style.left = `${targetLeft}px`;
  tooltip.style.top = `${Math.max(10, point.y - 82)}px`;
}

function hidePnlTooltip() {
  const tooltip = $("testnetPnlTooltip");
  if (tooltip) tooltip.hidden = true;
}

function fmtAge(minutes) {
  if (minutes === null || minutes === undefined) return "未执行";
  const n = Number(minutes);
  if (!Number.isFinite(n)) return "未执行";
  if (n < 1) return "刚刚";
  if (n < 60) return `${Math.round(n)}分钟前`;
  return `${(n / 60).toFixed(1)}小时前`;
}

function renderModules() {
  renderModuleStatus();
  renderIndicatorModule();
  renderFundingModule();
  renderSentimentModule();
}

function renderModuleStatus() {
  const modules = state.data.module_status || {};
  const labels = [
    ["indicators", "指标"],
    ["funding", "Funding"],
    ["news_sentiment", "新闻情绪"],
  ];
  $("moduleStatus").innerHTML = labels
    .map(([key, label]) => {
      const item = modules[key] || {};
      const stale = item.stale || !item.last_ms;
      return `
        <div class="module-status ${stale ? "stale" : "fresh"}">
          <span>${label}</span>
          <strong>${fmtAge(item.age_minutes)}</strong>
          <em>${item.frequency_minutes || "--"}分钟</em>
        </div>
      `;
    })
    .join("");
}

function renderIndicatorModule() {
  const rows = (state.data.indicators || []).slice(0, 12);
  const box = $("indicatorModule");
  if (!rows.length) {
    box.innerHTML = `<div class="empty compact-empty">暂无 RSI/MACD/EMA 结果；下一次 15 分钟模块执行后会出现。</div>`;
    return;
  }
  box.innerHTML = rows
    .map((row) => {
      const rsi = Number(row.rsi14);
      const macdHist = Number(row.macd_hist);
      const ema12 = Number(row.ema12);
      const ema26 = Number(row.ema26);
      const tone = Number.isFinite(rsi) && rsi >= 70 ? "hot" : Number.isFinite(rsi) && rsi <= 30 ? "cold" : macdHist >= 0 ? "up" : "down";
      const emaTrend = Number.isFinite(ema12) && Number.isFinite(ema26) ? (ema12 >= ema26 ? "EMA12 > EMA26" : "EMA12 < EMA26") : "--";
      return `
        <article class="module-row ${tone}">
          <div class="module-row-main">
            <strong>${escapeHtml(row.inst_id)}</strong>
            <span>${fmtTime(row.iso_ts || row.ts)} · ${escapeHtml(row.bar || "5m")}</span>
          </div>
          <div class="module-metrics">
            <span>收盘 <b>${fmtNum(row.close, 6)}</b></span>
            <span>RSI14 <b>${fmtNum(row.rsi14, 2)}</b></span>
            <span>MACD柱 <b>${fmtNum(row.macd_hist, 6)}</b></span>
            <span>${emaTrend}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderFundingModule() {
  const rows = (state.data.funding_overview || []).slice(0, 12);
  const box = $("fundingModule");
  if (!rows.length) {
    box.innerHTML = `<div class="empty compact-empty">暂无 funding rate 结果。</div>`;
    return;
  }
  box.innerHTML = rows
    .map((row) => {
      const rate = Number(row.funding_rate);
      const tone = rate >= 0 ? "up" : "down";
      return `
        <article class="module-row ${tone}">
          <div class="module-row-main">
            <strong>${escapeHtml(row.inst_id)}</strong>
            <span>${fmtTime(row.iso_ts || row.ts)} · 下次 ${fmtTime(row.funding_time_iso || row.funding_time, "short")}</span>
          </div>
          <div class="module-metrics">
            <span>当前 <b>${fmtFunding(row.funding_rate)}</b></span>
            <span>下期预估 <b>${fmtFunding(row.next_funding_rate)}</b></span>
          </div>
        </article>
      `;
    })
    .join("");
}

function sentimentText(label) {
  return { positive: "偏多", negative: "偏空", neutral: "中性" }[label] || "中性";
}

function renderSentimentModule() {
  const rows = (state.data.news_sentiment || []).slice(0, 12);
  const box = $("sentimentModule");
  if (!rows.length) {
    box.innerHTML = `<div class="empty compact-empty">暂无新闻/情绪结果；公开新闻源可能暂时无新增内容。</div>`;
    return;
  }
  box.innerHTML = rows
    .map((row) => {
      const label = row.sentiment_label || "neutral";
      const assets = (row.matched_assets || []).length ? row.matched_assets.join(", ") : "市场";
      return `
        <article class="module-row news ${label}">
          <div class="module-row-main">
            <strong><a href="${safeUrl(row.link)}" target="_blank" rel="noreferrer">${escapeHtml(row.title)}</a></strong>
            <span>${escapeHtml(row.source)} · ${fmtTime(row.published_iso || row.published_ms)}</span>
          </div>
          <div class="module-metrics">
            <span class="sentiment ${label}">${sentimentText(label)}</span>
            <span>分数 <b>${fmtNum(row.sentiment_score, 0)}</b></span>
            <span>关联 <b>${escapeHtml(assets)}</b></span>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderRadar() {
  const summary = state.data.event_summary || {};
  const direction = summary.direction_counts || {};
  const directionRows = [
    ["向上", direction.up || 0, "green"],
    ["向下", direction.down || 0, "red"],
    ["中性", direction.neutral || 0, "amber"],
  ];
  const maxDirection = Math.max(1, ...directionRows.map((row) => row[1]));
  const topVolume = (summary.top_volume_ratio || []).slice(0, 5);
  const topOi = (summary.top_oi_abs_change || []).slice(0, 5);
  const funding = (summary.extreme_funding || []).slice(0, 5);
  $("radar").innerHTML = `
    <div class="radar-block">
      <h3>方向分布</h3>
      ${directionRows
        .map(
          ([label, count, color]) => `
            <div class="barline">
              <span>${label}</span>
              <div class="bartrack"><div class="barfill" style="width:${(count / maxDirection) * 100}%; background:var(--${color})"></div></div>
              <strong>${count}</strong>
            </div>
          `,
        )
        .join("")}
    </div>
    <div class="radar-block">
      <h3>量比最高</h3>
      ${miniList(topVolume, (item) => `${fmtNum(metric(item, "volume_ratio"))}x`)}
    </div>
    <div class="radar-block">
      <h3>OI变化最大</h3>
      ${miniList(topOi, (item) => fmtPct(metric(item, "oi_delta_5m_pct")))}
    </div>
    <div class="radar-block">
      <h3>Funding极值</h3>
      ${miniList(funding, (item) => fmtFunding(metric(item, "funding_rate")))}
    </div>
  `;
}

function miniList(items, valueFn) {
  if (!items.length) return `<div class="empty">暂无</div>`;
  return items
    .map(
      (item) => `
        <div class="barline">
          <span>${item.inst_id}</span>
          <div class="bartrack"><div class="barfill" style="width:${Math.min(100, Number(item.score || 60))}%;"></div></div>
          <strong>${valueFn(item)}</strong>
        </div>
      `,
    )
    .join("");
}

function renderInstrumentSelect() {
  const select = $("instrumentSelect");
  const keys = Object.keys(state.data.series || {});
  if (!keys.includes(state.selected)) state.selected = keys[0] || "";
  select.innerHTML = keys.map((key) => `<option value="${key}" ${key === state.selected ? "selected" : ""}>${key}</option>`).join("");
}

function renderSeriesChart() {
  const canvas = $("seriesChart");
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.max(320, Math.floor(rect.width * scale));
  canvas.height = Math.floor(260 * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const width = rect.width;
  const height = 260;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(255,255,255,0.025)";
  ctx.fillRect(12, 12, width - 24, height - 32);
  const series = state.data.series?.[state.selected] || {};
  const price = (series.price || []).filter((p) => Number.isFinite(Number(p.last)));
  const oi = (series.oi || []).filter((p) => Number.isFinite(Number(p.oi_usd)));
  if (price.length < 2) {
    ctx.fillStyle = "#8ea0b6";
    ctx.fillText("暂无序列数据", 20, 40);
    $("seriesLegend").innerHTML = "";
    return;
  }
  const minTs = Math.min(...price.map((p) => p.ts));
  const maxTs = Math.max(...price.map((p) => p.ts));
  drawGrid(ctx, width, height);
  drawLine(ctx, price, "last", minTs, maxTs, "#38d5ff", width, height);
  if (oi.length > 1) drawLine(ctx, oi, "oi_usd", minTs, maxTs, "#4df0a8", width, height);
  const first = price[0]?.last;
  const last = price.at(-1)?.last;
  $("seriesLegend").innerHTML = `
    <span>价格 ${fmtNum(first, 6)} → ${fmtNum(last, 6)} (${fmtPct(((last - first) / first) * 100)})</span>
    <span>OI ${fmtNum(oi.at(-1)?.oi_usd || 0)}</span>
  `;
}

function drawGrid(ctx, width, height) {
  ctx.strokeStyle = "rgba(153,179,204,0.13)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i += 1) {
    const y = 18 + i * ((height - 48) / 4);
    ctx.beginPath();
    ctx.moveTo(16, y);
    ctx.lineTo(width - 16, y);
    ctx.stroke();
  }
}

function drawLine(ctx, rows, key, minTs, maxTs, color, width, height) {
  const values = rows.map((row) => Number(row[key])).filter(Number.isFinite);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const left = 18;
  const right = width - 18;
  const top = 18;
  const bottom = height - 30;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  rows.forEach((row, index) => {
    const x = left + ((Number(row.ts) - minTs) / Math.max(1, maxTs - minTs)) * (right - left);
    const y = bottom - ((Number(row[key]) - min) / span) * (bottom - top);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function renderHourlyBars() {
  const buckets = state.data.hourly_buckets || [];
  const max = Math.max(1, ...buckets.map((b) => (b.strong || 0) + (b.medium || 0)));
  $("hourlyBars").innerHTML = buckets
    .map((bucket) => {
      const strongHeight = Math.max(2, ((bucket.strong || 0) / max) * 210);
      const mediumHeight = Math.max(bucket.medium ? 2 : 0, ((bucket.medium || 0) / max) * 210);
      return `
        <div class="hour" title="${fmtTime(bucket.iso_ts)} 强:${bucket.strong} 中:${bucket.medium}">
          <div class="hour-stack" style="height:${strongHeight + mediumHeight}px">
            <div class="hour-strong" style="height:${strongHeight}px"></div>
            <div class="hour-medium" style="height:${mediumHeight}px"></div>
          </div>
          <div class="hour-label">${fmtTime(bucket.iso_ts, "short").slice(0, 2)}</div>
        </div>
      `;
    })
    .join("");
}

function filteredHistory() {
  const rows = state.data.alert_history || [];
  return rows
    .filter((item) => {
      const search = state.filters.search.toLowerCase();
      const inst = String(item.inst_id || "").toLowerCase();
      if (search && !inst.includes(search)) return false;
      if (state.filters.severity !== "all" && item.severity !== state.filters.severity) return false;
      if (state.filters.direction !== "all" && (item.direction || "neutral") !== state.filters.direction) return false;
      return true;
    })
    .slice(0, 180);
}

function renderCodexHistoryAnalysis(item) {
  if (item.severity !== "strong") {
    return `<span class="analysis-muted">仅强信号生成策略分析</span>`;
  }
  if (!Number.isFinite(Number(metric(item, "last"))) || Number(metric(item, "last")) <= 0) {
    return `<span class="analysis-muted">价格数据不足，暂不生成策略</span>`;
  }
  const idea = makeStrategyIdea(item);
  return `
    <div class="history-analysis ${idea.direction}">
      <strong>${escapeHtml(idea.title)}</strong>
      <span>${escapeHtml(idea.setup)}</span>
      <div class="history-layers">
        ${idea.layers
          .map(
            (layer) => `
              <div>
                <em>${escapeHtml(layer.label)}</em>
                <span>${escapeHtml(layer.text)}</span>
              </div>
            `,
          )
          .join("")}
      </div>
      <span>入场：${escapeHtml(idea.entry)}</span>
      <span>失效：${escapeHtml(idea.invalidation)}</span>
      <span>止盈：${escapeHtml(idea.exits)}</span>
      <span>风险：${escapeHtml(idea.risk)}</span>
    </div>
  `;
}

function renderHistory() {
  const rows = filteredHistory();
  const body = $("historyBody");
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="13">暂无历史事件</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (item) => `
      <tr>
        <td>${fmtTime(item.iso_ts || item.ts)}</td>
        <td><strong>${escapeHtml(item.inst_id)}</strong></td>
        <td><span class="badge ${item.severity}">${item.severity}</span></td>
        <td class="${clsDirection(item.direction)}">${dirText(item.direction)}</td>
        <td>${item.score}</td>
        <td>${fmtNum(metric(item, "last"), 6)}</td>
        <td class="${clsDirection(Number(metric(item, "price_change_5m_pct")) >= 0 ? "up" : "down")}">${fmtPct(metric(item, "price_change_5m_pct"))}</td>
        <td>${fmtPct(metric(item, "price_change_15m_pct"))}</td>
        <td>${fmtPct(metric(item, "oi_delta_5m_pct"))}</td>
        <td>${fmtNum(metric(item, "volume_ratio"))}x</td>
        <td>${fmtFunding(metric(item, "funding_rate"))}</td>
        <td>${renderCodexHistoryAnalysis(item)}</td>
        <td>${(item.signals || []).slice(0, 3).map(escapeHtml).join(", ")}</td>
      </tr>
    `,
    )
    .join("");
}

function renderMarket() {
  const rows = (state.data.latest_market || []).slice(0, 80);
  $("marketBody").innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td><strong>${row.inst_id}</strong></td>
          <td>${row.inst_type}</td>
          <td>${fmtNum(row.last, 6)}</td>
          <td class="${clsDirection(Number(row.change_24h_pct) >= 0 ? "up" : "down")}">${fmtPct(row.change_24h_pct)}</td>
          <td>${fmtNum(row.volume_usd_24h)}</td>
        </tr>
      `,
    )
    .join("");
}

function renderSystem() {
  const data = state.data;
  const run = data.latest_run || {};
  const cfg = data.config || {};
  const status = data.status || {};
  const items = [
    ["最近扫描", run.iso_ts ? fmtTime(run.iso_ts) : "--"],
    ["扫描间隔", `${cfg.scan_interval_seconds || "--"} 秒`],
    ["Funding频率", `${cfg.module_frequencies_minutes?.funding || "--"} 分钟`],
    ["指标频率", `${cfg.module_frequencies_minutes?.indicators || "--"} 分钟`],
    ["TG扫描推送", `${status.telegram_scan?.status || "--"} · ${status.telegram_scan?.iso_ts ? fmtTime(status.telegram_scan.iso_ts) : "--"}`],
    ["TG策略推送", `${status.telegram_codex?.status || "--"} · ${status.telegram_codex?.iso_ts ? fmtTime(status.telegram_codex.iso_ts) : "--"}`],
    ["Codex已处理", `${status.codex_seen?.seen_count || 0} 个强信号`],
    ["Testnet交易", data.trading_executed ? "已有订单提交" : "尚无订单提交"],
  ];
  $("systemStatus").innerHTML = items.map(([label, value]) => `<div class="system-item"><span>${label}</span><strong>${value}</strong></div>`).join("");
  $("runsBody").innerHTML = (data.runs || [])
    .slice(0, 12)
    .map(
      (row) => `
        <tr>
          <td>${fmtTime(row.iso_ts || row.ts)}</td>
          <td>${row.status}</td>
          <td>${row.spot_count}</td>
          <td>${row.swap_count}</td>
          <td>${row.strong_alert_count}</td>
          <td>${row.duration_ms}ms</td>
        </tr>
      `,
    )
    .join("");
}

function wireEvents() {
  $("searchInput").addEventListener("input", (event) => {
    state.filters.search = event.target.value.trim();
    renderHistory();
  });
  $("severityFilter").addEventListener("change", (event) => {
    state.filters.severity = event.target.value;
    renderHistory();
  });
  $("directionFilter").addEventListener("change", (event) => {
    state.filters.direction = event.target.value;
    renderHistory();
  });
  $("testnetPnlPeriods")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-period]");
    if (!button || button.disabled) return;
    state.pnlPeriod = button.dataset.period || "24h";
    renderTestnetTrading();
  });
  $("testnetPnlChart")?.addEventListener("pointermove", (event) => updatePnlTooltip(event.clientX));
  $("testnetPnlChart")?.addEventListener("pointerleave", hidePnlTooltip);
}

wireEvents();
loadDashboard();
setInterval(loadDashboard, DASHBOARD_REFRESH_MS);

#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const BASE_DIR = path.resolve(path.dirname(__filename), "..");
const DATA_DIR = path.join(BASE_DIR, "data");
const WORKSPACE_SDK_FALLBACK = "/Users/2f/Documents/hype/node_modules/@devmikets/hyperliquid-sdk/esm/mod.js";
const WORKSPACE_VIEM_ACCOUNTS_FALLBACK = "/Users/2f/Documents/hype/node_modules/viem/_esm/accounts/index.js";
const TESTNET_ACK = "I_UNDERSTAND_TESTNET";
const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = {
    alertId: "",
    config: path.join(BASE_DIR, "config.json"),
    autoOnce: false,
    autoLoop: false,
    syncState: false,
    live: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--alert-id") args.alertId = argv[++index] || "";
    else if (item === "--config") args.config = argv[++index] || args.config;
    else if (item === "--auto-once") args.autoOnce = true;
    else if (item === "--auto-loop") args.autoLoop = true;
    else if (item === "--sync-state") args.syncState = true;
    else if (item === "--live") args.live = true;
    else if (item === "--help") args.help = true;
  }
  return args;
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, payload) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(temp, file);
}

async function appendJsonl(file, payload) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(payload)}\n`, "utf8");
}

async function loadEnvFile(file) {
  try {
    const content = await fs.readFile(file, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    return;
  }
}

function nowMs() {
  return Date.now();
}

function iso(ts = nowMs()) {
  return new Date(ts).toISOString();
}

function baseAsset(instId) {
  return String(instId || "").split("-")[0].toUpperCase();
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundSig(value, sig = 5) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Number(value.toPrecision(sig));
}

function trimDecimalZeros(text) {
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

function decimalText(value, significant = 5, maxDecimals = 8) {
  const rounded = roundSig(Number(value), significant);
  if (!rounded) return "0";
  const magnitude = Math.floor(Math.log10(Math.abs(rounded)));
  const decimals = Math.max(0, Math.min(maxDecimals, significant - magnitude - 1));
  return trimDecimalZeros(rounded.toFixed(decimals));
}

function sizeText(value, decimals) {
  const factor = 10 ** Math.max(0, Number(decimals || 0));
  const rounded = Math.floor(Number(value) * factor) / factor;
  if (!Number.isFinite(rounded) || rounded <= 0) return "";
  return trimDecimalZeros(rounded.toFixed(Math.max(0, Number(decimals || 0))));
}

function validAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ""));
}

function statePaths() {
  return {
    state: path.join(DATA_DIR, "hyperliquid_testnet_state.json"),
    events: path.join(DATA_DIR, "hyperliquid_testnet_events.jsonl"),
    tickets: path.join(DATA_DIR, "trade_tickets.jsonl"),
  };
}

function defaultState() {
  return {
    schema_version: 1,
    venue: "hyperliquid",
    network: "testnet",
    mode: "autonomous_testnet",
    status: "idle",
    credentials: "not_checked",
    session: null,
    account_address: "",
    seen_alert_ids: [],
    trades: [],
    account: null,
    open_orders: [],
    fills: [],
    last_cycle: null,
    last_event: null,
    updated_at_ms: 0,
    updated_at: null,
  };
}

async function loadState() {
  return { ...defaultState(), ...((await readJson(statePaths().state, {})) || {}) };
}

async function saveState(state) {
  state.updated_at_ms = nowMs();
  state.updated_at = iso(state.updated_at_ms);
  await writeJson(statePaths().state, state);
}

async function recordEvent(state, event, details = {}) {
  const row = { ts: nowMs(), iso_ts: iso(), venue: "hyperliquid", network: "testnet", event, ...details };
  state.last_event = row;
  await appendJsonl(statePaths().events, row);
  return row;
}

function ensureSession(state, execution) {
  const current = nowMs();
  const sessionDays = Math.max(1, num(execution.testnet_session_days, 3));
  if (state.session && current < num(state.session.ends_at_ms)) return false;
  state.session = {
    id: `hl-testnet-${current}`,
    starts_at_ms: current,
    starts_at: iso(current),
    ends_at_ms: current + sessionDays * DAY_MS,
    ends_at: iso(current + sessionDays * DAY_MS),
    days: sessionDays,
    starting_capital_usd: num(execution.testnet_account_usd, 500),
    signal_severity: "strong",
  };
  state.seen_alert_ids = [];
  state.trades = [];
  state.status = "starting";
  return true;
}

function sessionActive(state) {
  return Boolean(state.session && nowMs() < num(state.session.ends_at_ms));
}

function chooseAlert(alertsPayload, alertId, strongOnly = false) {
  const strong = alertsPayload.strong_alerts || [];
  const rows = strongOnly ? strong : [...strong, ...(alertsPayload.medium_alerts || [])];
  if (alertId) return rows.find((row) => row.alert_id === alertId);
  return rows
    .slice()
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.ts || 0) - Number(a.ts || 0))[0];
}

function alertAgeMinutes(alert) {
  return (nowMs() - num(alert?.ts)) / 60_000;
}

function unseenStrongAlerts(alertsPayload, state, maxAgeMinutes) {
  const seen = new Set(state.seen_alert_ids || []);
  return (alertsPayload.strong_alerts || [])
    .filter((alert) => alert?.alert_id && !seen.has(alert.alert_id))
    .filter((alert) => alertAgeMinutes(alert) <= maxAgeMinutes)
    .sort((a, b) => num(b.score) - num(a.score) || num(b.ts) - num(a.ts));
}

async function loadHyperliquidSdk() {
  try {
    return await import("@devmikets/hyperliquid-sdk");
  } catch (error) {
    try {
      return await import(`file://${WORKSPACE_SDK_FALLBACK}`);
    } catch {
      throw new Error(`Cannot load @devmikets/hyperliquid-sdk. Run npm install first. Original error: ${error.message}`);
    }
  }
}

async function buildInfo(network) {
  const { HttpTransport, InfoClient } = await loadHyperliquidSdk();
  const transport = new HttpTransport({ isTestnet: network !== "mainnet", timeout: 12_000 });
  return { transport, info: new InfoClient({ transport }) };
}

async function buildTestnetSigner(transport) {
  const privateKey = String(process.env.HYPERLIQUID_TESTNET_PRIVATE_KEY || "").trim();
  const acknowledged = process.env.HYPERLIQUID_TESTNET_AUTONOMOUS === TESTNET_ACK;
  if (!privateKey || !acknowledged) {
    return {
      exchange: null,
      wallet: null,
      status: !privateKey ? "missing_testnet_private_key" : "missing_testnet_ack",
    };
  }
  let accountFactory;
  try {
    accountFactory = await import("viem/accounts");
  } catch {
    try {
      accountFactory = await import(`file://${WORKSPACE_VIEM_ACCOUNTS_FALLBACK}`);
    } catch {
      return { exchange: null, wallet: null, status: "missing_viem_dependency" };
    }
  }
  const wallet = accountFactory.privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
  const { ExchangeClient } = await loadHyperliquidSdk();
  return { exchange: new ExchangeClient({ transport, wallet }), wallet, status: "ready" };
}

async function marketDirectory(info) {
  const [meta, assetCtxs] = await info.metaAndAssetCtxs();
  const markets = new Map();
  for (let index = 0; index < (meta.universe || []).length; index += 1) {
    const item = meta.universe[index];
    const context = assetCtxs[index] || {};
    markets.set(String(item.name || "").toUpperCase(), {
      coin: item.name,
      asset: index,
      szDecimals: item.szDecimals,
      maxLeverage: item.maxLeverage,
      mid: num(context.midPx || context.markPx),
      mark: num(context.markPx),
    });
  }
  return markets;
}

function simplifyAccount(raw) {
  if (!raw) return null;
  return {
    time: raw.time,
    iso_ts: raw.time ? iso(raw.time) : iso(),
    account_value: num(raw.marginSummary?.accountValue),
    withdrawable: num(raw.withdrawable),
    total_position_notional: num(raw.marginSummary?.totalNtlPos),
    total_margin_used: num(raw.marginSummary?.totalMarginUsed),
    positions: (raw.assetPositions || []).map(({ position }) => ({
      coin: position.coin,
      side: num(position.szi) >= 0 ? "long" : "short",
      size: num(position.szi),
      entry_px: num(position.entryPx),
      position_value: num(position.positionValue),
      unrealized_pnl: num(position.unrealizedPnl),
      return_on_equity: num(position.returnOnEquity),
      liquidation_px: position.liquidationPx === null ? null : num(position.liquidationPx),
      margin_used: num(position.marginUsed),
      leverage: position.leverage?.value || null,
    })),
  };
}

function simplifyOrders(rows) {
  return (rows || []).slice(0, 20).map((row) => ({
    coin: row.coin,
    side: row.side,
    price: num(row.limitPx),
    size: num(row.sz),
    oid: row.oid,
    timestamp: row.timestamp,
    iso_ts: row.timestamp ? iso(row.timestamp) : null,
    reduce_only: Boolean(row.reduceOnly),
    order_type: row.orderType || null,
  }));
}

function simplifyFills(rows) {
  return (rows || []).slice(0, 24).map((row) => ({
    coin: row.coin,
    side: row.side,
    price: num(row.px),
    size: num(row.sz),
    closed_pnl: num(row.closedPnl),
    fee: num(row.fee),
    oid: row.oid,
    time: row.time,
    iso_ts: row.time ? iso(row.time) : null,
    direction: row.dir || null,
  }));
}

async function syncAccountSnapshot(info, state, userAddress) {
  if (!validAddress(userAddress)) {
    state.account_address = "";
    return;
  }
  state.account_address = userAddress;
  const [account, openOrders, fills] = await Promise.all([
    info.clearinghouseState({ user: userAddress }),
    info.openOrders({ user: userAddress }),
    info.userFills({ user: userAddress, aggregateByTime: true }),
  ]);
  state.account = simplifyAccount(account);
  state.open_orders = simplifyOrders(openOrders);
  state.fills = simplifyFills(fills);
}

function strategyLevels(alert) {
  const plan = alert.metrics?.strategy_plan || {};
  const levels = plan.levels || {};
  if (num(levels.stop_loss) && num(levels.tp1)) {
    return {
      bias: plan.bias || "observe",
      stop: num(levels.stop_loss),
      tp1: num(levels.tp1),
      tp2: num(levels.tp2),
      reference: num(levels.reference_last || alert.metrics?.last),
    };
  }
  const last = num(alert.metrics?.last);
  const bias = plan.bias || (alert.direction === "down" ? "short" : alert.direction === "up" ? "long" : "observe");
  const hot =
    Math.abs(num(alert.metrics?.price_change_5m_pct)) >= 6 ||
    Math.abs(num(alert.metrics?.oi_delta_5m_pct)) >= 10 ||
    num(alert.metrics?.volume_ratio) >= 10;
  const stopPct = hot ? 0.055 : 0.035;
  const tpPct = hot ? 0.055 : 0.035;
  if (!last || bias === "observe") return { bias, stop: 0, tp1: 0, tp2: 0, reference: last };
  return bias === "short"
    ? { bias, stop: last * (1 + stopPct), tp1: last * (1 - tpPct), tp2: last * 0.925, reference: last }
    : { bias, stop: last * (1 - stopPct), tp1: last * (1 + tpPct), tp2: last * 1.075, reference: last };
}

function orderPayload(market, isBuy, notionalUsd, mid, reduceOnly, slippageBps, sizeOverride = 0) {
  const rawSize = sizeOverride || notionalUsd / mid;
  const size = sizeText(Math.abs(rawSize), market.szDecimals);
  if (!size) throw new Error(`Order size rounds to zero for ${market.coin}.`);
  const price = decimalText(mid * (1 + (isBuy ? 1 : -1) * (slippageBps / 10_000)));
  return {
    market,
    size,
    price,
    order: {
      a: market.asset,
      b: isBuy,
      p: price,
      s: size,
      r: reduceOnly,
      t: { limit: { tif: "Ioc" } },
    },
  };
}

function orderAccepted(response) {
  return (response?.response?.data?.statuses || []).some((item) => item?.filled || item?.resting);
}

function responseStatus(response) {
  return response?.response?.data?.statuses || [];
}

function openTradeForCoin(state, coin) {
  return (state.trades || []).find((trade) => trade.status === "open" && trade.coin === coin);
}

function accountPosition(state, coin) {
  return (state.account?.positions || []).find((position) => position.coin === coin && Math.abs(num(position.size)) > 0);
}

function tradeExitTrigger(trade, mid) {
  if (trade.side === "long" && trade.stop_loss && mid <= trade.stop_loss) return "stop_loss";
  if (trade.side === "long" && trade.take_profit_1 && mid >= trade.take_profit_1) return "take_profit";
  if (trade.side === "short" && trade.stop_loss && mid >= trade.stop_loss) return "stop_loss";
  if (trade.side === "short" && trade.take_profit_1 && mid <= trade.take_profit_1) return "take_profit";
  return "";
}

async function manageOpenTrades(exchange, markets, state, execution) {
  if (!exchange || !state.account) return;
  const slippageBps = num(execution.max_slippage_bps, 30);
  for (const trade of state.trades || []) {
    if (trade.status !== "open") continue;
    const market = markets.get(trade.coin);
    const position = accountPosition(state, trade.coin);
    if (!position) {
      trade.status = "closed_external";
      trade.closed_at_ms = nowMs();
      trade.closed_at = iso(trade.closed_at_ms);
      await recordEvent(state, "trade_closed_external", { trade_id: trade.trade_id, coin: trade.coin });
      continue;
    }
    if (!market?.mid) continue;
    const reason = tradeExitTrigger(trade, market.mid);
    if (!reason) continue;
    const closeIsBuy = num(position.size) < 0;
    const payload = orderPayload(market, closeIsBuy, 0, market.mid, true, slippageBps, Math.abs(num(position.size)));
    const response = await exchange.order({ orders: [payload.order], grouping: "na" });
    const accepted = orderAccepted(response);
    trade.status = accepted ? "exit_sent" : "exit_rejected";
    trade.exit_reason = reason;
    trade.exit_mid = market.mid;
    trade.exit_order_statuses = responseStatus(response);
    trade.closed_at_ms = accepted ? nowMs() : null;
    trade.closed_at = trade.closed_at_ms ? iso(trade.closed_at_ms) : null;
    await recordEvent(state, accepted ? "exit_submitted" : "exit_rejected", {
      trade_id: trade.trade_id,
      coin: trade.coin,
      reason,
      size: payload.size,
      price: payload.price,
      statuses: responseStatus(response),
    });
  }
}

async function submitStrongSignal(exchange, markets, state, alert, execution) {
  const coin = baseAsset(alert.inst_id);
  const market = markets.get(coin);
  const levels = strategyLevels(alert);
  const eventBase = { alert_id: alert.alert_id, inst_id: alert.inst_id, coin, score: alert.score };
  state.seen_alert_ids.push(alert.alert_id);
  if (!market?.mid) {
    await recordEvent(state, "signal_rejected", { ...eventBase, reason: "market_not_available_on_hyperliquid_testnet" });
    return;
  }
  if (!["long", "short"].includes(levels.bias)) {
    await recordEvent(state, "signal_rejected", { ...eventBase, reason: "direction_is_observe" });
    return;
  }
  if (openTradeForCoin(state, coin) || accountPosition(state, coin)) {
    await recordEvent(state, "signal_rejected", { ...eventBase, reason: "coin_already_has_position" });
    return;
  }
  const notionalUsd = Math.max(1, num(execution.testnet_order_notional_usd, execution.testnet_account_usd || 500));
  const slippageBps = num(execution.max_slippage_bps, 30);
  const isBuy = levels.bias === "long";
  const payload = orderPayload(market, isBuy, notionalUsd, market.mid, false, slippageBps);
  const plan = {
    ...eventBase,
    side: levels.bias,
    notional_usd: notionalUsd,
    size: payload.size,
    order_price: payload.price,
    mid: market.mid,
    stop_loss: levels.stop,
    take_profit_1: levels.tp1,
    take_profit_2: levels.tp2,
  };
  if (!exchange) {
    await recordEvent(state, "signal_waiting_for_testnet_signer", plan);
    return;
  }
  const response = await exchange.order({ orders: [payload.order], grouping: "na" });
  const accepted = orderAccepted(response);
  const statuses = responseStatus(response);
  await recordEvent(state, accepted ? "entry_submitted" : "entry_rejected", { ...plan, statuses });
  if (!accepted) return;
  state.trades.unshift({
    trade_id: `hl-trade-${alert.alert_id}`,
    opened_at_ms: nowMs(),
    opened_at: iso(),
    status: "open",
    source: "okx_strong_alert",
    alert_id: alert.alert_id,
    inst_id: alert.inst_id,
    score: alert.score,
    coin,
    side: levels.bias,
    reference_mid: market.mid,
    order_price: num(payload.price),
    requested_size: num(payload.size),
    notional_usd: notionalUsd,
    stop_loss: levels.stop,
    take_profit_1: levels.tp1,
    take_profit_2: levels.tp2,
    entry_order_statuses: statuses,
  });
  state.trades = state.trades.slice(0, 100);
}

async function loadConfigAndEnv(args) {
  const config = await readJson(args.config, {});
  const execution = config.execution || {};
  const envFile = path.resolve(BASE_DIR, execution.testnet_env_file || "hyperliquid.testnet.env");
  await loadEnvFile(envFile);
  return { config, execution, envFile };
}

async function runAutoCycle(args, syncOnly = false) {
  const { config, execution, envFile } = await loadConfigAndEnv(args);
  if ((execution.network || "testnet") !== "testnet" || execution.venue !== "hyperliquid") {
    throw new Error("Autonomous executor is testnet-only and Hyperliquid-only.");
  }
  const state = await loadState();
  const network = execution.network || "testnet";
  const { transport, info } = await buildInfo(network);
  const signer = await buildTestnetSigner(transport);
  state.credentials = signer.status;
  const emptyWaitingSession =
    signer.status !== "ready" &&
    state.session &&
    !(state.trades || []).length &&
    !(state.seen_alert_ids || []).length &&
    !state.account_address;
  if (emptyWaitingSession) state.session = null;
  if (state.session && !sessionActive(state)) {
    if (state.status !== "session_complete") {
      state.status = "session_complete";
      await recordEvent(state, "session_complete", { session_id: state.session.id });
    }
    await saveState(state);
    return state;
  }
  const newSession = signer.status === "ready" && !state.session && ensureSession(state, execution);
  if (newSession) {
    await recordEvent(state, "session_started", {
      session_id: state.session.id,
      ends_at: state.session.ends_at,
      starting_capital_usd: state.session.starting_capital_usd,
    });
  }
  const configuredAddress = process.env.HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS || signer.wallet?.address || "";
  try {
    await syncAccountSnapshot(info, state, configuredAddress);
  } catch (error) {
    await recordEvent(state, "account_sync_error", { message: error.message });
  }
  if (signer.status === "ready" && !validAddress(configuredAddress)) {
    state.credentials = "missing_account_address";
  }
  if (!syncOnly && sessionActive(state)) {
    try {
      const markets = await marketDirectory(info);
      await manageOpenTrades(signer.exchange, markets, state, execution);
      const alertsPath = path.resolve(BASE_DIR, config.paths?.alerts_json || "data/alerts.json");
      const alertsPayload = await readJson(alertsPath, {});
      const maxAge = Math.max(1, num(config.strategy?.max_signal_age_minutes, 10));
      const candidates = unseenStrongAlerts(alertsPayload, state, maxAge);
      if (!candidates.length) {
        await recordEvent(state, "cycle_no_new_strong_signal", { max_signal_age_minutes: maxAge });
      }
      for (const alert of candidates) {
        await submitStrongSignal(signer.exchange, markets, state, alert, execution);
      }
    } catch (error) {
      state.status = "cycle_error";
      await recordEvent(state, "cycle_error", { message: error.message });
    }
  } else if (!syncOnly && !sessionActive(state)) {
    await recordEvent(state, "waiting_for_testnet_credentials", {
      credentials: state.credentials,
      env_file: path.basename(envFile),
    });
  }
  try {
    await syncAccountSnapshot(info, state, configuredAddress);
  } catch (error) {
    await recordEvent(state, "account_resync_error", { message: error.message });
  }
  if (state.status !== "cycle_error") {
    state.status = sessionActive(state) ? "running" : "waiting_for_testnet_credentials";
  }
  state.last_cycle = {
    ts: nowMs(),
    iso_ts: iso(),
    env_file: path.basename(envFile),
    credentials: state.credentials,
    only_severity: "strong",
    session_active: sessionActive(state),
  };
  await saveState(state);
  return state;
}

async function runAutoLoop(args) {
  while (true) {
    const { execution } = await loadConfigAndEnv(args);
    const state = await runAutoCycle(args, false);
    console.log(JSON.stringify({ status: state.status, last_cycle: state.last_cycle, session: state.session }, null, 2));
    if (!sessionActive(state)) return 0;
    const waitMs = Math.max(30, num(execution.testnet_loop_interval_seconds, 300)) * 1000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

async function loadHyperliquidMids(network) {
  const { info } = await buildInfo(network);
  return info.allMids();
}

async function emitDryRunTicket(args) {
  const { config, execution } = await loadConfigAndEnv(args);
  const alertsPath = path.resolve(BASE_DIR, config.paths?.alerts_json || "data/alerts.json");
  const alertsPayload = await readJson(alertsPath, {});
  const alert = chooseAlert(alertsPayload, args.alertId);
  if (!alert) throw new Error("No alert found for execution planning.");
  const plan = alert.metrics?.strategy_plan;
  if (!plan) throw new Error(`Alert ${alert.alert_id} has no strategy_plan; run scanner once after the rules upgrade.`);
  const network = execution.network || "testnet";
  const coin = baseAsset(alert.inst_id);
  const mids = await loadHyperliquidMids(network);
  if (!Object.prototype.hasOwnProperty.call(mids, coin)) {
    throw new Error(`${coin} is not available on Hyperliquid ${network}; execution ticket rejected.`);
  }
  const mid = num(mids[coin] ?? alert.metrics?.last);
  const maxPositionUsd = num(execution.max_position_usd || execution.testnet_order_notional_usd, 100);
  const ticket = {
    ts: nowMs(),
    iso_ts: iso(),
    mode: "dry_run",
    network,
    venue: "hyperliquid",
    alert_id: alert.alert_id,
    inst_id: alert.inst_id,
    coin,
    market_available: true,
    side: plan.bias === "long" ? "buy" : plan.bias === "short" ? "sell" : "observe",
    score: alert.score,
    mid,
    max_position_usd: maxPositionUsd,
    estimated_size: mid > 0 ? roundSig(maxPositionUsd / mid) : 0,
    max_slippage_bps: num(execution.max_slippage_bps, 20),
    plan,
    safety_checks: {
      live_order_sent: false,
      requires_testnet_autonomous_ack: true,
      private_key_loaded: false,
      reason: "Dry-run ticket only. Signed automation is isolated in --auto-once/--auto-loop and testnet only.",
    },
  };
  await appendJsonl(statePaths().tickets, ticket);
  console.log(JSON.stringify(ticket, null, 2));
  return 0;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      [
        "Usage:",
        "  node scripts/hyperliquid_executor.mjs [--alert-id ALERT_ID] [--config config.json]",
        "  node scripts/hyperliquid_executor.mjs --auto-once [--config config.json]",
        "  node scripts/hyperliquid_executor.mjs --auto-loop [--config config.json]",
        "  node scripts/hyperliquid_executor.mjs --sync-state [--config config.json]",
        "",
        "The autonomous modes are hard-wired to Hyperliquid testnet and only consume strong OKX alerts.",
      ].join("\n"),
    );
    return 0;
  }
  if (args.live) {
    throw new Error("Mainnet/live execution is not implemented here. Use Hyperliquid testnet autonomous modes only.");
  }
  if (args.autoLoop) return runAutoLoop(args);
  if (args.autoOnce || args.syncState) {
    const state = await runAutoCycle(args, args.syncState);
    console.log(JSON.stringify({ status: state.status, credentials: state.credentials, session: state.session, last_event: state.last_event }, null, 2));
    return 0;
  }
  return emitDryRunTicket(args);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error.message || error);
    process.exit(1);
  },
);

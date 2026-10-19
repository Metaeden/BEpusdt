/**
 * OneClick Pay — 收银台主逻辑
 *
 * 流程：
 *   1. POST /api/v1/pay/info 取订单
 *   2. 解析 trade_type → 链参数
 *   3. 生成二维码（EIP-681 / Solana Pay / ton://），检测钱包
 *   4. 桌面端有钱包 → 一键拉起；否则扫码/复制
 *   5. 轮询订单状态，展示确认中/成功/过期
 */

import { resolveOrder, toAtomic } from './chains.js';
import { buildPaymentUri } from './uri.js';
import { qrSvg } from './qrcode.js';
import { detectWallets, isMobile, payWithWallet } from './wallets.js';

const STATUS = {
  WAITING: 1,
  SUCCESS: 2,
  EXPIRED: 3,
  CANCELED: 4,
  CONFIRMING: 5,
  FAILED: 6,
};

const POLL_FAST_MS = 3000;
const POLL_SLOW_MS = 8000;

const $ = (id) => document.getElementById(id);

const state = {
  tradeId: '',
  order: null,
  trade: null,
  wallet: null,
  pollTimer: null,
  countdownTimer: null,
  expiresAt: 0,
  paidClicked: false,
};

/* ------------------------------------------------------------------ */
/* i18n（跟随浏览器语言，缺省中文）                                      */
/* ------------------------------------------------------------------ */

const STRINGS = {
  zh: {
    loading: '正在加载订单…',
    errorTitle: '订单不可用',
    brand: 'OneClick Pay',
    timeLeft: '剩余',
    exactAmountHint: '请务必精确支付此金额，多付或少付都会导致无法自动到账',
    payWithWallet: '一键支付',
    scanHint: '使用钱包 App 扫码支付',
    address: '收款地址',
    amount: '金额',
    copy: '复制',
    copied: '已复制',
    copyFailed: '复制失败，请手动选择',
    orderNo: '订单号',
    network: '网络',
    paidBtn: '我已完成支付',
    confirmingTitle: '等待链上确认',
    confirmingHint: '已检测到付款，正在等待区块确认…',
    viewTx: '在区块浏览器查看',
    successTitle: '支付成功',
    successHint: '交易已确认，感谢您的付款',
    returnMerchant: '返回商户',
    expiredTitle: '订单已过期',
    expiredHint: '请返回商户重新下单',
    canceledTitle: '订单已取消',
    failedTitle: '交易确认失败',
    noWallet: '未检测到钱包插件，请扫码或复制地址手动转账',
    wrongNetwork: '请在钱包中切换到对应网络后重试',
    rejected: '您取消了支付',
    sendError: '发起交易失败',
    waitingChain: '已提交，等待链上检测…',
    openingWallet: '正在唤起钱包…',
    amountChanged: '支付金额已更新，请重新确认',
    poweredBy: 'Powered by',
    walletDetected: '检测到',
  },
  en: {
    loading: 'Loading order…',
    errorTitle: 'Order unavailable',
    brand: 'OneClick Pay',
    timeLeft: 'Left',
    exactAmountHint: 'Please pay the exact amount. Over- or underpayment cannot be credited automatically.',
    payWithWallet: 'Pay with wallet',
    scanHint: 'Scan with your wallet app',
    address: 'Receiving address',
    amount: 'Amount',
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'Copy failed, please select manually',
    orderNo: 'Order',
    network: 'Network',
    paidBtn: 'I have paid',
    confirmingTitle: 'Waiting for confirmation',
    confirmingHint: 'Payment detected. Waiting for block confirmations…',
    viewTx: 'View on explorer',
    successTitle: 'Payment successful',
    successHint: 'Transaction confirmed. Thank you!',
    returnMerchant: 'Back to merchant',
    expiredTitle: 'Order expired',
    expiredHint: 'Please return and create a new order',
    canceledTitle: 'Order canceled',
    failedTitle: 'Transaction failed',
    noWallet: 'No wallet extension detected. Scan the QR code or copy the address.',
    wrongNetwork: 'Please switch your wallet to the correct network and retry',
    rejected: 'Payment canceled',
    sendError: 'Failed to send transaction',
    waitingChain: 'Submitted. Waiting for on-chain detection…',
    openingWallet: 'Opening wallet…',
    amountChanged: 'Payment amount updated, please review again',
    poweredBy: 'Powered by',
    walletDetected: 'Detected',
  },
};

let LANG = 'zh';
function t(key) {
  return (STRINGS[LANG] && STRINGS[LANG][key]) || STRINGS.zh[key] || key;
}

function detectLang() {
  const langs = navigator.languages || [navigator.language || 'zh'];
  for (const l of langs) {
    if (/^zh/i.test(l)) return 'zh';
    if (/^en/i.test(l)) return 'en';
  }
  return 'zh';
}

function applyI18n() {
  document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
}

/* ------------------------------------------------------------------ */
/* 数据请求                                                            */
/* ------------------------------------------------------------------ */

async function payInfo(tradeId) {
  const res = await fetch('/api/v1/pay/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trade_id: tradeId }),
  });
  const json = await res.json();
  if (!json || json.status_code !== 200 || !json.data) {
    throw new Error((json && json.message) || 'failed to load order');
  }
  return json.data;
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function showOnly(id) {
  for (const s of ['stateLoading', 'stateError', 'statePay', 'stateConfirming', 'stateSuccess', 'stateClosed']) {
    const el = $(s);
    if (el) el.hidden = s !== id;
  }
}

function renderOrder(order) {
  const trade = resolveOrder(order);
  state.order = order;
  state.trade = trade;

  $('amountCrypto').textContent = order.actual_amount;
  $('amountSymbol').textContent = trade ? trade.crypto : '';
  $('amountFiat').textContent = `${order.money} ${order.fiat}`;
  $('networkPill').textContent = order.network
    ? `${order.network.alias || order.network.name}`
    : (trade ? trade.chain.name : '');
  $('addressText').textContent = order.token;
  $('amountText').textContent = order.actual_amount;
  $('orderNo').textContent = order.order_id;
  $('networkName').textContent = order.network ? (order.network.name || order.network.alias) : '--';

  if (!trade) {
    showError('Unsupported payment type: ' + order.trade_type);
    return;
  }

  setupPayment(order, trade);
  startCountdown(order.expired_at);

  if (order.status === STATUS.CONFIRMING) {
    showOnly('stateConfirming');
    setTxLink('txLinkConfirming', order);
  } else if (order.status === STATUS.SUCCESS) {
    showSuccess(order);
  } else if (order.status === STATUS.EXPIRED || order.status === STATUS.CANCELED || order.status === STATUS.FAILED) {
    showClosed(order.status);
  } else {
    showOnly('statePay');
  }

  schedulePoll(order.status);
}

function setupPayment(order, trade) {
  const { uri, kind } = buildPaymentUri(trade, {
    address: order.token,
    amount: order.actual_amount,
    orderId: order.order_id,
    label: 'OneClick Pay',
  });

  // 二维码
  const qrBlock = $('qrBlock');
  const qrFrame = $('qrFrame');
  if (uri) {
    try {
      qrFrame.innerHTML = qrSvg(uri, { margin: 2 });
      qrBlock.hidden = false;
    } catch (e) {
      console.error('QR generation failed', e);
      qrBlock.hidden = true;
    }
  } else {
    qrBlock.hidden = true;
  }

  // 钱包检测
  const wallets = detectWallets();
  state.wallet = wallets.find((w) => w.kind === trade.chain.kind) || null;

  const payBtn = $('payWalletBtn');
  const hint = $('walletHint');

  if (state.wallet && !isMobile()) {
    payBtn.hidden = false;
    $('walletName').textContent = `${t('walletDetected')} ${state.wallet.label}`;
    payBtn.onclick = () => onPayClick();
  } else {
    payBtn.hidden = true;
    if (isMobile()) {
      hint.textContent = '';
      hint.hidden = true;
    } else if (kind !== 'address-only') {
      hint.textContent = t('noWallet');
      hint.hidden = false;
    }
  }
}

async function onPayClick() {
  const btn = $('payWalletBtn');
  const status = $('statusText');
  btn.disabled = true;
  status.hidden = true;

  try {
    const res = await payWithWallet(state.trade, {
      address: state.order.token,
      amount: state.order.actual_amount,
      orderId: state.order.order_id,
    });

    if (res.ok) {
      status.textContent = t('waitingChain');
      status.hidden = false;
      state.paidClicked = true;
      pollOnce();
    } else if (res.reason === 'use-deeplink') {
      // 钱包扩展缺少本地 SDK：用标准 URI 唤起钱包 App
      const { uri } = buildPaymentUri(state.trade, {
        address: state.order.token,
        amount: state.order.actual_amount,
        orderId: state.order.order_id,
        label: 'OneClick Pay',
      });
      if (uri) window.location.href = uri;
      status.textContent = t('openingWallet');
      status.hidden = false;
    } else if (res.reason === 'rejected') {
      status.textContent = t('rejected');
      status.hidden = false;
    } else if (res.reason === 'no-wallet') {
      status.textContent = t('noWallet');
      status.hidden = false;
    } else if (res.reason === 'unsupported-chain') {
      status.textContent = t('wrongNetwork');
      status.hidden = false;
    } else {
      status.textContent = `${t('sendError')}${res.message ? ': ' + res.message : ''}`;
      status.hidden = false;
    }
  } finally {
    btn.disabled = false;
  }
}

function setTxLink(id, order) {
  const el = $(id);
  if (!el) return;

  // 优先用服务端返回的 explorer_fmt 拼交易链接。
  // 注意：订单创建时 ref_hash 会被预填为 trade_id 作为占位，未真正支付前不能展示链接。
  const hash = order.tx_hash;
  const fmt = order.network && order.network.explorer_fmt;
  let href = order.trade_url;
  let paid;

  if (hash === undefined) {
    // 旧版服务端没有 tx_hash 字段，退回原有判断
    paid = true;
  } else {
    paid = !!hash && hash !== order.trade_id;
    if (paid && fmt && fmt.includes('%s')) href = fmt.replace('%s', hash);
  }

  if (paid && href && /^https?:\/\//.test(href)) {
    el.href = href;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function showSuccess(order) {
  showOnly('stateSuccess');
  setTxLink('txLinkSuccess', order);

  const ret = $('returnBtn');
  if (order.redirect_url) {
    ret.href = order.redirect_url;
    ret.hidden = false;
  } else {
    ret.hidden = true;
  }

  stopTimers();
}

function showClosed(statusCode) {
  showOnly('stateClosed');
  const title = $('closedTitle');
  if (statusCode === STATUS.CANCELED) title.textContent = t('canceledTitle');
  else if (statusCode === STATUS.FAILED) title.textContent = t('failedTitle');
  else title.textContent = t('expiredTitle');
  stopTimers();
}

function showError(message) {
  showOnly('stateError');
  $('errorMessage').textContent = message;
  stopTimers();
}

/* ------------------------------------------------------------------ */
/* 倒计时                                                              */
/* ------------------------------------------------------------------ */

function startCountdown(expiredAt) {
  state.expiresAt = Number(expiredAt) * 1000;
  updateCountdown();
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(updateCountdown, 1000);
}

function updateCountdown() {
  const el = $('timerValue');
  const wrap = $('timer');
  if (!el || !state.expiresAt) return;

  const ms = state.expiresAt - Date.now();
  if (ms <= 0) {
    el.textContent = '00:00';
    wrap.classList.add('is-urgent');
    return;
  }
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  el.textContent = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  wrap.classList.toggle('is-urgent', ms < 5 * 60 * 1000);
}

/* ------------------------------------------------------------------ */
/* 轮询                                                                */
/* ------------------------------------------------------------------ */

function schedulePoll(currentStatus) {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  if (currentStatus === STATUS.SUCCESS || currentStatus === STATUS.EXPIRED
    || currentStatus === STATUS.CANCELED || currentStatus === STATUS.FAILED) {
    return;
  }
  const delay = state.paidClicked ? POLL_FAST_MS : POLL_SLOW_MS;
  state.pollTimer = setTimeout(pollOnce, delay);
}

async function pollOnce() {
  try {
    const order = await payInfo(state.tradeId);
    const prevStatus = state.order ? state.order.status : null;
    const prevAmount = state.order ? state.order.actual_amount : null;

    if (prevStatus === order.status && prevAmount === order.actual_amount) {
      schedulePoll(order.status);
      return;
    }

    // 金额变化（订单重建）需要重新渲染
    if (prevAmount !== null && prevAmount !== order.actual_amount) {
      renderOrder(order);
      const status = $('statusText');
      if (status) {
        status.textContent = t('amountChanged');
        status.hidden = false;
      }
      return;
    }

    renderOrder(order);
  } catch (e) {
    // 网络抖动：继续轮询
    schedulePoll(state.order ? state.order.status : STATUS.WAITING);
  }
}

function stopTimers() {
  if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
  if (state.countdownTimer) { clearInterval(state.countdownTimer); state.countdownTimer = null; }
}

/* ------------------------------------------------------------------ */
/* 复制                                                                */
/* ------------------------------------------------------------------ */

async function copyText(text, btn) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    const original = btn.textContent;
    btn.textContent = t('copied');
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 1600);
  } catch (e) {
    btn.textContent = t('copyFailed');
    setTimeout(() => { btn.textContent = t('copy'); }, 2200);
  }
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  LANG = detectLang();
  applyI18n();

  const app = $('app');
  state.tradeId = app ? app.getAttribute('data-trade-id') : '';

  if (!state.tradeId) {
    showError('Missing trade id');
    return;
  }

  $('copyAddress').addEventListener('click', () => {
    copyText(state.order ? state.order.token : '', $('copyAddress'));
  });
  $('copyAmount').addEventListener('click', () => {
    copyText(state.order ? state.order.actual_amount : '', $('copyAmount'));
  });
  $('paidBtn').addEventListener('click', () => {
    state.paidClicked = true;
    pollOnce();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.order) {
      pollOnce();
    }
  });

  try {
    const order = await payInfo(state.tradeId);
    renderOrder(order);
  } catch (e) {
    showError(e.message || 'failed to load order');
  }
}

boot();

// 便于调试与测试
export { state, t, toAtomic };

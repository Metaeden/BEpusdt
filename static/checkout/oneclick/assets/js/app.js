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
  // 支付方式选择（订单尚未确定 trade_type 时）
  methods: [],
  networkSort: '',
  currencySort: '',
  recommend: '',
  selCurrency: '',
  selMethod: null,
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
    scanAddressHint: '扫码识别收款地址，转账时请手动输入精确金额',
    manualTransfer: '手动转账',
    scanManualTransfer: '扫码 / 手动转账',
    walletPay: '钱包支付',
    scanPay: '扫码支付',
    waitingPay: '等待支付，到账后自动确认',
    deeplinkUnavailable: '当前浏览器无法直接唤起钱包，请展开下方手动转账完成支付',
    reselect: '更换支付方式',
    address: '收款地址',
    amount: '金额',
    copy: '复制',
    copied: '已复制',
    copyFailed: '复制失败，请手动选择',
    orderNo: '订单号',
    network: '网络',
    paidBtn: '我已完成支付',
    paidChecking: '正在查询到账结果，若已付款通常几秒内自动确认',
    paidCheckFail: '到账查询失败，请稍后重试',
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
    currency: '币种',
    networkLabel: '网络/支付方式',
    amountDue: '应付金额',
    payCrypto: '用 {cur} 支付',
    selectHint: '选择支付方式',
    currencyNote: '选择您要支付的币种',
    networkNote: '务必与钱包网络一致',
    selectWarn: '请确认收款网络与您钱包中的网络一致，选错网络将无法到账',
    continuePay: '继续支付',
    selectFailed: '加载支付方式失败',
    selectRetry: '请重新选择支付方式',
    binancePayLabel: '币安 Pay 转账',
    binancePayUid: '收款 UID',
    bpStep1: '打开币安 App，进入「支付」→「转账」',
    bpStep2: '选择 {cur}，收款方式选「向 UID 付款」',
    bpStep3: '粘贴收款 UID，并输入与订单完全一致的金额',
    bpOpenApp: '打开币安 App',
    bpOpenAppFail: '无法自动打开币安 App，请手动打开并转账',
    bpClaimSummary: '金额付错了？回填订单编号找回',
    bpClaimLabel: '币安 App「订单编号」（18 位数字）',
    bpClaimBtn: '回填找回',
    bpClaimOk: '回填成功，正在确认到账…',
    bpClaimFail: '回填未成功',
    contactSupport: '联系客服',
    payMethod: '支付方式',
    productName: '商品',
    reselectShort: '更换',
    selectTitle: '选择支付方式',
    recommend: '推荐',
  },
  en: {
    loading: 'Loading order…',
    errorTitle: 'Order unavailable',
    brand: 'OneClick Pay',
    timeLeft: 'Left',
    exactAmountHint: 'Please pay the exact amount. Over- or underpayment cannot be credited automatically.',
    payWithWallet: 'Pay with wallet',
    scanHint: 'Scan with your wallet app',
    scanAddressHint: 'Scan to fill the receiving address, then enter the exact amount manually',
    manualTransfer: 'Manual transfer',
    scanManualTransfer: 'Scan / manual transfer',
    walletPay: 'Wallet payment',
    scanPay: 'Scan to pay',
    waitingPay: 'Waiting for payment — auto-confirms when received',
    deeplinkUnavailable: "Can't open the wallet from this browser. Use manual transfer below.",
    reselect: 'Change payment method',
    address: 'Receiving address',
    amount: 'Amount',
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'Copy failed, please select manually',
    orderNo: 'Order',
    network: 'Network',
    paidBtn: 'I have paid',
    paidChecking: 'Checking payment — if paid, it usually auto-confirms within seconds',
    paidCheckFail: 'Payment check failed, please try again later',
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
    currency: 'Currency',
    networkLabel: 'Network / payment method',
    amountDue: 'Amount due',
    payCrypto: 'Pay with {cur}',
    selectHint: 'Choose how to pay',
    currencyNote: 'Pick the coin you want to pay with',
    networkNote: 'Must match your wallet network',
    selectWarn: 'Make sure the network matches your wallet. Sending on another network will not be credited.',
    continuePay: 'Continue to pay',
    selectFailed: 'Failed to load payment methods',
    selectRetry: 'Please choose a payment method again',
    binancePayLabel: 'Binance Pay transfer',
    binancePayUid: 'Receiving UID',
    bpStep1: 'Open the Binance app, go to Pay → Transfer',
    bpStep2: 'Pick {cur} and choose "Send to UID"',
    bpStep3: 'Paste the UID and enter the exact order amount',
    bpOpenApp: 'Open Binance app',
    bpOpenAppFail: "Couldn't open the Binance app automatically. Please open it manually.",
    bpClaimSummary: 'Paid the wrong amount? Recover with the Binance order ID',
    bpClaimLabel: 'Binance app "Order ID" (18 digits)',
    bpClaimBtn: 'Recover',
    bpClaimOk: 'Submitted, confirming receipt…',
    bpClaimFail: 'Recovery failed',
    contactSupport: 'Contact support',
    payMethod: 'Payment',
    productName: 'Item',
    reselectShort: 'Change',
    selectTitle: 'Choose how to pay',
    recommend: 'Best',
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
  const states = ['stateLoading', 'stateError', 'stateSelect', 'statePay', 'stateConfirming', 'stateSuccess', 'stateClosed'];
  for (const s of states) {
    const el = $(s);
    if (el) el.hidden = s !== id;
  }
}

function renderOrder(order) {
  // 新订单尚未确定支付方式：先让用户选币种 + 网络
  if (!order.trade_type) {
    state.order = order;
    showSelect(order);
    return;
  }

  const trade = resolveOrder(order);
  state.order = order;
  state.trade = trade;

  $('amountCrypto').textContent = order.actual_amount;
  $('amountSymbol').textContent = trade ? trade.crypto : '';
  $('amountFiat').textContent = `${order.money} ${order.fiat}`;
  const netLabel = order.network
    ? `${order.network.alias || order.network.name}`
    : (trade ? trade.chain.name : '');
  const pill = $('networkPill');
  pill.innerHTML = '';
  pill.dataset.net = String(order.network ? order.network.network : (trade ? trade.chainKey : '')).toLowerCase();
  const pillGlyph = makeGlyph(pill.dataset.net);
  if (pillGlyph) {
    pill.appendChild(pillGlyph);
  }
  pill.appendChild(document.createTextNode(netLabel));
  pill.hidden = false;
  $('payMethodLine').hidden = false;
  $('addressText').textContent = order.token;
  $('amountText').textContent = order.actual_amount;
  $('orderNo').textContent = order.order_id;
  $('sideName').textContent = order.name || '--';

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
    // 待付且后端允许重选时，提供「更换支付方式」入口
    $('reselectBtn').hidden = !order.reselect;
  }

  schedulePoll(order.status);
}

/* ------------------------------------------------------------------ */
/* 支付方式选择                                                        */
/* ------------------------------------------------------------------ */

async function payMethods(tradeId) {
  const res = await fetch('/api/v1/pay/methods', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trade_id: tradeId }),
  });
  const json = await res.json();
  if (!json || json.status_code !== 200 || !json.data) {
    throw new Error((json && json.message) || 'failed to load methods');
  }
  return json.data;
}

/** 网络图标：优先本地 SVG，缺失时返回 null 由 UI 画首字母圆标 */
const ICON_NETWORKS = ['aptos', 'arbitrum', 'base', 'binancepay', 'bsc', 'ethereum', 'plasma', 'polygon', 'solana', 'ton', 'tron', 'xlayer'];
function networkIcon(network) {
  const key = String(network || '').toLowerCase();
  return ICON_NETWORKS.includes(key) ? `/checkout/oneclick/assets/icons/${key}.svg` : null;
}

/**
 * 网络图标节点：SVG 经 CSS mask 涂品牌色（--icon 由 JS 注入变量）。
 * 多色官方标（Arbitrum 藏青+蓝+白）不能单色 mask，直接用原图 <img>；
 * 无对应图标时退化为首字母圆标。
 */
const MULTICOLOR_ICONS = ['arbitrum'];
function makeGlyph(network) {
  const icon = networkIcon(network);
  if (!icon) return null;
  if (MULTICOLOR_ICONS.includes(String(network || '').toLowerCase())) {
    const img = document.createElement('img');
    img.src = icon;
    img.alt = '';
    img.className = 'net-glyph-img';
    return img;
  }
  const glyph = document.createElement('span');
  glyph.className = 'net-glyph';
  glyph.style.setProperty('--icon', `url("${icon}")`);
  return glyph;
}

async function showSelect(order) {
  showOnly('stateSelect');
  // 侧栏：选择阶段大金额显示法币，支付方式未定时隐藏
  $('amountCrypto').textContent = `${order.money}`;
  $('amountSymbol').textContent = order.fiat;
  $('amountFiat').textContent = '';
  // 还没选定网络，侧栏不显示空的「支付方式」行，避免出现只有标题的空行
  $('payMethodLine').hidden = true;
  $('networkPill').hidden = true;
  $('sideName').textContent = order.name || '--';
  $('orderNo').textContent = order.order_id;
  $('dueCrypto').textContent = '--';
  $('dueNet').textContent = t('selectHint');
  $('reselectBtn').hidden = true;
  startCountdown(order.expired_at);

  const curBox = $('currencyChips');
  const netBox = $('networkChips');
  const btn = $('selectPayBtn');
  const btnLabel = $('selectBtnLabel');
  btn.disabled = true;
  btnLabel.textContent = t('continuePay');

  try {
    const data = await payMethods(order.trade_id);
    state.methods = Array.isArray(data.methods) ? data.methods : [];
    state.networkSort = String(data.network_sort || '');
    state.currencySort = String(data.currency_sort || '');
    state.recommend = String(data.recommend || '');
  } catch (e) {
    const st = $('selectStatus');
    st.textContent = t('selectFailed') + (e.message ? ': ' + e.message : '');
    st.hidden = false;
    return;
  }

  if (!state.methods.length) {
    const st = $('selectStatus');
    st.textContent = t('selectFailed');
    st.hidden = false;
    return;
  }

  // 币种去重，并按商户配置的币种排序（未配置的排末尾）
  const parseSort = (raw) => (raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const currencyOrder = parseSort(state.currencySort);
  const currencyRank = (c) => {
    const i = currencyOrder.indexOf(c);
    return i === -1 ? currencyOrder.length : i;
  };
  const currencies = [...new Set(state.methods.map((m) => m.currency))].sort((a, b) => {
    const d = currencyRank(a) - currencyRank(b);
    return d !== 0 ? d : a.localeCompare(b);
  });
  state.selCurrency = currencies[0];

  // 商户配置的网络排序（逗号分隔）优先，未配置保持后端默认顺序
  const sortList = parseSort(state.networkSort);
  const sortRank = (m) => {
    const i = sortList.indexOf(m.network);
    return i === -1 ? sortList.length : i;
  };
  const inOrder = (list) => (sortList.length ? [...list].sort((a, b) => sortRank(a) - sortRank(b)) : list);

  const defaultFor = (cur) => inOrder(state.methods.filter((m) => m.currency === cur))[0] || null;

  // 后台勾选标记为「推荐」的网络（小写匹配），未配置时为空数组，即不显示任何标记
  const recommendList = parseSort(state.recommend).map((s) => s.toLowerCase());

  // 默认预选排序第一的网络，页面落地即可支付（少一次点击）
  state.selMethod = defaultFor(state.selCurrency);

  // 金额只在左上角大字出现一次，各通道卡片与币种按钮都不重复
  // 左上角应付金额 + 当前通道；右侧币种按钮只做切换
  const syncHero = () => {
    const m = state.selMethod;
    const cur = m ? m.currency : state.selCurrency;
    $('dueCrypto').textContent = m ? m.actual_amount : '--';
    $('dueLabel').textContent = t('payCrypto').replace('{cur}', cur);
    $('dueNet').textContent = m ? `${m.token_net_name || m.network}` : t('selectHint');
  };

  // 按钮保持纯文案，金额只在左上角出现
  const syncBtn = () => {
    btn.disabled = !state.selMethod;
    btnLabel.textContent = t('continuePay');
    syncHero();
  };

  const renderCurrencies = () => {
    curBox.innerHTML = '';
    for (const c of currencies) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', String(c === state.selCurrency));
      chip.textContent = c;

      chip.addEventListener('click', () => {
        state.selCurrency = c;
        state.selMethod = defaultFor(c);
        renderCurrencies();
        renderNetworks();
        syncBtn();
      });
      curBox.appendChild(chip);
    }
  };

  const renderNetworks = () => {
    netBox.innerHTML = '';
    const items = inOrder(state.methods.filter((m) => m.currency === state.selCurrency));
    for (const m of items) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'net-card';
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', String(state.selMethod === m));

      const iconWrap = document.createElement('span');
      iconWrap.className = 'net-icon';
      iconWrap.dataset.net = String(m.network || '').toLowerCase();
      const glyph = makeGlyph(m.network);
      if (glyph) {
        iconWrap.appendChild(glyph);
      } else {
        iconWrap.textContent = String(m.token_net_name || m.network).slice(0, 1).toUpperCase();
      }

      const body = document.createElement('span');
      body.className = 'net-body';
      const name = document.createElement('span');
      name.className = 'net-name';
      name.textContent = m.token_net_name || m.network;
      body.append(name);

      const mark = document.createElement('span');
      mark.className = 'net-mark';
      mark.setAttribute('aria-hidden', 'true');

      // 「推荐」标记由商户在后台指定，默认不显示任何标记
      if (recommendList.includes(String(m.network || '').toLowerCase())) {
        const badge = document.createElement('span');
        badge.className = 'rec-badge';
        badge.textContent = t('recommend');
        card.append(iconWrap, body, badge, mark);
      } else {
        card.append(iconWrap, body, mark);
      }
      card.addEventListener('click', () => {
        state.selMethod = m;
        renderCurrencies();
        renderNetworks();
        syncBtn();
      });
      netBox.appendChild(card);
    }
    // 网络多时列表内部滚动，确保选中项可见（默认预选的第一项可能在折叠区外）
    const selCard = netBox.querySelector('[aria-checked="true"]');
    if (selCard) selCard.scrollIntoView({ block: 'nearest' });
  };

  renderCurrencies();
  renderNetworks();
  syncBtn();

  btn.onclick = () => createTransaction(btn);
}

async function createTransaction(btn) {
  const method = state.selMethod;
  if (!method) return;

  const st = $('selectStatus');
  st.hidden = true;
  btn.disabled = true;

  try {
    const res = await fetch('/api/v1/pay/update-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trade_id: state.tradeId,
        currency: method.currency,
        network: method.network,
      }),
    });
    const json = await res.json();
    if (!json || json.status_code !== 200 || !json.data || !json.data.trade_id) {
      throw new Error((json && json.message) || 'failed to create transaction');
    }

    // 服务端会重建订单并生成新的 trade_id，跳转到新收银台
    const next = json.data.trade_id;
    window.location.href = `/pay/checkout/${encodeURIComponent(next)}`;
  } catch (e) {
    st.textContent = `${t('selectRetry')}${e.message ? ': ' + e.message : ''}`;
    st.hidden = false;
    btn.disabled = false;
  }
}

function setupPayment(order, trade) {
  // 币安 Pay：UID + 精确金额引导（币安 App 内转账，无链上地址/二维码标准）
  if (trade.chain.kind === 'binancepay') {
    setupBinancePay(order);
    return;
  }

  const { uri, kind } = buildPaymentUri(trade, {
    address: order.token,
    amount: order.actual_amount,
    orderId: order.order_id,
    label: 'OneClick Pay',
  });

  // 二维码：有标准 URI 用 URI；无标准的链（Tron/Aptos）退化为纯地址二维码，
  // 钱包 App 扫码可识别收款方，金额需手动输入（精确金额见下方提示与复制区）
  const qrBlock = $('qrBlock');
  const qrFrame = $('qrFrame');
  const qrData = uri || (kind === 'address-only' && order.token ? order.token : null);
  if (qrData) {
    try {
      qrFrame.innerHTML = qrSvg(qrData, { margin: 2 });
      qrBlock.hidden = false;
      $('qrHint').textContent = uri ? t('scanHint') : t('scanAddressHint');
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

  // 分区显隐：检测到插件钱包 → 「钱包支付」区块为主操作；
  // 否则「扫码支付」为主。地址/金额复制收在「手动转账」折叠区。
  const walletActive = Boolean(state.wallet && !isMobile());
  $('walletSection').hidden = !walletActive;
  payBtn.hidden = !walletActive;
  if (walletActive) {
    payBtn.onclick = () => onPayClick();
  }
  $('qrSection').hidden = !qrData;
  qrBlock.hidden = !qrData;
  if (isMobile()) {
    hint.hidden = true;
  } else if (!state.wallet && kind !== 'address-only') {
    hint.textContent = t('noWallet');
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }
  $('manualBlock').hidden = false;
}

// 币安 Pay 支付页：UID + 精确金额复制引导，无扫码/钱包/手动转账区
function setupBinancePay(order) {
  $('binanceUidText').textContent = order.token || '--';
  $('binanceAmountText').textContent = order.actual_amount;
  $('qrSection').hidden = true;
  $('manualBlock').hidden = true;
  $('walletSection').hidden = true;
  $('binanceSection').hidden = false;

  // 移动端提供一键唤起币安 App（实验性：bnc:// 协议无公开文档，无法唤起时前端兜底提示）
  const openBtn = $('bpOpenAppBtn');
  if (openBtn) openBtn.hidden = !isMobile();

  // 步骤文案里的币种随订单变化（USDT / USDC）
  const cur = String(order.currency || '').toUpperCase();
  const step2 = document.querySelector('[data-i18n="bpStep2"]');
  if (step2) step2.textContent = t('bpStep2').replace('{cur}', cur);
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
      // 钱包扩展缺少本地 SDK：移动端尝试用标准 URI 唤起钱包 App；
      // 桌面浏览器没有协议处理器，如实提示并引导到扫码/手动转账
      if (isMobile()) {
        const { uri } = buildPaymentUri(state.trade, {
          address: state.order.token,
          amount: state.order.actual_amount,
          orderId: state.order.order_id,
          label: 'OneClick Pay',
        });
        if (uri) window.location.href = uri;
        status.textContent = t('openingWallet');
      } else {
        status.textContent = t('deeplinkUnavailable');
        const manual = $('manualBlock');
        manual.open = true;
        manual.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
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

  // 客服引导：配置了 PaymentSupportUrl 时在过期/取消页展示入口
  const support = $('supportLink');
  if (support) {
    const url = String((state.order && state.order.support_url) || '');
    if (/^https?:\/\//.test(url)) {
      support.href = url;
      support.hidden = false;
    }
  }

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
  state.expiredShown = false;
  // 新一轮倒计时清掉上一单遗留的过期样式
  document.querySelectorAll('.side-timer').forEach((el) => el.classList.remove('is-expired'));
  // 环形进度需要订单创建时间作为进度基准
  const created = state.order && state.order.created_at ? Number(state.order.created_at) * 1000 : 0;
  state.countdownTotal = Math.max(state.expiresAt - created, 1);
  updateCountdown();
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(updateCountdown, 1000);
}

/** 倒计时归零：仅在待支付页面本地判定过期；确认中/成功等状态由轮询驱动 */
function expiredTick() {
  if (state.expiredShown) return;
  const waiting = ['stateSelect', 'statePay'].some((id) => !$(id).hidden);
  if (!waiting) return;
  state.expiredShown = true;
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  showClosed(STATUS.EXPIRED);
}

function updateCountdown() {
  if (!state.expiresAt) return;

  // 选择页与支付页各有一套倒计时元素，同时更新
  for (const [elId, wrapId] of [['timerValue', 'timer'], ['selectTimerValue', 'selectTimer']]) {
    const el = $(elId);
    const wrap = $(wrapId);
    if (!el) continue;

    const ms = state.expiresAt - Date.now();
    if (ms <= 0) {
      el.textContent = '00:00';
      if (wrap) {
        // 已过期：静止、整体变淡，不再红色呼吸
        wrap.classList.remove('is-urgent', 'is-warn');
        wrap.classList.add('is-expired');
        wrap.style.setProperty('--left', '0');
      }
      expiredTick();
      continue;
    }
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    el.textContent = h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    if (wrap) {
      // 剩余比例驱动环形进度
      const left = Math.min(Math.max(ms / state.countdownTotal, 0), 1);
      wrap.style.setProperty('--left', String(left.toFixed(4)));
      // 三档：正常 -> 5 分钟内琥珀 -> 1 分钟内红色呼吸
      const urgent = ms < 60 * 1000;
      wrap.classList.toggle('is-urgent', urgent);
      wrap.classList.toggle('is-warn', !urgent && ms < 5 * 60 * 1000);
    }
  }
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
  $('copyBinanceUid').addEventListener('click', () => {
    copyText(state.order ? state.order.token : '', $('copyBinanceUid'));
  });
  $('copyBinanceAmount').addEventListener('click', () => {
    copyText(state.order ? state.order.actual_amount : '', $('copyBinanceAmount'));
  });
  $('paidBtn').addEventListener('click', async () => {
    state.paidClicked = true;
    const status = $('statusText');

    // 币安 Pay 订单：触发服务端即时扫描，并给出可见反馈（流水未到时页面原本毫无变化）
    if (state.trade && state.trade.chain.kind === 'binancepay') {
      status.textContent = t('paidChecking');
      status.hidden = false;
      try {
        const res = await fetch('/api/v1/pay/paid', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trade_id: state.tradeId }),
        });
        const json = await res.json();
        // 「订单状态无需扫描」等业务错误如实展示，不让按钮显得失灵
        if (json && json.status_code !== 200 && json.message) {
          status.textContent = json.message;
        }
      } catch (e) {
        status.textContent = t('paidCheckFail');
      }
    }

    pollOnce();
  });

  // 金额付错的自助找回：粘贴币安订单编号，后端查流水核销订单
  const claimBtn = $('claimBtn');
  if (claimBtn) {
    claimBtn.addEventListener('click', async () => {
      const status = $('statusText');
      const input = $('claimInput');
      const no = input ? input.value.trim() : '';
      if (!no) {
        status.textContent = t('bpClaimLabel');
        status.hidden = false;
        return;
      }
      claimBtn.disabled = true;
      try {
        const res = await fetch('/api/v1/pay/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trade_id: state.tradeId, binance_order_no: no }),
        });
        const json = await res.json();
        if (json && json.status_code === 200) {
          status.textContent = t('bpClaimOk');
          state.paidClicked = true;
          pollOnce();
        } else {
          status.textContent = `${t('bpClaimFail')}${json && json.message ? ': ' + json.message : ''}`;
        }
      } catch (e) {
        status.textContent = t('bpClaimFail');
      }
      status.hidden = false;
      claimBtn.disabled = false;
    });
  }

  // 一键唤起币安 App（实验性：bnc:// 未公开文档、未真机验证，失败时延时兜底提示）
  const openAppBtn = $('bpOpenAppBtn');
  if (openAppBtn) {
    openAppBtn.addEventListener('click', () => {
      window.location.href = 'bnc://';
      setTimeout(() => {
        if (document.visibilityState !== 'hidden') {
          const status = $('statusText');
          status.textContent = t('bpOpenAppFail');
          status.hidden = false;
        }
      }, 2500);
    });
  }
  $('reselectBtn').addEventListener('click', () => {
    // 返回支付方式选择页；后端对 waiting 订单允许重新 update-order
    if (state.order && state.order.reselect) showSelect(state.order);
  });

  document.addEventListener('visibilitychange', () => {
    // 选择页由 update-order 跳转推进，不参与轮询
    if (document.visibilityState === 'visible' && state.order && state.order.trade_type) {
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
export { state, t, toAtomic, renderOrder, setupPayment };

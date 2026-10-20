/**
 * 链参数静态表 + 金额编码
 *
 * 数据来源：BEpusdt app/conf/const.go 与 app/model/registry.go
 * 注意：BSC 的 USDT/USDC 是 18 位小数，其余稳定币基本是 6 位。
 * 上线前请对照官方文档复核合约地址。
 */

export const CHAINS = {
  ethereum: {
    kind: 'evm',
    chainId: 1,
    name: 'Ethereum',
    rpc: 'https://ethereum-rpc.publicnode.com',
    explorer: 'https://etherscan.io/tx/',
    tokens: {
      USDT: { contract: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6 },
      USDC: { contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },
    },
  },
  bsc: {
    kind: 'evm',
    chainId: 56,
    name: 'BNB Smart Chain',
    rpc: 'https://bsc-rpc.publicnode.com',
    explorer: 'https://bscscan.com/tx/',
    tokens: {
      USDT: { contract: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 },
      USDC: { contract: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18 },
    },
  },
  polygon: {
    kind: 'evm',
    chainId: 137,
    name: 'Polygon',
    rpc: 'https://polygon-bor-rpc.publicnode.com',
    explorer: 'https://polygonscan.com/tx/',
    tokens: {
      USDT: { contract: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', decimals: 6 },
      USDC: { contract: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6 },
    },
  },
  arbitrum: {
    kind: 'evm',
    chainId: 42161,
    name: 'Arbitrum One',
    rpc: 'https://arbitrum-one-rpc.publicnode.com',
    explorer: 'https://arbiscan.io/tx/',
    tokens: {
      USDT: { contract: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', decimals: 6 },
      USDC: { contract: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6 },
    },
  },
  base: {
    kind: 'evm',
    chainId: 8453,
    name: 'Base',
    rpc: 'https://base-rpc.publicnode.com',
    explorer: 'https://basescan.org/tx/',
    tokens: {
      USDC: { contract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
    },
  },
  xlayer: {
    kind: 'evm',
    chainId: 196,
    name: 'X Layer',
    rpc: 'https://xlayerrpc.okx.com',
    explorer: 'https://web3.okx.com/explorer/x-layer/tx/',
    tokens: {
      USDT: { contract: '0x779ded0c9e1022225f8e0630b35a9b54be713736', decimals: 6 },
      USDC: { contract: '0x74b7f16337b8972027f6196a17a631ac6de26d22', decimals: 6 },
    },
  },
  plasma: {
    kind: 'evm',
    chainId: 9745,
    name: 'Plasma',
    rpc: 'https://rpc.plasma.to',
    explorer: 'https://plasmascan.to/tx/',
    tokens: {
      USDT: { contract: '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb', decimals: 6 },
    },
  },
  tron: {
    kind: 'tron',
    name: 'Tron',
    rpc: 'https://api.trongrid.io',
    explorer: 'https://tronscan.org/#/transaction/',
    tokens: {
      USDT: { contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 },
      USDC: { contract: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', decimals: 6 },
    },
    native: { decimals: 6 },
  },
  solana: {
    kind: 'solana',
    name: 'Solana',
    rpc: 'https://solana-rpc.publicnode.com',
    explorer: 'https://solscan.io/tx/',
    tokens: {
      USDT: { contract: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
      USDC: { contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
    },
  },
  ton: {
    kind: 'ton',
    name: 'TON',
    rpc: 'https://toncenter.com/api/v2',
    explorer: 'https://tonscan.org/tx/',
    tokens: {
      USDT: { contract: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', decimals: 6 },
    },
    native: { decimals: 9 },
  },
  aptos: {
    kind: 'aptos',
    name: 'Aptos',
    explorer: 'https://explorer.aptoslabs.com/txn/',
    tokens: {
      USDT: { contract: '0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b', decimals: 6 },
      USDC: { contract: '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b', decimals: 6 },
    },
  },
  binancepay: {
    kind: 'binancepay',
    name: 'Binance Pay',
    // 币安账户内部转账，非链上网络：无 RPC / 合约 / 区块浏览器
    tokens: {
      USDT: { contract: null, decimals: 2 },
    },
  },
};

/** 完整 trade_type 覆盖：crypto 段不是币种的特殊类型（binancepay.usdt 的币种固定为 USDT） */
const TRADE_TYPE_OVERRIDES = {
  'binancepay.usdt': { networkKey: 'binancepay', crypto: 'USDT' },
};

/** trade_type 前缀 → network 键（usdt.trc20 → tron 等） */
const TRADE_TYPE_NETWORK = {
  'trc20': 'tron',
  'erc20': 'ethereum',
  'bep20': 'bsc',
  'polygon': 'polygon',
  'arbitrum': 'arbitrum',
  'base': 'base',
  'xlayer': 'xlayer',
  'plasma': 'plasma',
  'solana': 'solana',
  'ton': 'ton',
  'aptos': 'aptos',
  'trx': 'tron',
  'eth': 'ethereum',
  'bnb': 'bsc',
  'gram': 'ton',
};

/**
 * 解析 trade_type（如 usdt.trc20）→ 链与代币信息。
 * 原生币（tron.trx / ethereum.eth / bsc.bnb / ton.gram）的 contract 为 null。
 */
export function resolveTrade(tradeType) {
  if (!tradeType || typeof tradeType !== 'string') return null;
  const lower = tradeType.toLowerCase();
  const override = TRADE_TYPE_OVERRIDES[lower];
  if (override) {
    const chain = CHAINS[override.networkKey];
    if (!chain) return null;
    const token = chain.tokens[override.crypto] || { contract: null, decimals: 18 };
    return {
      chainKey: override.networkKey,
      chain,
      crypto: override.crypto,
      contract: token.contract,
      decimals: token.decimals,
      native: false,
    };
  }
  const [crypto, suffix] = lower.split('.');
  const networkKey = TRADE_TYPE_NETWORK[suffix];
  if (!networkKey) return null;
  const chain = CHAINS[networkKey];
  if (!chain) return null;

  const isNative = ['trx', 'eth', 'bnb', 'gram'].includes(suffix);
  if (isNative) {
    const decimals = chain.native ? chain.native.decimals : 18;
    return { chainKey: networkKey, chain, crypto: crypto.toUpperCase(), contract: null, decimals, native: true };
  }

  const token = chain.tokens && chain.tokens[crypto.toUpperCase()];
  if (!token) return null;

  return {
    chainKey: networkKey,
    chain,
    crypto: crypto.toUpperCase(),
    contract: token.contract,
    decimals: token.decimals,
    native: false,
  };
}

/**
 * 解析订单：优先使用服务端 /api/v1/pay/info 返回的 network 字段
 * （contract / decimals / native / chain_id / explorer_fmt），
 * 静态表仅作为旧版服务端或字段缺失时的回退。
 *
 * 这样新增链、更换合约或调整精度时，模板无需改动。
 */
export function resolveOrder(order) {
  if (!order) return null;
  const base = resolveTrade(order.trade_type);
  const net = order.network || {};

  if (!base) {
    // 静态表不认识该 trade_type，但有服务端参数时仍可尽力渲染
    if (!net.network || !Number.isInteger(net.decimals)) return null;
    const chainKey = String(net.network).toLowerCase();
    const chain = CHAINS[chainKey];
    if (!chain) return null;
    return {
      chainKey,
      chain: { ...chain, chainId: net.chain_id || chain.chainId },
      crypto: String(net.crypto || '').toUpperCase(),
      contract: net.native ? null : (net.contract || null),
      decimals: net.decimals,
      native: !!net.native,
    };
  }

  const chain = { ...base.chain };
  if (Number.isInteger(net.chain_id) && net.chain_id > 0) chain.chainId = net.chain_id;

  const native = typeof net.native === 'boolean' ? net.native : base.native;
  const contract = native ? null : (net.contract || base.contract);
  const decimals = Number.isInteger(net.decimals) ? net.decimals : base.decimals;

  return { ...base, chain, contract, decimals, native };
}

/**
 * 十进制金额字符串 → 原子单位 BigInt。
 * 严禁 parseFloat/Number：加密货币金额必须精确。
 * 超出精度时抛错，而不是静默截断（避免少付/错付）。
 */
export function toAtomic(amountStr, decimals) {
  const s = String(amountStr == null ? '' : amountStr).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('invalid amount: ' + s);
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error('invalid decimals: ' + decimals);

  const [intPart, fracRaw = ''] = s.split('.');
  if (fracRaw.length > decimals) {
    // 只有全零的尾部可以安全丢弃
    const extra = fracRaw.slice(decimals);
    if (!/^0+$/.test(extra)) throw new Error('amount exceeds decimals: ' + s);
  }
  const frac = (fracRaw + '0'.repeat(decimals)).slice(0, decimals);

  return BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(frac || '0');
}

/** 原子单位 → 十进制字符串（用于展示，去掉尾部多余的 0） */
export function fromAtomic(atomic, decimals) {
  const v = BigInt(atomic);
  const base = 10n ** BigInt(decimals);
  const int = v / base;
  let frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${int}.${frac}` : String(int);
}

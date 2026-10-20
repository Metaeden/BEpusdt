import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHAINS, resolveTrade, resolveOrder, toAtomic, fromAtomic } from './chains.js';

test('toAtomic: 6 位小数的常见金额', () => {
  assert.equal(toAtomic('10.01', 6), 10010000n);
  assert.equal(toAtomic('0.000001', 6), 1n);
  assert.equal(toAtomic('10', 6), 10000000n);
  assert.equal(toAtomic('0', 6), 0n);
  assert.equal(toAtomic('123.456789', 6), 123456789n);
});

test('toAtomic: BSC 18 位小数（最易翻车）', () => {
  assert.equal(toAtomic('10', 18), 10000000000000000000n);
  assert.equal(toAtomic('0.000000000000000001', 18), 1n);
  assert.equal(toAtomic('1.5', 18), 1500000000000000000n);
});

test('toAtomic: 超精度必须抛错而非截断', () => {
  assert.throws(() => toAtomic('10.0000001', 6), /exceeds decimals/);
  assert.throws(() => toAtomic('0.1234567', 6), /exceeds decimals/);
});

test('toAtomic: 仅允许尾部全零的超精度', () => {
  assert.equal(toAtomic('10.010000000', 6), 10010000n);
  assert.equal(toAtomic('10.000000000', 6), 10000000n);
});

test('toAtomic: 非法输入', () => {
  assert.throws(() => toAtomic('', 6));
  assert.throws(() => toAtomic('abc', 6));
  assert.throws(() => toAtomic('1.2.3', 6));
  assert.throws(() => toAtomic('-1', 6));
  assert.throws(() => toAtomic('1e6', 6));
  assert.throws(() => toAtomic('1', -1));
});

test('fromAtomic 与 toAtomic 互逆', () => {
  const cases = [
    ['10.01', 6], ['0.000001', 6], ['123.456789', 6], ['10', 18], ['1.5', 18],
  ];
  for (const [amt, dec] of cases) {
    assert.equal(fromAtomic(toAtomic(amt, dec), dec), amt);
  }
});

test('resolveTrade: 主要交易类型', () => {
  const trc = resolveTrade('usdt.trc20');
  assert.equal(trc.chainKey, 'tron');
  assert.equal(trc.contract, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
  assert.equal(trc.decimals, 6);
  assert.equal(trc.native, false);

  const bep = resolveTrade('usdt.bep20');
  assert.equal(bep.chainKey, 'bsc');
  assert.equal(bep.decimals, 18, 'BSC USDT 必须是 18 位小数');

  const base = resolveTrade('usdc.base');
  assert.equal(base.chainKey, 'base');
  assert.equal(base.contract, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');

  const sol = resolveTrade('usdt.solana');
  assert.equal(sol.chainKey, 'solana');
  assert.equal(sol.decimals, 6);
});

test('resolveTrade: 原生币', () => {
  const trx = resolveTrade('tron.trx');
  assert.equal(trx.native, true);
  assert.equal(trx.contract, null);
  assert.equal(trx.decimals, 6);

  const gram = resolveTrade('ton.gram');
  assert.equal(gram.native, true);
  assert.equal(gram.decimals, 9);
});

test('resolveTrade: 币安 Pay 内部转账', () => {
  const bp = resolveTrade('binancepay.usdt');
  assert.equal(bp.chainKey, 'binancepay');
  assert.equal(bp.chain.kind, 'binancepay');
  assert.equal(bp.crypto, 'USDT');
  assert.equal(bp.contract, null);
  assert.equal(bp.decimals, 2);
  assert.equal(bp.native, false);
});

test('resolveTrade: 非法输入', () => {
  assert.equal(resolveTrade(''), null);
  assert.equal(resolveTrade(null), null);
  assert.equal(resolveTrade('usdt.unknown'), null);
  assert.equal(resolveTrade('doge.trc20'), null, '不支持的币种');
});

test('resolveOrder: 优先使用服务端返回的链参数', () => {
  const trade = resolveOrder({
    trade_type: 'usdt.erc20',
    network: {
      network: 'ethereum',
      crypto: 'USDT',
      native: false,
      contract: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      decimals: 6,
      chain_id: 1,
    },
  });
  assert.equal(trade.contract, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(trade.decimals, 6);
  assert.equal(trade.chain.chainId, 1);
  assert.equal(trade.native, false);
});

test('resolveOrder: 服务端字段缺失时回退静态表', () => {
  const trade = resolveOrder({ trade_type: 'usdt.bep20' });
  assert.equal(trade.chainKey, 'bsc');
  assert.equal(trade.decimals, 18);
  assert.equal(trade.contract, CHAINS.bsc.tokens.USDT.contract);
});

test('resolveOrder: 服务端声明原生币', () => {
  const trade = resolveOrder({
    trade_type: 'ton.gram',
    network: { network: 'ton', crypto: 'GRAM', native: true, decimals: 9, chain_id: 0 },
  });
  assert.equal(trade.native, true);
  assert.equal(trade.contract, null);
  assert.equal(trade.decimals, 9);
});

test('resolveOrder: 静态表未知但服务端给全参数时仍可渲染', () => {
  const trade = resolveOrder({
    trade_type: 'doge.bep20',
    network: {
      network: 'bsc', crypto: 'DOGE', native: false,
      contract: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', decimals: 18, chain_id: 56,
    },
  });
  assert.equal(trade.chainKey, 'bsc');
  assert.equal(trade.chain.chainId, 56);
  assert.equal(trade.crypto, 'DOGE');
  assert.equal(trade.contract, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
});

test('resolveOrder: 完全无法识别时返回 null', () => {
  assert.equal(resolveOrder(null), null);
  assert.equal(resolveOrder({ trade_type: 'doge.unknown' }), null);
  assert.equal(resolveOrder({ trade_type: 'doge.bep20', network: {} }), null);
});

test('链表完整性：EVM 链均有 chainId 与 tokens', () => {
  for (const [key, chain] of Object.entries(CHAINS)) {
    assert.ok(chain.name, key + ' 缺 name');
    assert.ok(chain.tokens, key + ' 缺 tokens');
    if (chain.kind === 'evm') {
      assert.ok(Number.isInteger(chain.chainId), key + ' 缺 chainId');
      for (const [sym, t] of Object.entries(chain.tokens)) {
        assert.match(t.contract, /^0x[0-9a-f]{40}$/, `${key}.${sym} 合约地址格式错误`);
        assert.ok(t.decimals >= 0 && t.decimals <= 18, `${key}.${sym} decimals 异常`);
      }
    }
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildEip681, buildSolanaPay, buildTonUri, buildPaymentUri, buildErc20TransferData } from './uri.js';
import { resolveTrade } from './chains.js';

const USDT_ETH = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const RECV = '0x1111111111111111111111111111111111111111';

test('EIP-681: ERC-20 转账（Ethereum 主网）', () => {
  const uri = buildEip681({
    contract: USDT_ETH,
    chainId: 1,
    recipient: RECV,
    amount: '10.01',
    decimals: 6,
  });
  assert.equal(
    uri,
    `ethereum:${USDT_ETH}@1/transfer?address=${RECV}&uint256=10010000`,
  );
});

test('EIP-681: 各链 chainId 正确', () => {
  const cases = [
    ['bsc', 56], ['polygon', 137], ['arbitrum', 42161], ['base', 8453], ['xlayer', 196], ['plasma', 9745],
  ];
  for (const [net, id] of cases) {
    const trade = resolveTrade(net === 'bsc' ? 'usdt.bep20' : net === 'base' ? 'usdc.base' : `usdt.${net}`);
    const uri = buildEip681({
      contract: trade.contract,
      chainId: trade.chain.chainId,
      recipient: RECV,
      amount: '1',
      decimals: trade.decimals,
    });
    assert.ok(uri.includes(`@${id}/transfer?`), `${net} chainId 错误: ${uri}`);
  }
});

test('EIP-681: 金额精度（BSC 18 位）', () => {
  const trade = resolveTrade('usdt.bep20');
  const uri = buildEip681({
    contract: trade.contract,
    chainId: trade.chain.chainId,
    recipient: RECV,
    amount: '1.5',
    decimals: trade.decimals,
  });
  assert.ok(uri.endsWith('uint256=1500000000000000000'), uri);
});

test('Solana Pay 格式', () => {
  const uri = buildSolanaPay({
    recipient: 'RecipientAddr111',
    amount: '10.01',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    label: 'Shop',
    message: 'ORDER-1',
  });
  assert.ok(uri.startsWith('solana:RecipientAddr111?'));
  assert.ok(uri.includes('amount=10.01'));
  assert.ok(uri.includes('spl-token=Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'));
  assert.ok(uri.includes('label=Shop'));
  assert.ok(uri.includes('message=ORDER-1'));
});

test('TON 深链：nanoton 编码', () => {
  const uri = buildTonUri({
    recipient: 'UQAddr',
    amount: '1.5',
    decimals: 9,
    text: 'ORDER-1',
  });
  assert.equal(uri, 'ton://transfer/UQAddr?amount=1500000000&text=ORDER-1');
});

test('buildPaymentUri: 按链分派', () => {
  const evm = buildPaymentUri(resolveTrade('usdt.erc20'), {
    address: RECV, amount: '10', orderId: 'O1', label: 'Shop',
  });
  assert.equal(evm.kind, 'eip681');

  const sol = buildPaymentUri(resolveTrade('usdc.solana'), {
    address: 'SolAddr', amount: '5', orderId: 'O2', label: 'Shop',
  });
  assert.equal(sol.kind, 'solana-pay');

  const ton = buildPaymentUri(resolveTrade('usdt.ton'), {
    address: 'UQAddr', amount: '5', orderId: 'O3', label: 'Shop',
  });
  assert.equal(ton.kind, 'ton');

  const tron = buildPaymentUri(resolveTrade('usdt.trc20'), {
    address: 'TAddr', amount: '5', orderId: 'O4', label: 'Shop',
  });
  assert.equal(tron.kind, 'address-only');
  assert.equal(tron.uri, null);
});

test('ERC-20 calldata 编码', () => {
  const data = buildErc20TransferData(RECV, 10010000n);
  assert.equal(
    data,
    '0xa9059cbb'
      + '0000000000000000000000001111111111111111111111111111111111111111'
      + '000000000000000000000000000000000000000000000000000000000098bd90',
  );
});

test('ERC-20 calldata: 0 金额与最大 uint96 边界', () => {
  const zero = buildErc20TransferData(RECV, 0n);
  assert.ok(zero.endsWith('0'.repeat(64)));

  const big = buildErc20TransferData(RECV, 1000000000000000000n);
  assert.equal(big.length, 10 + 64 + 64);
  assert.ok(big.endsWith('de0b6b3a7640000'));
});

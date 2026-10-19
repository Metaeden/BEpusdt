/**
 * 支付 URI 生成（纯函数，无 DOM 依赖，便于单测）
 *
 * - EVM:    EIP-681  ethereum:<token>@<chainId>/transfer?address=<to>&uint256=<atomic>
 * - Solana: Solana Pay  solana:<recipient>?amount=<decimal>&spl-token=<mint>
 * - TON:    ton://transfer/<addr>?amount=<nanoton>&text=<orderId>
 * - Tron:   无统一标准，返回 null（调用方降级为地址 + 醒目金额）
 */

import { toAtomic } from './chains.js';

/** EIP-681 二维码内容 */
export function buildEip681({ contract, chainId, recipient, amount, decimals }) {
  if (!contract) throw new Error('EIP-681 requires a token contract');
  const atomic = toAtomic(amount, decimals);
  return `ethereum:${contract}@${chainId}/transfer?address=${recipient}&uint256=${atomic.toString()}`;
}

/** EIP-681 原生币转账（ETH/BNB）：value 以 wei 计 */
export function buildEip681Native({ chainId, recipient, amount, decimals }) {
  const atomic = toAtomic(amount, decimals);
  return `ethereum:${recipient}@${chainId}?value=${atomic.toString()}`;
}

/** Solana Pay：amount 是十进制字符串（规范要求），spl-token 为 mint */
export function buildSolanaPay({ recipient, amount, mint, label, message }) {
  const params = new URLSearchParams();
  params.set('amount', String(amount));
  if (mint) params.set('spl-token', mint);
  if (label) params.set('label', label);
  if (message) params.set('message', message);
  return `solana:${recipient}?${params.toString()}`;
}

/** TON 深链：amount 以 nanoton 计 */
export function buildTonUri({ recipient, amount, decimals, text }) {
  const atomic = toAtomic(amount, decimals);
  const params = new URLSearchParams();
  params.set('amount', atomic.toString());
  if (text) params.set('text', text);
  return `ton://transfer/${recipient}?${params.toString()}`;
}

/**
 * 按链类型生成二维码内容。
 * 返回 { uri, kind }；不支持扫码标准的链返回 uri: null。
 */
export function buildPaymentUri(trade, { address, amount, orderId, label }) {
  if (!trade) return { uri: null, kind: 'none' };
  const { chainKey, chain, contract, decimals, native } = trade;

  switch (chain.kind) {
    case 'evm':
      return {
        uri: native
          ? buildEip681Native({ chainId: chain.chainId, recipient: address, amount, decimals })
          : buildEip681({ contract, chainId: chain.chainId, recipient: address, amount, decimals }),
        kind: 'eip681',
      };
    case 'solana':
      return {
        uri: buildSolanaPay({ recipient: address, amount, mint: contract, label, message: orderId }),
        kind: 'solana-pay',
      };
    case 'ton':
      return {
        uri: buildTonUri({ recipient: address, amount, decimals, text: orderId }),
        kind: 'ton',
      };
    case 'tron':
    case 'aptos':
    default:
      return { uri: null, kind: 'address-only' };
  }
}

/** ERC-20 transfer(address,uint256) calldata */
export function buildErc20TransferData(recipient, amountAtomic) {
  const addr = String(recipient).toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const amt = BigInt(amountAtomic).toString(16).padStart(64, '0');
  return '0xa9059cbb' + addr + amt;
}

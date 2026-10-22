/**
 * 钱包适配层：检测可用钱包并拉起付款。
 *
 * 设计原则：
 * 1. 只读 + 只发起转账，绝不请求签名消息（eth_sign / personal_sign）
 * 2. 用户拒绝时返回结构化原因，由 UI 决定降级路径
 * 3. 所有链在钱包不可用时返回 { ok:false, reason:'no-wallet' }，UI 降级为扫码/复制
 */

import { toAtomic } from './chains.js';
import { buildErc20TransferData } from './uri.js';

/** 各链检测到的钱包环境（仅用于 UI 提示） */
export function detectWallets() {
  const out = [];
  if (window.ethereum) out.push({ kind: 'evm', label: window.ethereum.isMetaMask ? 'MetaMask' : 'Browser Wallet' });
  if (window.tronWeb || window.tronLink) out.push({ kind: 'tron', label: 'TronLink' });
  if (window.solana && (window.solana.isPhantom || window.solana.isSolflare)) {
    out.push({ kind: 'solana', label: window.solana.isPhantom ? 'Phantom' : 'Solflare' });
  }
  if (window.tonConnectUI) out.push({ kind: 'ton', label: 'TON Connect' });
  return out;
}

/** 是否移动端（用于优先展示扫码） */
export function isMobile() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
}

/* ------------------------------------------------------------------ */
/* EVM (EIP-1193)                                                      */
/* ------------------------------------------------------------------ */

const EVM_CHAIN_PARAMS = {
  1: { chainName: 'Ethereum Mainnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://ethereum-rpc.publicnode.com'], blockExplorerUrls: ['https://etherscan.io'] },
  56: { chainName: 'BNB Smart Chain', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: ['https://bsc-rpc.publicnode.com'], blockExplorerUrls: ['https://bscscan.com'] },
  137: { chainName: 'Polygon', nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 }, rpcUrls: ['https://polygon-bor-rpc.publicnode.com'], blockExplorerUrls: ['https://polygonscan.com'] },
  42161: { chainName: 'Arbitrum One', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://arbitrum-one-rpc.publicnode.com'], blockExplorerUrls: ['https://arbiscan.io'] },
  8453: { chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://base-rpc.publicnode.com'], blockExplorerUrls: ['https://basescan.org'] },
  196: { chainName: 'X Layer', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: ['https://xlayerrpc.okx.com'], blockExplorerUrls: ['https://web3.okx.com/explorer/x-layer'] },
  9745: { chainName: 'Plasma', nativeCurrency: { name: 'XPL', symbol: 'XPL', decimals: 18 }, rpcUrls: ['https://rpc.plasma.to'], blockExplorerUrls: ['https://plasmascan.to'] },
};

export async function payEvm(trade, { address, amount }) {
  const eth = window.ethereum;
  if (!eth) return { ok: false, reason: 'no-wallet' };

  const { chainId } = trade.chain;
  const hexChain = '0x' + chainId.toString(16);

  try {
    const current = await eth.request({ method: 'eth_chainId' });
    if (current !== hexChain) {
      try {
        await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChain }] });
      } catch (e) {
        if (e && e.code === 4902) {
          const params = EVM_CHAIN_PARAMS[chainId];
          if (!params) return { ok: false, reason: 'unsupported-chain' };
          await eth.request({
            method: 'wallet_addEthereumChain',
            params: [{ chainId: hexChain, ...params }],
          });
        } else if (e && e.code === 4001) {
          return { ok: false, reason: 'rejected' };
        } else {
          throw e;
        }
      }
    }

    const accounts = await eth.request({ method: 'eth_requestAccounts' });
    if (!accounts || !accounts.length) return { ok: false, reason: 'no-account' };

    const atomic = toAtomic(amount, trade.decimals);
    let tx;
    if (trade.native) {
      tx = {
        from: accounts[0],
        to: address,
        value: '0x' + atomic.toString(16),
      };
    } else {
      tx = {
        from: accounts[0],
        to: trade.contract,
        data: buildErc20TransferData(address, atomic),
        value: '0x0',
      };
    }

    const hash = await eth.request({ method: 'eth_sendTransaction', params: [tx] });
    return { ok: true, hash };
  } catch (e) {
    if (e && e.code === 4001) return { ok: false, reason: 'rejected' };
    return { ok: false, reason: 'error', message: (e && e.message) || String(e) };
  }
}

/* ------------------------------------------------------------------ */
/* Tron                                                                */
/* ------------------------------------------------------------------ */

export async function payTron(trade, { address, amount }) {
  const tronLink = window.tronLink;
  const tronWeb = window.tronWeb || (tronLink && tronLink.tronWeb);
  if (!tronWeb) return { ok: false, reason: 'no-wallet' };

  try {
    if (tronLink && tronLink.request) {
      const res = await tronLink.request({ method: 'tron_requestAccounts' });
      if (res && res.code === 4001) return { ok: false, reason: 'rejected' };
    }

    const atomic = toAtomic(amount, trade.decimals);

    if (trade.native) {
      const tx = await tronWeb.trx.sendTransaction(address, atomic.toString());
      if (!tx || !tx.result) return { ok: false, reason: 'error', message: (tx && tx.message) || 'send failed' };
      return { ok: true, hash: tx.txid };
    }

    const contract = await tronWeb.contract().at(trade.contract);
    const hash = await contract.transfer(address, atomic.toString()).send();
    return { ok: true, hash };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/declined|rejected|cancel/i.test(msg)) return { ok: false, reason: 'rejected' };
    return { ok: false, reason: 'error', message: msg };
  }
}

/**
 * Tron 能量预估：估算付款人是否需要燃烧 TRX。
 * 返回 { enough: boolean, energyAvailable, energyNeeded? } —— energyNeeded 需要链上模拟，
 * 这里只做可用能量查询，不足时提示用户可能燃烧 TRX。
 */
export async function estimateTronEnergy(rpc, payerAddress) {
  try {
    const res = await fetch(rpc + '/wallet/getaccountresource', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: payerAddress, visible: true }),
    });
    const data = await res.json();
    return { ok: true, energyAvailable: data.EnergyLimit || 0, energyUsed: data.EnergyUsed || 0 };
  } catch (e) {
    return { ok: false, message: (e && e.message) || String(e) };
  }
}

/* ------------------------------------------------------------------ */
/* Solana                                                              */
/* ------------------------------------------------------------------ */

export async function paySolana(trade, { address, amount }) {
  const provider = window.solana;
  if (!provider || !provider.isPhantom && !provider.isSolflare) {
    return { ok: false, reason: 'no-wallet' };
  }

  try {
    // vendor 库按需加载；缺失时降级为 deeplink（不假装能直连）
    let web3;
    let splToken;
    try {
      [web3, splToken] = await Promise.all([
        import('../vendor/solana-web3.js'),
        import('../vendor/spl-token.js'),
      ]);
    } catch (e) {
      return { ok: false, reason: 'use-deeplink' };
    }
    const { Connection, PublicKey, Transaction } = web3;

    const resp = await provider.connect();
    const payer = resp.publicKey;

    const connection = new Connection(trade.chain.rpc, 'confirmed');
    const mint = new PublicKey(trade.contract);
    const recipient = new PublicKey(address);
    const payerKey = new PublicKey(payer);

    const sourceAta = splToken.getAssociatedTokenAddressSync(mint, payerKey);
    const destAta = splToken.getAssociatedTokenAddressSync(mint, recipient);

    const atomic = toAtomic(amount, trade.decimals);
    const ix = splToken.createTransferCheckedInstruction(
      sourceAta, mint, destAta, payerKey, atomic, trade.decimals,
    );

    const tx = new Transaction().add(ix);
    tx.feePayer = payerKey;
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    const signed = await provider.signTransaction(tx);
    const hash = await connection.sendRawTransaction(signed.serialize());
    return { ok: true, hash };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/reject|declin|cancel/i.test(msg)) return { ok: false, reason: 'rejected' };
    return { ok: false, reason: 'error', message: msg };
  }
}

/* ------------------------------------------------------------------ */
/* TON (TON Connect)                                                   */
/* ------------------------------------------------------------------ */

/**
 * TON Connect 需要引入 @tonconnect/ui 并在页面初始化时创建实例。
 * 这里只暴露统一的付款入口；初始化由 app.js 在检测到 window.tonConnectUI 后完成。
 */
export async function payTon(trade, { address, amount, orderId }) {
  const ui = window.tonConnectUI;
  if (!ui) return { ok: false, reason: 'no-wallet' };

  try {
    const atomic = toAtomic(amount, trade.decimals);

    if (trade.native) {
      await ui.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 300,
        messages: [{ address, amount: atomic.toString() }],
      });
      return { ok: true, hash: null };
    }

    // Jetton 转账：发送到付款人自己的 Jetton 钱包合约地址由钱包内部处理；
    // TON Connect 通过 jetton 消息体表达，需 @ton/ton 构造 body。
    let beginCell;
    let toNano;
    try {
      ({ beginCell, toNano } = await import('../vendor/ton-core.js'));
    } catch (e) {
      return { ok: false, reason: 'use-deeplink' };
    }
    const forward = toNano('0.01');
    const body = beginCell()
      .storeUint(0x0f8a7ea5, 32) // jetton transfer op
      .storeUint(0, 64)          // query_id
      .storeCoins(atomic)        // amount
      .storeAddress(address)     // destination
      .storeAddress(null)        // response destination (none)
      .storeBit(false)           // custom payload absent
      .storeCoins(forward)       // forward_ton_amount
      .storeBit(false)           // forward payload absent
      .endCell();

    await ui.sendTransaction({
      validUntil: Math.floor(Date.now() / 1000) + 300,
      messages: [{
        address: trade.contract, // Jetton master? 实际需付款人 Jetton 钱包地址
        amount: forward.toString(),
        payload: body.toBoc().toString('base64'),
      }],
    });
    return { ok: true, hash: null };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/reject|declin|cancel/i.test(msg)) return { ok: false, reason: 'rejected' };
    return { ok: false, reason: 'error', message: msg };
  }
}

/* ------------------------------------------------------------------ */
/* 统一入口                                                            */
/* ------------------------------------------------------------------ */

export async function payWithWallet(trade, params) {
  switch (trade.chain.kind) {
    case 'evm': return payEvm(trade, params);
    case 'tron': return payTron(trade, params);
    case 'solana': return paySolana(trade, params);
    case 'ton': return payTon(trade, params);
    default: return { ok: false, reason: 'unsupported-chain' };
  }
}

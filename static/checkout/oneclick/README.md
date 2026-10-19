# OneClick 一键支付收银台

一个面向付款人的 BEpusdt 收银台模板：能直接唤起钱包插件完成付款，没有钱包时自动降级为扫码/复制。

## 特性

| 能力 | 说明 |
|---|---|
| **支付方式选择** | 新订单先选币种 + 网络（含实时换算金额），确认后跳转支付页，避免选错网络 |
| **一键拉起钱包** | EVM（MetaMask/OKX/Rabby 等 EIP-1193 钱包）：自动切链、必要时加链，直接发起 ERC-20 转账 |
| **标准扫码** | EVM 用 **EIP-681**；Solana 用 **Solana Pay**；TON 用 `ton://` 深链。MetaMask Mobile / Trust / Phantom 等原生识别 |
| **可靠降级** | 未检测到钱包、移动端、或链无扫码标准（Tron/Aptos）时，展示地址+金额一键复制 |
| **实时状态** | 轮询订单状态：待支付 → 确认中 → 成功/过期，自动切换界面 |
| **深色/浅色** | 跟随系统 `prefers-color-scheme` |
| **零外部依赖** | 二维码、i18n、样式全部内置，无 CDN、无 jQuery |
| **精确金额** | 金额编码全程 BigInt，杜绝浮点误差；BSC 18 位小数已正确处理 |

## 安装

模板支持外部目录热加载：把 `oneclick/` 整个目录放到 BEpusdt 工作目录的 `static/checkout/` 下，重启进程即可，无需重新编译。

```bash
cp -r oneclick /path/to/bepusdt/static/checkout/
```

然后在后台「系统设置 → 收银台模板」选择 **OneClick 一键支付**。

## 目录结构

```
oneclick/
├── checkout.json           # 模板元数据
├── views/checkout.html     # 页面骨架（服务端只注入 trade_id）
└── assets/
    ├── css/checkout.css
    └── js/
        ├── app.js          # 主流程：取单、渲染、轮询、复制
        ├── chains.js       # 链参数表 + 金额编码（toAtomic/fromAtomic）
        ├── uri.js          # EIP-681 / Solana Pay / ton:// 生成
        ├── wallets.js      # 钱包检测与拉起
        ├── qrcode.js       # 内置二维码生成器（SVG）
        └── *.test.js       # 单元测试
```

## 测试

纯函数模块可直接用 Node 运行：

```bash
cd assets/js && node --test
```

覆盖：金额编码（含 6/18 位小数、超精度报错）、各链 URI 格式、ERC-20 calldata、链表完整性。

二维码实现已用独立解码器（jsQR）做端到端交叉验证。

## 钱包兼容性

| 链 | 桌面 | 移动 |
|---|---|---|
| Ethereum / BSC / Polygon / Arbitrum / Base / X Layer / Plasma | EIP-1193 插件 | EIP-681 扫码 |
| Tron | TronLink | 复制地址（无统一扫码标准） |
| Solana | Phantom / Solflare | Solana Pay 扫码 |
| TON | TON Connect（需在宿主页初始化 `window.tonConnectUI`） | `ton://` 深链 |
| Aptos | — | 复制地址 |

> Solana / TON 的插件直连需要可选的 vendor SDK（`assets/vendor/solana-web3.js`、`spl-token.js`、`ton-core.js`）。缺失时会自动降级为唤起钱包 App 的标准 URI，不会报错。

## 服务端依赖

模板会优先读取 `/api/v1/pay/info` 返回的 `network` 字段：

```json
{
  "network": {
    "network": "ethereum",
    "crypto": "USDT",
    "native": false,
    "contract": "0xdac17f958d2ee523a2206206994597c13d831ec7",
    "decimals": 6,
    "chain_id": 1,
    "explorer_fmt": "https://etherscan.io/tx/%s"
  },
  "tx_hash": "0x..."
}
```

`contract` / `decimals` / `chain_id` / `explorer_fmt` 由服务端下发后，新增链或更换合约无需改模板。
旧版服务端缺少这些字段时，模板自动回退到内置链表（`assets/js/chains.js`），仍可正常使用。

`tx_hash` 用于在确认中/成功页展示区块浏览器链接；未支付时为空，不会出现死链。

## 安全

- 只读订单数据 + 只发起转账交易，**不请求** `eth_sign` / `personal_sign`
- 不接触任何私钥；与 BEpusdt 的 watch-only 模型一致
- 无第三方脚本、无遥测

## 已知限制

- Tron 无统一扫码标准，移动端只能复制地址与金额
- TON Jetton 转账的 `forward_ton_amount` 需用真实钱包实测后再启用（当前实现按 0.01 TON 预填）
- 确认数展示依赖 BEpusdt 返回的订单状态，模板本身不查链上确认深度

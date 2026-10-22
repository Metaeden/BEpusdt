package task

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shopspring/decimal"
	"github.com/spf13/cast"
	"github.com/v03413/bepusdt/app/log"
	"github.com/v03413/bepusdt/app/model"
	"github.com/v03413/bepusdt/app/notifier"
)

// 币安 Pay 个人只读模式：
// 管理后台配置收款账号的只读 API Key，任务定时拉取 GET /sapi/v1/pay/transactions 入账流水，
// 以「唯一金额 + 时间窗口」匹配等待支付订单，到账即最终确认（币安内部转账，无链上确认过程）。
// 订单金额唯一性由 CalcTradeAmount 保证（收款 UID 钱包行 + 原子精度递增），金额即指纹。

// binancePayCurrencies 币安 Pay 流水支持的币种（与 BinancePayTool 默认白名单一致）
var binancePayCurrencies = map[string]struct{}{
	"USDT": {},
	"USDC": {},
}

// binanceTxn 对应 GET /sapi/v1/pay/transactions 返回的一条流水。
// 字段以真实账号接口实测为准（文档缺 orderId/note/counterpartyId，实测存在）。
type binanceTxn struct {
	OrderID        string `json:"orderId"`       // 18 位数字，付款方 App 显示的「订单编号」
	Note           string `json:"note"`          // 付款方备注，可能缺省
	OrderType      string `json:"orderType"`     // C2C / PAYOUT / ...
	TransactionID  string `json:"transactionId"` // P_xxxxxxxxxxxxxxxx
	Time           int64  `json:"transactionTime"`
	Amount         string `json:"amount"` // 收款为正、付款为负
	Currency       string `json:"currency"`
	CounterpartyID int64  `json:"counterpartyId"`
	PayerInfo      struct {
		Name      string `json:"name"`
		BinanceID int64  `json:"binanceId"`
	} `json:"payerInfo"`
}

type binancePayClient struct {
	base   string
	key    string
	secret string
	hc     *http.Client
}

func newBinancePayClient(base, key, secret string) *binancePayClient {
	return &binancePayClient{base: strings.TrimRight(base, "/"), key: key, secret: secret, hc: &http.Client{Timeout: 15 * time.Second}}
}

// PayTransactions 拉取 Pay 流水（签名 GET）。limit 上限 100，接口权重 3000/UID。
func (c *binancePayClient) PayTransactions(startMs, endMs int64, limit int) ([]binanceTxn, error) {
	q := url.Values{}
	q.Set("timestamp", strconv.FormatInt(time.Now().UnixMilli(), 10))
	q.Set("recvWindow", "10000")
	q.Set("limit", strconv.Itoa(limit))
	if startMs > 0 {
		q.Set("startTime", strconv.FormatInt(startMs, 10))
	}
	if endMs > 0 {
		q.Set("endTime", strconv.FormatInt(endMs, 10))
	}
	enc := q.Encode()
	mac := hmac.New(sha256.New, []byte(c.secret))
	mac.Write([]byte(enc))

	req, err := http.NewRequest(http.MethodGet, c.base+"/sapi/v1/pay/transactions?"+enc+"&signature="+hex.EncodeToString(mac.Sum(nil)), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-MBX-APIKEY", c.key)

	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("binance HTTP %d: %s", resp.StatusCode, binancePayTruncate(string(body), 300))
	}

	var env struct {
		Data    []binanceTxn `json:"data"`
		Success bool         `json:"success"`
		Message string       `json:"message"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, fmt.Errorf("binance 响应解析失败: %w", err)
	}
	if !env.Success {
		return nil, fmt.Errorf("binance 返回失败: %s", binancePayTruncate(string(body), 300))
	}

	return env.Data, nil
}

func binancePayTruncate(s string, n int) string {
	if len(s) <= n {
		return s
	}

	return s[:n] + "..."
}

var binancePayLastPoll time.Time
var binancePayErrStreak int                    // 连续扫描失败次数，用于失败退避
var binancePayScanMu sync.Mutex                // 串行化扫描 / 回填 / 即时扫描，防止并发核销
var binancePayGateMu sync.Mutex                // 保护节流表
var binancePayForceAt = map[string]time.Time{} // trade_id -> 上次即时扫描时间
var binancePayClaimAt = map[string]time.Time{} // trade_id -> 上次回填尝试时间

func init() {
	// 固定 5 秒空转检查，实际拉流水频率由 binancepay_poll_second 配置决定，便于运行时调整
	Register(Task{Duration: time.Second * 5, Callback: binancePayHandle})
}

// binancePayPollInterval 轮询间隔，下限 10 秒：接口权重 3000/次，间隔过低会被币安限流
func binancePayPollInterval() time.Duration {
	interval := time.Duration(cast.ToInt(model.GetC(model.BinancePayPollSecond))) * time.Second
	if interval <= 0 {
		interval = 30 * time.Second // 配置缺失或非法时的兜底轮询间隔
	}
	if interval < 10*time.Second {
		interval = 10 * time.Second
	}

	return interval
}

func binancePayHandle(context.Context) {
	interval := binancePayPollInterval()
	if binancePayErrStreak > 0 {
		// 失败退避：连续失败时拉长轮询间隔（最多 4 倍），防止密钥错误等场景空烧接口权重
		interval *= time.Duration(1 << min(binancePayErrStreak, 2))
	}
	if time.Since(binancePayLastPoll) < interval {
		return
	}
	binancePayLastPoll = time.Now()

	key := model.GetC(model.BinancePayApiKey)
	secret := model.GetC(model.BinancePayApiSecret)
	if key == "" || secret == "" {
		return
	}

	wallets := model.GetAvailableWallets(model.BinancePayUsdt)
	wallets = append(wallets, model.GetAvailableWallets(model.BinancePayUsdc)...)
	if len(wallets) == 0 {
		return
	}

	// 一个 API Key 只能看到本账号流水：同币种多 UID 钱包会被分配订单但永远收不到款
	for _, tt := range []model.TradeType{model.BinancePayUsdt, model.BinancePayUsdc} {
		if n := len(model.GetAvailableWallets(tt)); n > 1 {
			log.Task.Warn(fmt.Sprintf("币安 Pay %s 配置了 %d 个收款 UID 钱包：一个 API Key 只能看到本账号流水，多余钱包会被分配订单但无法到账，请只保留一个", tt, n))
		}
	}

	client := newBinancePayClient(model.GetC(model.BinancePayApiBase), key, secret)
	if err := binancePayScan(client); err != nil {
		if binancePayErrStreak < 10 {
			binancePayErrStreak++
		}
		log.Task.Error("币安 Pay 流水扫描失败:", err)

		return
	}
	binancePayErrStreak = 0
}

// binancePayScan 拉取流水并尝试匹配订单；没有可收款订单时不调币安接口，节省接口权重
func binancePayScan(c *binancePayClient) error {
	binancePayScanMu.Lock()
	defer binancePayScanMu.Unlock()

	return binancePayScanLocked(c)
}

func binancePayScanLocked(c *binancePayClient) error {
	// 过期单保留在扫描集合：到期瞬间付款的流水可能晚于过期检查到达，对齐链上任务的回溯机制；
	// 时间窗校验（txn <= 过期时间）保持严格，过期后才付的款不会误核销，会走无主入账告警
	var orders []model.Order
	model.Db.Where("status in (?) and trade_type in (?) and expired_at > ?",
		[]int{model.OrderStatusWaiting, model.OrderStatusExpired},
		[]model.TradeType{model.BinancePayUsdt, model.BinancePayUsdc},
		time.Now().Add(model.GetLookbackHour())). // 回溯窗口外的过期单不再捞款，控制流水窗口长度
		Order("created_at asc").Find(&orders)
	if len(orders) == 0 {
		return nil
	}

	amounts := make([]decimal.Decimal, len(orders))
	for i, o := range orders {
		amt, err := decimal.NewFromString(o.Amount)
		if err != nil {
			continue
		}
		amounts[i] = amt
	}

	// 流水窗口从最早的订单创建时间开始，但不早于回溯窗口
	start := orders[0].CreatedAt.Time()
	if lb := time.Now().Add(model.GetLookbackHour()); start.Before(lb) {
		start = lb
	}
	txns, err := c.payTransactionsWindow(start.UnixMilli())
	if err != nil {
		return err
	}

	now := time.Now()
	matched := make(map[int64]struct{})   // 同批次已确认订单，防止重复核销
	credited := make(map[string]struct{}) // 同批次已核销订单的流水号
	for _, t := range txns {
		if t.TransactionID == "" || binancePayTxnConsumed(t.TransactionID) {
			continue
		}

		amt, err := decimal.NewFromString(t.Amount)
		if err != nil || amt.Sign() <= 0 {
			continue // 非入账
		}
		if _, ok := binancePayCurrencies[strings.ToUpper(t.Currency)]; !ok {
			continue // 非支持币种
		}

		for i := range orders {
			o := &orders[i]
			if amounts[i].IsZero() || !amounts[i].Equal(amt) {
				continue
			}
			// 币种必须与订单一致：USDT 订单不能被 USDC 入账核销
			if !strings.EqualFold(string(o.Crypto), t.Currency) {
				continue
			}
			if _, done := matched[o.ID]; done {
				continue
			}
			if !binancePayTimeValid(o, t.Time, now) {
				continue
			}

			// 匹配成功：先进入确认中（落 ref_hash 幂等），再立即终态确认 + 回调商户
			if err := o.MarkConfirming(0, binancePayPayerOf(t), t.TransactionID, time.UnixMilli(t.Time), amt); err != nil {
				log.Task.Warn("币安 Pay 订单确认中状态写入失败:", err)

				continue
			}
			matched[o.ID] = struct{}{}
			credited[t.TransactionID] = struct{}{}
			markFinalConfirmed(*o)
			log.Task.Info(fmt.Sprintf("币安 Pay 订单 %s 已确认到账 %s %s (txn %s)", o.TradeId, amt.String(), t.Currency, t.TransactionID))

			break
		}
	}

	// 无主入账兜底：批次内未被任何订单消费的 USDT/USDC 入账（金额打错、过期后付款等）告警提醒人工处理
	for _, t := range txns {
		if t.TransactionID == "" {
			continue
		}
		if _, ok := credited[t.TransactionID]; ok {
			continue
		}
		amt, err := decimal.NewFromString(t.Amount)
		if err != nil || amt.Sign() <= 0 {
			continue
		}
		if _, ok := binancePayCurrencies[strings.ToUpper(t.Currency)]; !ok {
			continue
		}
		if !model.IsNeedNotifyByTxid(t.TransactionID) { // 已告警过或已被其他订单核销
			continue
		}
		var record = model.NotifyRecord{Txid: t.TransactionID}
		model.Db.Create(&record)
		payer := binancePayPayerOf(t)
		log.Task.Warn(fmt.Sprintf("币安 Pay 无主入账 %s %s (txn %s 付款方 %s)，未匹配任何订单，请人工核对", amt.String(), t.Currency, t.TransactionID, payer))
		notifier.UnmatchedPayIncome(strings.ToUpper(t.Currency), amt, t.TransactionID, payer, time.UnixMilli(t.Time))
	}

	return nil
}

// payTransactionsWindow 拉取自 startMs 以来的流水，满 100 条时向前翻页（最多 5 页），按时间升序返回
func (c *binancePayClient) payTransactionsWindow(startMs int64) ([]binanceTxn, error) {
	seen := make(map[string]struct{})
	var all []binanceTxn
	var endMs int64
	for page := 0; page < 5; page++ {
		txns, err := c.PayTransactions(startMs, endMs, 100)
		if err != nil {
			return nil, err
		}

		var minT int64
		for _, t := range txns {
			key := t.TransactionID
			if key == "" {
				key = t.OrderID
			}
			if key == "" {
				continue
			}
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			all = append(all, t)
			if minT == 0 || t.Time < minT {
				minT = t.Time
			}
		}

		if len(txns) < 100 || minT == 0 {
			break
		}
		endMs = minT - 1
	}

	return all, nil
}

// binancePayTimeValid 交易时间必须落在 (订单创建, 订单过期] 窗口内，
// 并允许与币安服务器存在 2 分钟以内的正向时钟偏差
func binancePayTimeValid(o *model.Order, txnMs int64, now time.Time) bool {
	if txnMs <= 0 || txnMs < o.CreatedAt.Time().UnixMilli() || txnMs > o.ExpiredAt.UnixMilli() {
		return false
	}

	return txnMs <= now.Add(2*time.Minute).UnixMilli()
}

// binancePayTxnConsumed 流水是否已被任何订单核销（ref_hash 全表幂等）
func binancePayTxnConsumed(txnID string) bool {
	var count int64
	model.Db.Model(&model.Order{}).Where("ref_hash = ?", txnID).Limit(1).Count(&count)

	return count > 0
}

// binancePayPayerOf 付款方标识：payerInfo.binanceId 优先，缺失退回 counterpartyId
func binancePayPayerOf(t binanceTxn) string {
	if t.PayerInfo.BinanceID > 0 {
		return strconv.FormatInt(t.PayerInfo.BinanceID, 10)
	}

	return strconv.FormatInt(t.CounterpartyID, 10)
}

// BinancePayTestConn 管理后台「测试连接」：用当前配置拉一次流水，验证 Key/Secret 是否有效。
// 返回窗口内的流水条数便于确认配置指向了正确的账号。
func BinancePayTestConn() (int, error) {
	key := model.GetC(model.BinancePayApiKey)
	secret := model.GetC(model.BinancePayApiSecret)
	if key == "" || secret == "" {
		return 0, errors.New("请先填写并保存 API Key 与 Secret")
	}

	client := newBinancePayClient(model.GetC(model.BinancePayApiBase), key, secret)
	txns, err := client.PayTransactions(time.Now().Add(-24*time.Hour).UnixMilli(), 0, 10)
	if err != nil {
		return 0, err
	}

	return len(txns), nil
}

// BinancePayForceScan 收银台「我已完成支付」触发的即时扫描；同一订单 15 秒内只触发一次，防止刷接口权重。
// 异步执行，调用方通过既有轮询观察订单状态变化。
func BinancePayForceScan(tradeID string) error {
	o, ok := model.GetTradeOrder(tradeID)
	if !ok {
		return errors.New("订单不存在")
	}
	if o.TradeType != model.BinancePayUsdt && o.TradeType != model.BinancePayUsdc {
		return errors.New("该订单无需币安 Pay 扫描")
	}
	if o.Status != model.OrderStatusWaiting && o.Status != model.OrderStatusExpired {
		return errors.New("订单状态无需扫描")
	}

	key := model.GetC(model.BinancePayApiKey)
	secret := model.GetC(model.BinancePayApiSecret)
	if key == "" || secret == "" {
		return errors.New("币安 Pay 未配置")
	}

	binancePayGateMu.Lock()
	if time.Since(binancePayForceAt[tradeID]) < 15*time.Second {
		binancePayGateMu.Unlock()

		return nil // 节流窗口内静默成功，前端轮询自会兜底
	}
	binancePayForceAt[tradeID] = time.Now()
	binancePayGateMu.Unlock()

	go func() {
		client := newBinancePayClient(model.GetC(model.BinancePayApiBase), key, secret)
		if err := binancePayScan(client); err != nil {
			log.Task.Error("币安 Pay 即时扫描失败:", err)
		}
	}()

	return nil
}

// BinancePayClaim 付款方金额打错时的自助找回：收银台粘贴币安 App 的 18 位订单编号（或 P_ 流水号），
// 后端在订单时间窗内查找该笔流水，校验通过后核销订单，金额以实际入账为准。
func BinancePayClaim(tradeID, binanceOrderNo string) (model.Order, error) {
	binanceOrderNo = strings.TrimSpace(binanceOrderNo)
	if binanceOrderNo == "" {
		return model.Order{}, errors.New("请输入币安订单编号")
	}

	o, ok := model.GetTradeOrder(tradeID)
	if !ok {
		return model.Order{}, errors.New("订单不存在")
	}
	if o.TradeType != model.BinancePayUsdt && o.TradeType != model.BinancePayUsdc {
		return model.Order{}, errors.New("该订单不支持币安 Pay 回填")
	}
	if o.Status != model.OrderStatusWaiting {
		return model.Order{}, errors.New("订单当前状态不允许回填")
	}

	key := model.GetC(model.BinancePayApiKey)
	secret := model.GetC(model.BinancePayApiSecret)
	if key == "" || secret == "" {
		return model.Order{}, errors.New("币安 Pay 未配置")
	}

	binancePayGateMu.Lock()
	if time.Since(binancePayClaimAt[tradeID]) < 30*time.Second {
		binancePayGateMu.Unlock()

		return model.Order{}, errors.New("操作过于频繁，请稍后再试")
	}
	binancePayClaimAt[tradeID] = time.Now()
	binancePayGateMu.Unlock()

	client := newBinancePayClient(model.GetC(model.BinancePayApiBase), key, secret)

	// 先常规扫描一遍：金额恰好正确时订单会被正常核销，无需回填
	binancePayScanMu.Lock()
	err := binancePayScanLocked(client)
	binancePayScanMu.Unlock()
	if err != nil {
		return model.Order{}, fmt.Errorf("流水拉取失败: %w", err)
	}

	o, ok = model.GetTradeOrder(tradeID) // 扫描可能已改变订单状态，重新读取
	if !ok {
		return model.Order{}, errors.New("订单不存在")
	}
	if o.Status != model.OrderStatusWaiting {
		return o, nil // 已被常规扫描核销（或其他状态变化），返回当前订单即可
	}

	txns, err := client.payTransactionsWindow(o.CreatedAt.Time().UnixMilli())
	if err != nil {
		return model.Order{}, fmt.Errorf("流水拉取失败: %w", err)
	}

	now := time.Now()
	for _, t := range txns {
		if t.TransactionID == "" {
			continue
		}
		if t.OrderID != binanceOrderNo && t.TransactionID != binanceOrderNo {
			continue
		}
		amt, err := decimal.NewFromString(t.Amount)
		if err != nil || amt.Sign() <= 0 {
			return model.Order{}, errors.New("该编号不是一笔入账流水")
		}
		if !strings.EqualFold(string(o.Crypto), t.Currency) {
			return model.Order{}, errors.New("流水币种与订单不一致")
		}
		if binancePayTxnConsumed(t.TransactionID) {
			return model.Order{}, errors.New("该流水已被其他订单使用")
		}
		if !binancePayTimeValid(&o, t.Time, now) {
			return model.Order{}, errors.New("流水不在订单有效时间范围内")
		}

		binancePayScanMu.Lock()
		defer binancePayScanMu.Unlock()

		if err := o.MarkConfirming(0, binancePayPayerOf(t), t.TransactionID, time.UnixMilli(t.Time), amt); err != nil {
			return model.Order{}, err
		}
		// 回填场景金额与订单不一致，以实际入账为准（列级更新，避免 Save 重写 created_at）
		o.Amount = amt.StringFixed(2) // 币安 Pay 金额精度固定两位
		if rate, err := decimal.NewFromString(o.Rate); err == nil && rate.IsPositive() {
			o.Money = rate.Mul(amt).StringFixed(2) // 法币金额同样固定两位
		}
		if err := model.Db.Model(&o).Updates(map[string]any{"amount": o.Amount, "money": o.Money}).Error; err != nil {
			return model.Order{}, err
		}
		markFinalConfirmed(o)
		o.Status = model.OrderStatusSuccess // markFinalConfirmed 按值传参，回写本地状态
		log.Task.Info(fmt.Sprintf("币安 Pay 订单 %s 回填编号 %s 核销，实际到账 %s %s", o.TradeId, binanceOrderNo, amt.String(), t.Currency))

		return o, nil
	}

	return model.Order{}, errors.New("未找到该编号的流水，请确认编号无误且付款时间在订单有效期内")
}

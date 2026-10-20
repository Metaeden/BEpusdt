package task

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/shopspring/decimal"
	"github.com/spf13/cast"
	"github.com/v03413/bepusdt/app/log"
	"github.com/v03413/bepusdt/app/model"
)

// 币安 Pay 个人只读模式：
// 管理后台配置收款账号的只读 API Key，任务定时拉取 GET /sapi/v1/pay/transactions 入账流水，
// 以「唯一金额 + 时间窗口」匹配等待支付订单，到账即最终确认（币安内部转账，无链上确认过程）。
// 订单金额唯一性由 CalcTradeAmount 保证（收款 UID 钱包行 + 原子精度递增），金额即指纹。

const binancePayCurrency = "USDT"

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

func init() {
	// 固定 5 秒空转检查，实际拉流水频率由 binancepay_poll_second 配置决定，便于运行时调整
	Register(Task{Duration: time.Second * 5, Callback: binancePayHandle})
}

func binancePayHandle(context.Context) {
	interval := time.Duration(cast.ToInt(model.GetC(model.BinancePayPollSecond))) * time.Second
	if interval <= 0 {
		interval = 30 * time.Second // 配置缺失或非法时的兜底轮询间隔
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
	if len(wallets) == 0 {
		return
	}

	client := newBinancePayClient(model.GetC(model.BinancePayApiBase), key, secret)
	if err := binancePayScan(client); err != nil {
		log.Task.Error("币安 Pay 流水扫描失败:", err)
	}
}

// binancePayScan 拉取流水并尝试匹配订单；没有待支付订单时不调币安接口，节省接口权重
func binancePayScan(c *binancePayClient) error {
	var orders []model.Order
	model.Db.Where("status = ? and trade_type = ?", model.OrderStatusWaiting, model.BinancePayUsdt).
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

	txns, err := c.payTransactionsWindow(orders[0].CreatedAt.Time().UnixMilli())
	if err != nil {
		return err
	}

	now := time.Now()
	matched := make(map[int64]struct{}) // 同批次已确认订单，防止重复核销
	for _, t := range txns {
		if t.TransactionID == "" || binancePayTxnConsumed(t.TransactionID) {
			continue
		}

		amt, err := decimal.NewFromString(t.Amount)
		if err != nil || amt.Sign() <= 0 || !strings.EqualFold(t.Currency, binancePayCurrency) {
			continue // 非入账或非 USDT
		}

		for i := range orders {
			o := &orders[i]
			if amounts[i].IsZero() || !amounts[i].Equal(amt) {
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
			markFinalConfirmed(*o)
			log.Task.Info(fmt.Sprintf("币安 Pay 订单 %s 已确认到账 %s %s (txn %s)", o.TradeId, amt.String(), t.Currency, t.TransactionID))

			break
		}
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

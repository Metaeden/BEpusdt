package task

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/shopspring/decimal"

	"github.com/v03413/bepusdt/app/model"
)

const testBinanceSecret = "test-secret"
const testBinanceKey = "test-key"
const testBinanceUID = "387453979"

// mockBinancePay 模拟币安 /sapi/v1/pay/transactions（校验签名与请求头）与商户 /notify 回调端点
type mockBinancePay struct {
	txns    []binanceTxn
	lastQ   url.Values
	reqAuth bool // 是否携带合法的 API Key 与签名
}

func (m *mockBinancePay) handler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/notify" {
		_, _ = w.Write([]byte("ok"))

		return
	}

	q := r.URL.Query()
	m.lastQ = q

	sig := q.Get("signature")
	q.Del("signature")
	mac := hmac.New(sha256.New, []byte(testBinanceSecret))
	mac.Write([]byte(r.URL.RawQuery[:len(r.URL.RawQuery)-len("&signature="+sig)]))
	expect := hex.EncodeToString(mac.Sum(nil))
	m.reqAuth = sig == expect && r.Header.Get("X-MBX-APIKEY") == testBinanceKey

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": m.txns})
}

func newBinancePayTestClient(t *testing.T, m *mockBinancePay) (*binancePayClient, string) {
	t.Helper()

	srv := httptest.NewServer(http.HandlerFunc(m.handler))
	t.Cleanup(srv.Close)

	return newBinancePayClient(srv.URL, testBinanceKey, testBinanceSecret), srv.URL
}

func createBinancePayWallet(t *testing.T) model.Wallet {
	t.Helper()

	return createBinancePayWalletFor(t, model.BinancePayUsdt)
}

func createBinancePayWalletFor(t *testing.T, tradeType model.TradeType) model.Wallet {
	t.Helper()

	wa := model.Wallet{Name: "币安收款", Status: model.WaStatusEnable, Address: testBinanceUID, TradeType: string(tradeType)}
	if err := wa.Validate(); err != nil {
		t.Fatalf("wallet validate: %v", err)
	}
	if err := model.Db.Create(&wa).Error; err != nil {
		t.Fatalf("create wallet: %v", err)
	}

	return wa
}

func createBinancePayOrder(t *testing.T, tradeID, amount string, created time.Time) model.Order {
	t.Helper()

	return createBinancePayOrderNotify(t, tradeID, amount, created, "", model.OrderApiTypeAdmin, model.BinancePayUsdt, model.USDT)
}

func createBinancePayOrderNotify(t *testing.T, tradeID, amount string, created time.Time, notifyUrl, apiType string, tradeType model.TradeType, crypto model.Crypto) model.Order {
	t.Helper()

	return createTestOrder(t, model.Order{
		OrderId:      "merchant-" + tradeID,
		TradeId:      tradeID,
		TradeType:    tradeType,
		Fiat:         model.CNY,
		Crypto:       crypto,
		Rate:         "7.20",
		Amount:       amount,
		Money:        "88.85",
		Address:      testBinanceUID,
		MatchAddress: testBinanceUID,
		ApiType:      apiType,
		NotifyUrl:    notifyUrl,
		Status:       model.OrderStatusWaiting,
		ExpiredAt:    created.Add(20 * time.Minute),
	}, created)
}

func incomingBinanceTxn(txnID, amount string, at time.Time) binanceTxn {
	return incomingBinanceTxnCur(txnID, amount, at, "USDT")
}

func incomingBinanceTxnCur(txnID, amount string, at time.Time, currency string) binanceTxn {
	txn := binanceTxn{
		OrderID:        "45202192200000000" + txnID[len(txnID)-1:],
		OrderType:      "C2C",
		TransactionID:  txnID,
		Time:           at.UnixMilli(),
		Amount:         amount,
		Currency:       currency,
		CounterpartyID: 1163000000,
	}
	txn.PayerInfo.Name = "tester"
	txn.PayerInfo.BinanceID = 1163000000

	return txn
}

func TestBinancePaySignedRequest(t *testing.T) {
	initTaskTestEnv(t, nil)
	createBinancePayWallet(t)

	var m = &mockBinancePay{}
	client, _ := newBinancePayTestClient(t, m)
	created := time.Now().Add(-time.Minute)
	createBinancePayOrder(t, "bp-sign-1", "12.34", created)

	if err := binancePayScan(client); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if !m.reqAuth {
		t.Fatalf("请求未携带合法签名或 API Key: %v", m.lastQ)
	}
	if m.lastQ.Get("recvWindow") != "10000" {
		t.Fatalf("recvWindow = %s", m.lastQ.Get("recvWindow"))
	}
	if m.lastQ.Get("startTime") != strconv.FormatInt(created.UnixMilli(), 10) {
		t.Fatalf("startTime = %s", m.lastQ.Get("startTime"))
	}
	if m.lastQ.Get("limit") != "100" {
		t.Fatalf("limit = %s", m.lastQ.Get("limit"))
	}
}

func TestBinancePayMatchAndConfirm(t *testing.T) {
	initTaskTestEnv(t, nil)
	createBinancePayWallet(t)

	created := time.Now().Add(-5 * time.Minute)
	m := &mockBinancePay{txns: []binanceTxn{
		incomingBinanceTxn("P_match0000000001", "12.34", created.Add(time.Minute)),
	}}
	client, baseURL := newBinancePayTestClient(t, m)
	createBinancePayOrderNotify(t, "bp-match-1", "12.34", created, baseURL+"/notify", model.OrderApiTypeEpusdt, model.BinancePayUsdt, model.USDT)

	if err := binancePayScan(client); err != nil {
		t.Fatalf("scan: %v", err)
	}

	o := getTestOrder(t, "bp-match-1")
	if o.Status != model.OrderStatusSuccess {
		t.Fatalf("status = %d, want success", o.Status)
	}
	if o.RefHash != "P_match0000000001" {
		t.Fatalf("ref_hash = %q", o.RefHash)
	}
	if o.FromAddress != "1163000000" {
		t.Fatalf("from_address = %q", o.FromAddress)
	}

	waitOrderNotified(t, "bp-match-1")
}

func TestBinancePayNotMatched(t *testing.T) {
	initTaskTestEnv(t, nil)
	createBinancePayWallet(t)

	created := time.Now().Add(-5 * time.Minute)
	o := createBinancePayOrder(t, "bp-miss-1", "12.34", created)

	var cases = []struct {
		name string
		txn  binanceTxn
	}{
		{"金额不符", incomingBinanceTxn("P_miss00000000001", "12.35", created.Add(time.Minute))},
		{"付款为负不认", func() binanceTxn {
			txn := incomingBinanceTxn("P_miss00000000002", "-12.34", created.Add(time.Minute))
			txn.PayerInfo.BinanceID = 0

			return txn
		}()},
		{"币种不符", func() binanceTxn {
			txn := incomingBinanceTxn("P_miss00000000003", "12.34", created.Add(time.Minute))
			txn.Currency = "FDUSD"

			return txn
		}()},
		{"早于订单创建", incomingBinanceTxn("P_miss00000000004", "12.34", created.Add(-time.Minute))},
		{"晚于订单过期", incomingBinanceTxn("P_miss00000000005", "12.34", o.ExpiredAt.Add(time.Minute))},
	}

	for _, c := range cases {
		m := &mockBinancePay{txns: []binanceTxn{c.txn}}
		client, _ := newBinancePayTestClient(t, m)
		if err := binancePayScan(client); err != nil {
			t.Fatalf("%s: scan: %v", c.name, err)
		}

		got := getTestOrder(t, "bp-miss-1")
		if got.Status != model.OrderStatusWaiting {
			t.Fatalf("%s: status = %d, want waiting", c.name, got.Status)
		}
	}
}

func TestBinancePayIdempotent(t *testing.T) {
	initTaskTestEnv(t, nil)
	createBinancePayWallet(t)

	created := time.Now().Add(-5 * time.Minute)
	createBinancePayOrder(t, "bp-idem-1", "12.34", created)
	createBinancePayOrder(t, "bp-idem-2", "12.34", created.Add(time.Second)) // 同金额的另一个订单

	txn := incomingBinanceTxn("P_idem0000000001", "12.34", created.Add(time.Minute))
	m := &mockBinancePay{txns: []binanceTxn{txn}}
	client, _ := newBinancePayTestClient(t, m)
	if err := binancePayScan(client); err != nil {
		t.Fatalf("scan: %v", err)
	}

	first := getTestOrder(t, "bp-idem-1")
	if first.Status != model.OrderStatusSuccess {
		t.Fatalf("first status = %d, want success", first.Status)
	}

	second := getTestOrder(t, "bp-idem-2")
	if second.Status != model.OrderStatusWaiting {
		t.Fatalf("second status = %d, want waiting", second.Status)
	}

	// 同一流水再次扫描，不得核销第二个订单
	if err := binancePayScan(client); err != nil {
		t.Fatalf("rescan: %v", err)
	}

	second = getTestOrder(t, "bp-idem-2")
	if second.Status != model.OrderStatusWaiting {
		t.Fatalf("second status after rescan = %d, want waiting", second.Status)
	}
}

func TestBinancePayEmptyConfNoop(t *testing.T) {
	initTaskTestEnv(t, nil)

	// 无配置、无钱包：空转不报错（模拟 binancePayHandle 的门槛判断）
	if model.GetAvailableWallets(model.BinancePayUsdt) == nil {
		t.Fatal("wallets slice should not be nil")
	}
	if model.GetC(model.BinancePayApiKey) != "" {
		t.Fatal("api key should be empty")
	}
}

func TestBinancePayUsdcMatchAndConfirm(t *testing.T) {
	initTaskTestEnv(t, nil)
	createBinancePayWalletFor(t, model.BinancePayUsdc)

	created := time.Now().Add(-5 * time.Minute)
	m := &mockBinancePay{txns: []binanceTxn{
		incomingBinanceTxnCur("P_usdc00000000001", "25.50", created.Add(time.Minute), "USDC"),
	}}
	client, baseURL := newBinancePayTestClient(t, m)
	createBinancePayOrderNotify(t, "bp-usdc-1", "25.50", created, baseURL+"/notify", model.OrderApiTypeEpusdt, model.BinancePayUsdc, model.USDC)

	if err := binancePayScan(client); err != nil {
		t.Fatalf("scan: %v", err)
	}

	o := getTestOrder(t, "bp-usdc-1")
	if o.Status != model.OrderStatusSuccess {
		t.Fatalf("status = %d, want success", o.Status)
	}
	if o.RefHash != "P_usdc00000000001" {
		t.Fatalf("ref_hash = %q", o.RefHash)
	}

	waitOrderNotified(t, "bp-usdc-1")
}

// USDC 入账不得核销 USDT 订单
func TestBinancePayCurrencyMismatch(t *testing.T) {
	initTaskTestEnv(t, nil)
	createBinancePayWallet(t)

	created := time.Now().Add(-5 * time.Minute)
	createBinancePayOrder(t, "bp-cur-1", "12.34", created)

	m := &mockBinancePay{txns: []binanceTxn{
		incomingBinanceTxnCur("P_cur000000000001", "12.34", created.Add(time.Minute), "USDC"),
	}}
	client, _ := newBinancePayTestClient(t, m)
	if err := binancePayScan(client); err != nil {
		t.Fatalf("scan: %v", err)
	}

	o := getTestOrder(t, "bp-cur-1")
	if o.Status != model.OrderStatusWaiting {
		t.Fatalf("status = %d, want waiting", o.Status)
	}
}

// 过期单的迟到款恢复：到期前已付款、流水扫描晚于过期检查的订单仍应被核销（对齐链上回溯机制）
func TestBinancePayExpiredOrderRecovery(t *testing.T) {
	initTaskTestEnv(t, nil)
	createBinancePayWallet(t)

	created := time.Now().Add(-30 * time.Minute)
	o := createBinancePayOrder(t, "bp-late-1", "12.34", created)
	o.SetExpired() // 过期检查先于流水扫描到达

	m := &mockBinancePay{txns: []binanceTxn{
		incomingBinanceTxn("P_late00000000001", "12.34", created.Add(time.Minute)), // 过期前付款
	}}
	client, _ := newBinancePayTestClient(t, m)
	if err := binancePayScan(client); err != nil {
		t.Fatalf("scan: %v", err)
	}

	got := getTestOrder(t, "bp-late-1")
	if got.Status != model.OrderStatusSuccess {
		t.Fatalf("status = %d, want success", got.Status)
	}
	if got.RefHash != "P_late00000000001" {
		t.Fatalf("ref_hash = %q", got.RefHash)
	}
}

// 过期后才付的款不核销订单，但必须触发无主入账告警（落 bep_notify 去重表）
func TestBinancePayUnmatchedIncomeAlert(t *testing.T) {
	initTaskTestEnv(t, nil)
	createBinancePayWallet(t)

	created := time.Now().Add(-30 * time.Minute)
	o := createBinancePayOrder(t, "bp-orphan-1", "12.34", created)
	o.SetExpired()

	// 金额不符的入账（过期后 1 分钟付款，任何订单都无法匹配）
	m := &mockBinancePay{txns: []binanceTxn{
		incomingBinanceTxn("P_orph00000000001", "99.99", o.ExpiredAt.Add(time.Minute)),
	}}
	client, _ := newBinancePayTestClient(t, m)
	if err := binancePayScan(client); err != nil {
		t.Fatalf("scan: %v", err)
	}

	var count int64
	model.Db.Model(&model.NotifyRecord{}).Where("txid = ?", "P_orph00000000001").Count(&count)
	if count != 1 {
		t.Fatalf("notify record count = %d, want 1", count)
	}

	// 再次扫描不得重复告警
	if err := binancePayScan(client); err != nil {
		t.Fatalf("rescan: %v", err)
	}
	model.Db.Model(&model.NotifyRecord{}).Where("txid = ?", "P_orph00000000001").Count(&count)
	if count != 1 {
		t.Fatalf("notify record count after rescan = %d, want 1", count)
	}
}

// 满页（>100 条）流水时的向前翻页与去重
func TestBinancePayPagination(t *testing.T) {
	initTaskTestEnv(t, nil)
	createBinancePayWallet(t)

	created := time.Now().Add(-time.Hour)
	base := created.Add(10 * time.Second)
	var all []binanceTxn
	for i := 0; i < 150; i++ {
		all = append(all, incomingBinanceTxn(fmt.Sprintf("P_page%07dxxxxx", i), "1.00", base.Add(time.Duration(i)*time.Second)))
	}

	// 模拟真实接口：按时间倒序返回 limit 条，支持 startTime/endTime 过滤
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/notify" {
			_, _ = w.Write([]byte("ok"))

			return
		}
		q := r.URL.Query()
		startMs, _ := strconv.ParseInt(q.Get("startTime"), 10, 64)
		endMs, _ := strconv.ParseInt(q.Get("endTime"), 10, 64)
		limit, _ := strconv.Atoi(q.Get("limit"))

		var page []binanceTxn
		for _, txn := range all {
			if txn.Time >= startMs && (endMs == 0 || txn.Time <= endMs) {
				page = append(page, txn)
			}
		}
		sort.Slice(page, func(i, j int) bool { return page[i].Time > page[j].Time })
		if len(page) > limit {
			page = page[:limit]
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": page})
	}))
	defer srv.Close()

	client := newBinancePayClient(srv.URL, testBinanceKey, testBinanceSecret)
	got, err := client.payTransactionsWindow(created.UnixMilli())
	if err != nil {
		t.Fatalf("window: %v", err)
	}
	if len(got) != 150 {
		t.Fatalf("got %d txns, want 150", len(got))
	}

	seen := make(map[string]struct{})
	for _, g := range got {
		if _, ok := seen[g.TransactionID]; ok {
			t.Fatalf("duplicate txn %s", g.TransactionID)
		}
		seen[g.TransactionID] = struct{}{}
	}
}

// 金额打错时回填币安订单编号自助找回，金额以实际入账为准
func TestBinancePayClaim(t *testing.T) {
	created := time.Now().Add(-5 * time.Minute)
	m := &mockBinancePay{txns: []binanceTxn{
		incomingBinanceTxn("P_claim000000001", "50.00", created.Add(time.Minute)), // 实付 50，订单 12.34
	}}
	_, baseURL := newBinancePayTestClient(t, m)
	initTaskTestEnv(t, nil)
	// SetK 为 upsert：binancepay key/secret 无默认行，initTaskTestEnv 的 Update 写不进去
	model.SetK(model.BinancePayApiKey, testBinanceKey)
	model.SetK(model.BinancePayApiSecret, testBinanceSecret)
	model.SetK(model.BinancePayApiBase, baseURL)
	model.RefreshC()
	createBinancePayWallet(t)
	o := createBinancePayOrder(t, "bp-claim-1", "12.34", created)

	// 币安 App 展示的 18 位订单编号（incomingBinanceTxn 按 txnID 尾字符构造）
	got, err := BinancePayClaim(o.TradeId, "452021922000000001")
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if got.Status != model.OrderStatusSuccess {
		t.Fatalf("status = %d, want success", got.Status)
	}
	if got.RefHash != "P_claim000000001" {
		t.Fatalf("ref_hash = %q", got.RefHash)
	}
	if got.Amount != "50.00" {
		t.Fatalf("amount = %s, want 50.00（以实际入账为准）", got.Amount)
	}
	if got.Money != "360.00" {
		t.Fatalf("money = %s, want 360.00", got.Money)
	}

	// 编号不存在时报错且订单不受影响
	o2 := createBinancePayOrder(t, "bp-claim-2", "12.34", created)
	if _, err := BinancePayClaim(o2.TradeId, "999999999999999999"); err == nil {
		t.Fatal("claim with unknown order no should fail")
	}
	if g := getTestOrder(t, "bp-claim-2"); g.Status != model.OrderStatusWaiting {
		t.Fatalf("status = %d, want waiting", g.Status)
	}
}

// TON USDT 的 MatchAddress（Jetton 钱包地址）必须参与金额锁键，否则同金额订单无法区分
func TestCalcTradeAmountTonMatchAddrLock(t *testing.T) {
	initTaskTestEnv(t, nil)

	created := time.Now().Add(-time.Minute)
	createTestOrder(t, model.Order{
		OrderId:      "merchant-ton-lock",
		TradeId:      "ton-lock-1",
		TradeType:    model.UsdtTon,
		Fiat:         model.CNY,
		Crypto:       model.USDT,
		Rate:         "7.20",
		Amount:       "12.34",
		Money:        "88.85",
		Address:      "UQD4vPSVBpeCN0e1Y8vXT8cH8Bm4H9U1uK1uQ1uK1uQ1uK1u",
		MatchAddress: "EQJettonWalletAddressDifferentFromOwner12345",
		ApiType:      model.OrderApiTypeAdmin,
		Status:       model.OrderStatusWaiting,
		ExpiredAt:    created.Add(20 * time.Minute),
	}, created)

	wallets := []model.Wallet{{Address: "UQD4vPSVBpeCN0e1Y8vXT8cH8Bm4H9U1uK1uQ1uK1uQ1uK1u", MatchAddr: "EQJettonWalletAddressDifferentFromOwner12345", TradeType: string(model.UsdtTon)}}
	_, amount, err := model.CalcTradeAmount(wallets, decimal.NewFromFloat(7.20), model.OrderParams{
		TradeType: model.UsdtTon,
		Money:     decimal.NewFromFloat(88.85),
	})
	if err != nil {
		t.Fatalf("calc: %v", err)
	}
	if amount == "12.34" {
		t.Fatal("TON MatchAddress 金额锁未生效：同金额订单将无法区分核销")
	}
	if amount != "12.35" {
		t.Fatalf("amount = %s, want 12.35", amount)
	}
}

// GORM Save 会按 CreatedAt 字段名约定重写 created_at：状态流转必须用列级更新保持创建时间不变
func TestOrderStatusChangeKeepsCreatedAt(t *testing.T) {
	initTaskTestEnv(t, nil)

	created := time.Now().Add(-30 * time.Minute)
	o := createBinancePayOrder(t, "bp-keep-1", "12.34", created)
	want := o.CreatedAt.Time()

	o.SetExpired()
	if got := getTestOrder(t, "bp-keep-1"); !got.CreatedAt.Time().Equal(want) {
		t.Fatalf("SetExpired created_at drift: %v != %v", got.CreatedAt.Time(), want)
	}

	if err := o.MarkConfirming(0, "1163000000", "P_keep0000000001", time.Now(), decimal.NewFromFloat(12.34)); err != nil {
		t.Fatalf("mark confirming: %v", err)
	}
	if got := getTestOrder(t, "bp-keep-1"); !got.CreatedAt.Time().Equal(want) {
		t.Fatalf("MarkConfirming created_at drift: %v != %v", got.CreatedAt.Time(), want)
	} else if got.Status != model.OrderStatusConfirming {
		t.Fatalf("status = %d, want confirming", got.Status)
	}

	o.SetSuccess()
	if got := getTestOrder(t, "bp-keep-1"); !got.CreatedAt.Time().Equal(want) {
		t.Fatalf("SetSuccess created_at drift: %v != %v", got.CreatedAt.Time(), want)
	}

	o.SetNotifyState(1)
	if got := getTestOrder(t, "bp-keep-1"); !got.CreatedAt.Time().Equal(want) {
		t.Fatalf("SetNotifyState created_at drift: %v != %v", got.CreatedAt.Time(), want)
	}
}

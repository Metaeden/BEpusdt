package task

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"

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

	wa := model.Wallet{Name: "币安收款", Status: model.WaStatusEnable, Address: testBinanceUID, TradeType: string(model.BinancePayUsdt)}
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

	return createBinancePayOrderNotify(t, tradeID, amount, created, "", model.OrderApiTypeAdmin)
}

func createBinancePayOrderNotify(t *testing.T, tradeID, amount string, created time.Time, notifyUrl, apiType string) model.Order {
	t.Helper()

	return createTestOrder(t, model.Order{
		OrderId:      "merchant-" + tradeID,
		TradeId:      tradeID,
		TradeType:    model.BinancePayUsdt,
		Fiat:         model.CNY,
		Crypto:       model.USDT,
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
	txn := binanceTxn{
		OrderID:        "45202192200000000" + txnID[len(txnID)-1:],
		OrderType:      "C2C",
		TransactionID:  txnID,
		Time:           at.UnixMilli(),
		Amount:         amount,
		Currency:       "USDT",
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
	createBinancePayOrderNotify(t, "bp-match-1", "12.34", created, baseURL+"/notify", model.OrderApiTypeEpusdt)

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

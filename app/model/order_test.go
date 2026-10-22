package model

import (
	"encoding/json"
	"testing"
)

// networkOf 把 Network() 返回的匿名结构体转成 map，便于断言 JSON 字段。
func networkOf(t *testing.T, tradeType TradeType) map[string]any {
	t.Helper()

	o := Order{TradeType: tradeType}
	raw, err := json.Marshal(o.Network())
	if err != nil {
		t.Fatalf("%s Network() marshal: %v", tradeType, err)
	}

	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("%s Network() unmarshal: %v", tradeType, err)
	}

	return m
}

func TestOrderNetworkEvmChainParams(t *testing.T) {
	cases := []struct {
		tradeType TradeType
		network   string
		chainID   float64
		decimals  float64
		contract  string
	}{
		{UsdtErc20, "ethereum", 1, 6, "0xdac17f958d2ee523a2206206994597c13d831ec7"},
		{UsdtBep20, "bsc", 56, 18, "0x55d398326f99059ff775485246999027b3197955"},
		{UsdcPolygon, "polygon", 137, 6, "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"},
		{UsdtArbitrum, "arbitrum", 42161, 6, "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"},
		{UsdcBase, "base", 8453, 6, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"},
		{UsdtXlayer, "xlayer", 196, 6, "0x779ded0c9e1022225f8e0630b35a9b54be713736"},
		{UsdtPlasma, "plasma", 9745, 6, "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb"},
	}

	for _, c := range cases {
		m := networkOf(t, c.tradeType)

		if got := m["network"]; got != c.network {
			t.Errorf("%s network = %v, want %s", c.tradeType, got, c.network)
		}
		if got := m["chain_id"]; got != c.chainID {
			t.Errorf("%s chain_id = %v, want %v", c.tradeType, got, c.chainID)
		}
		if got := m["decimals"]; got != c.decimals {
			t.Errorf("%s decimals = %v, want %v", c.tradeType, got, c.decimals)
		}
		if got := m["contract"]; got != c.contract {
			t.Errorf("%s contract = %v, want %s", c.tradeType, got, c.contract)
		}
		if got := m["native"]; got != false {
			t.Errorf("%s native = %v, want false", c.tradeType, got)
		}
	}
}

func TestOrderNetworkNonEvm(t *testing.T) {
	tron := networkOf(t, UsdtTrc20)
	if _, ok := tron["chain_id"]; ok {
		t.Errorf("tron 不应有 chain_id，got %v", tron["chain_id"])
	}
	if tron["decimals"] != float64(6) {
		t.Errorf("tron decimals = %v, want 6", tron["decimals"])
	}
	if tron["explorer_fmt"] != "https://tronscan.org/#/transaction/%s" {
		t.Errorf("tron explorer_fmt = %v", tron["explorer_fmt"])
	}

	sol := networkOf(t, UsdtSolana)
	if _, ok := sol["chain_id"]; ok {
		t.Errorf("solana 不应有 chain_id，got %v", sol["chain_id"])
	}
}

func TestOrderNetworkNative(t *testing.T) {
	gram := networkOf(t, TonGram)
	if gram["native"] != true {
		t.Errorf("ton.gram native = %v, want true", gram["native"])
	}
	if gram["decimals"] != float64(9) {
		t.Errorf("ton.gram decimals = %v, want 9", gram["decimals"])
	}
	if _, ok := gram["contract"]; ok {
		t.Errorf("原生币不应返回 contract，got %v", gram["contract"])
	}

	trx := networkOf(t, TronTrx)
	if trx["native"] != true || trx["decimals"] != float64(6) {
		t.Errorf("tron.trx = %v", trx)
	}
}

func TestOrderNetworkUnknownTradeType(t *testing.T) {
	m := networkOf(t, TradeType("doge.unknown"))
	if m["network"] != "" || m["decimals"] != float64(0) {
		t.Errorf("未知交易类型应返回零值结构，got %v", m)
	}
	if _, ok := m["chain_id"]; ok {
		t.Errorf("未知交易类型不应有 chain_id，got %v", m["chain_id"])
	}
	if _, ok := m["contract"]; ok {
		t.Errorf("未知交易类型不应有 contract，got %v", m["contract"])
	}
}

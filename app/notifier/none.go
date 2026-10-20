package notifier

import (
	"time"

	"github.com/shopspring/decimal"
	"github.com/v03413/bepusdt/app/model"
)

type None struct{}

func (None) Initialize(params string) error {
	return nil
}

func (None) Success(order model.Order) {}

func (None) NotifyFail(order model.Order, reason string) {}

func (None) NonOrderTransfer(trans model.TronTransfer, wa model.Wallet) {

}

func (None) UnmatchedPayIncome(currency string, amount decimal.Decimal, txnID, payer string, at time.Time) {

}

func (None) TronResourceChange(res model.TronResource) {

}

func (None) Welcome() {

}

func (None) Test() error {
	return nil
}

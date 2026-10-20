package admin

import (
	"fmt"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/v03413/bepusdt/app/handler/base"
	"github.com/v03413/bepusdt/app/model"
)

type Wallet struct {
}

type wAddReq struct {
	Name        string `json:"name"`
	Remark      string `json:"remark"`
	Address     string `json:"address" binding:"required"`
	TradeType   string `json:"trade_type" binding:"required"`
	OtherNotify uint8  `json:"other_notify"`
}

type wModReq struct {
	base.IDRequest
	Name        *string `json:"name"`
	Status      *uint8  `json:"status"`
	Address     *string `json:"address"`
	Remark      *string `json:"remark"`
	TradeType   *string `json:"trade_type"`
	OtherNotify *uint8  `json:"other_notify"`
}

type wListReq struct {
	base.ListRequest
	Name    string `json:"name"`
	Address string `json:"address"`
	Trade   string `json:"trade_type"`
}

// binancePayWalletUnique 币安 Pay 同币种只允许一个启用中的收款 UID 钱包：
// 一个 API Key 只能看到本账号流水，多 UID 会轮流分配订单却永远收不到款
func binancePayWalletUnique(tradeType string, excludeID int64) error {
	if tradeType != string(model.BinancePayUsdt) && tradeType != string(model.BinancePayUsdc) {
		return nil
	}

	var db = model.Db.Model(&model.Wallet{}).Where("trade_type = ? and status = ?", tradeType, model.WaStatusEnable)
	if excludeID > 0 {
		db = db.Where("id != ?", excludeID)
	}

	var count int64
	db.Count(&count)
	if count > 0 {
		return fmt.Errorf("币安 Pay 同一币种只能配置一个启用中的收款 UID 钱包（一个 API Key 只能看到本账号流水），请先停用或删除已有钱包")
	}

	return nil
}

func (Wallet) Add(ctx *gin.Context) {
	var req wAddReq
	if err := ctx.ShouldBindJSON(&req); err != nil {
		base.BadRequest(ctx, err.Error())

		return
	}

	if !model.IsSupportedTradeType(model.TradeType(req.TradeType)) {
		base.BadRequest(ctx, fmt.Sprintf("不支持的交易类型: %s", req.TradeType))

		return
	}

	if err := binancePayWalletUnique(req.TradeType, 0); err != nil {
		base.BadRequest(ctx, err.Error())

		return
	}

	var wallet = model.Wallet{
		Name:        strings.TrimSpace(req.Name),
		Remark:      req.Remark,
		Address:     strings.TrimSpace(req.Address),
		MatchAddr:   strings.TrimSpace(req.Address),
		TradeType:   req.TradeType,
		Status:      model.WaStatusEnable,
		OtherNotify: req.OtherNotify,
	}

	if err := wallet.Validate(); err != nil {
		base.BadRequest(ctx, err.Error())

		return
	}

	if err := model.Db.Create(&wallet).Error; err != nil {
		base.Error(ctx, err)

		return
	}

	base.Response(ctx, 200, "success")
}

func (Wallet) List(ctx *gin.Context) {
	var req wListReq
	if err := ctx.ShouldBind(&req); err != nil {
		base.Response(ctx, 400, err.Error())

		return
	}

	var data []model.Wallet
	var db = model.Db

	if req.Name != "" {
		db = db.Where("name LIKE ?", "%"+req.Name+"%")
	}
	if req.Address != "" {
		db = db.Where("address LIKE ?", "%"+req.Address+"%")
	}
	if req.Trade != "" {
		db = db.Where("trade_type LIKE ?", "%"+req.Trade+"%")
	}

	var total int64

	db.Model(&model.Wallet{}).Count(&total)

	err := db.Limit(req.Size).Offset((req.Page - 1) * req.Size).Order("id " + req.Sort).Find(&data).Error
	if err != nil {
		base.Response(ctx, 400, err.Error())

		return
	}

	base.Response(ctx, 200, data, total)
}

func (Wallet) Mod(ctx *gin.Context) {
	var req wModReq
	if err := ctx.ShouldBindJSON(&req); err != nil {
		base.BadRequest(ctx, err.Error())

		return
	}

	var w model.Wallet
	model.Db.Where("id = ?", req.ID).Find(&w)
	if w.ID == 0 {
		base.BadRequest(ctx, "钱包不存在")

		return
	}

	if req.Name != nil {
		w.Name = strings.TrimSpace(*req.Name)
	}
	if req.Remark != nil {
		w.Remark = *req.Remark
	}
	if req.Address != nil {
		w.Address = strings.TrimSpace(*req.Address)
		w.MatchAddr = strings.TrimSpace(*req.Address)
	}
	if req.TradeType != nil {
		if !model.IsSupportedTradeType(model.TradeType(*req.TradeType)) {
			base.BadRequest(ctx, fmt.Sprintf("不支持的交易类型: %s", *req.TradeType))

			return
		}

		if err := binancePayWalletUnique(*req.TradeType, w.ID); err != nil {
			base.BadRequest(ctx, err.Error())

			return
		}

		w.TradeType = *req.TradeType
	}
	if req.Status != nil {
		if *req.Status == model.WaStatusEnable {
			if err := binancePayWalletUnique(w.TradeType, w.ID); err != nil {
				base.BadRequest(ctx, err.Error())

				return
			}
		}

		w.Status = *req.Status
	}
	if req.OtherNotify != nil {
		w.OtherNotify = *req.OtherNotify
	}

	if err := w.Validate(); err != nil {
		base.BadRequest(ctx, err.Error())

		return
	}

	if err := model.Db.Save(&w).Error; err != nil {
		base.Error(ctx, err)

		return
	}

	base.Response(ctx, 200, "修改成功")
}

func (Wallet) Del(ctx *gin.Context) {
	var req base.IDRequest
	if err := ctx.ShouldBindJSON(&req); err != nil {
		base.BadRequest(ctx, err.Error())

		return
	}

	model.Db.Where("id = ?", req.ID).Delete(&model.Wallet{})

	base.Response(ctx, 200, "删除成功")
}

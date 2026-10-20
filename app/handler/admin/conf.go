package admin

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/v03413/bepusdt/app/conf"
	"github.com/v03413/bepusdt/app/handler/base"
	"github.com/v03413/bepusdt/app/model"
	"github.com/v03413/bepusdt/app/notifier"
	"github.com/v03413/bepusdt/app/task"
	"github.com/v03413/bepusdt/app/utils"
)

type Conf struct {
}

type confReq struct {
	Key   string `json:"key" binding:"required"`
	Value string `json:"value"`
}

type confGetsReq struct {
	Keys []string `json:"keys" binding:"required"`
}

type confSetsReq []confReq

type notifierConf struct {
	Channel string          `json:"channel" binding:"required"`
	Params  json.RawMessage `json:"params" binding:"required"`
}

// binancePaySecretMask 币安 Pay Secret 回显掩码：gets 时以掩码替代明文，sets 收到掩码视为未修改
const binancePaySecretMask = "******"

func maskBinancePaySecret(k model.ConfKey, v string) string {
	if k == model.BinancePayApiSecret && v != "" {
		return binancePaySecretMask
	}

	return v
}

func (Conf) Set(ctx *gin.Context) {
	var req confReq
	if err := ctx.ShouldBindJSON(&req); err != nil {
		base.BadRequest(ctx, err.Error())

		return
	}

	key := model.ConfKey(strings.TrimSpace(req.Key))
	if key == model.BinancePayApiSecret && strings.TrimSpace(req.Value) == binancePaySecretMask {
		base.Ok(ctx, "配置成功")

		return
	}
	model.SetK(key, strings.TrimSpace(req.Value))

	defer model.RefreshC()

	base.Ok(ctx, "配置成功")
}

func (Conf) Get(ctx *gin.Context) {
	var req confReq
	if err := ctx.ShouldBindJSON(&req); err != nil {
		base.BadRequest(ctx, err.Error())

		return
	}

	key := model.ConfKey(strings.TrimSpace(req.Key))
	base.Ok(ctx, gin.H{"key": req.Key, "value": maskBinancePaySecret(key, model.GetK(key))})
}

func (Conf) Del(ctx *gin.Context) {
	var req confReq
	if err := ctx.ShouldBindJSON(&req); err != nil {
		base.BadRequest(ctx, err.Error())

		return
	}

	model.Db.Where("k = ?", req.Key).Delete(&model.Conf{})

	base.Ok(ctx, "删除成功")
}

func (Conf) Gets(ctx *gin.Context) {
	var req confGetsReq
	if err := ctx.ShouldBindJSON(&req); err != nil {
		base.BadRequest(ctx, err.Error())

		return
	}

	var items = make([]model.Conf, 0)
	model.Db.Where("k IN ?", req.Keys).Find(&items)

	var data = gin.H{}
	for _, item := range items {
		data[string(item.K)] = maskBinancePaySecret(item.K, item.V)
	}

	base.Ok(ctx, data)
}

func (Conf) Sets(ctx *gin.Context) {
	var req confSetsReq
	if err := ctx.ShouldBindJSON(&req); err != nil {
		base.BadRequest(ctx, err.Error())

		return
	}

	keys := make([]string, 0)
	data := make([]model.Conf, 0)
	for _, item := range req {
		var k = strings.TrimSpace(item.Key)
		var v = strings.TrimSpace(item.Value)
		// Secret 掩码视为未修改：不删除不重建，保留数据库原值
		if k == string(model.BinancePayApiSecret) && v == binancePaySecretMask {
			continue
		}
		keys = append(keys, k)
		data = append(data, model.Conf{K: model.ConfKey(k), V: v})
	}

	model.Db.Where("k IN ?", keys).Delete(&model.Conf{})
	model.Db.Create(&data)

	defer model.RefreshC()

	base.Ok(ctx, "配置成功")
}

func (Conf) Rpc(ctx *gin.Context) {
	var keys = []model.ConfKey{
		model.RpcEndpointPlasma,
		model.RpcEndpointBsc,
		model.RpcEndpointSolana,
		model.RpcEndpointXlayer,
		model.RpcEndpointPolygon,
		model.RpcEndpointArbitrum,
		model.RpcEndpointEthereum,
		model.RpcEndpointBase,
		model.RpcEndpointAptos,
		model.RpcEndpointTron,
		model.RpcEndpointTronGridApiKey,
		model.RpcGlobalConfigUrlTon,
	}

	var rpc = make(map[model.ConfKey]string)
	var items = make([]model.Conf, 0)
	model.Db.Where("k IN ?", keys).Find(&items)
	for _, item := range items {
		rpc[item.K] = item.V
	}

	base.Ok(ctx, gin.H{
		"rpc":   rpc,
		"stats": conf.GetStats(),
	})
}

func (Conf) Notifier(ctx *gin.Context) {
	var req notifierConf
	if err := ctx.ShouldBindJSON(&req); err != nil {
		base.BadRequest(ctx, err.Error())

		return
	}

	var keys = []string{string(model.NotifierChannel), string(model.NotifierParams)}
	model.Db.Where("k IN ?", keys).Delete(&model.Conf{})
	model.Db.Create(&[]model.Conf{
		{K: model.NotifierChannel, V: req.Channel},
		{K: model.NotifierParams, V: string(req.Params)},
	})

	base.Ok(ctx, "配置成功")
}

func (Conf) NotifierTest(ctx *gin.Context) {
	err := notifier.Test()
	if err != nil {
		base.Ok(ctx, "发送测试失败："+err.Error())

		return
	}

	base.Ok(ctx, "发送测试成功")
}

// BinancePayTest 币安 Pay「测试连接」：用当前保存的配置拉一次流水，验证 Key/Secret 是否有效。
// 失败走 400，前端拦截器会直接以 msg 弹错
func (Conf) BinancePayTest(ctx *gin.Context) {
	count, err := task.BinancePayTestConn()
	if err != nil {
		base.BadRequest(ctx, "连接失败："+err.Error())

		return
	}

	base.Ok(ctx, fmt.Sprintf("连接成功，已读取到 %d 条 Pay 流水，配置有效", count))
}

func (Conf) CheckoutList(ctx *gin.Context) {
	base.Ok(ctx, model.CheckoutList())
}

func (Conf) ResetApiAuthToken(ctx *gin.Context) {
	model.SetK(model.ApiAuthToken, strings.ToUpper(utils.Md5String(utils.StrSha256(time.Now().String()))))

	base.Ok(ctx, "重置成功")
}

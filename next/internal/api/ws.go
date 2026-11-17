package api

import (
	"net/http"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// 桌面应用本机通信; 生产加固时在此校验 token (对齐旧 /ws/agents 鉴权语义)
	CheckOrigin: func(r *http.Request) bool { return true },
}

// 类型别名: server.go 中 writeWS(handleWS) 直接使用
type wsConn = websocket.Conn

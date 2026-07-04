import React, { useState, useEffect } from 'react';
import type { ChannelTestLog } from '../../data/providersRegistry';

// 10. 消息连接注入
export default function ChannelsTab() {
  const [selectedChannels, setSelectedChannels] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('soloforge_channels_active');
      return saved ? JSON.parse(saved) : { feishu: true, wechat: false, qq: false };
    } catch (_) {
      return { feishu: true, wechat: false, qq: false };
    }
  });

  const [feishuUrl, setFeishuUrl] = useState(() => localStorage.getItem('soloforge_feishu_url') || '');
  const [wechatUrl, setWechatUrl] = useState(() => localStorage.getItem('soloforge_wechat_url') || '');
  const [qqUrl, setQqUrl] = useState(() => localStorage.getItem('soloforge_qq_url') || '');

  // Persistent saving effects
  useEffect(() => {
    localStorage.setItem('soloforge_channels_active', JSON.stringify(selectedChannels));
  }, [selectedChannels]);

  useEffect(() => {
    localStorage.setItem('soloforge_feishu_url', feishuUrl);
  }, [feishuUrl]);

  useEffect(() => {
    localStorage.setItem('soloforge_wechat_url', wechatUrl);
  }, [wechatUrl]);

  useEffect(() => {
    localStorage.setItem('soloforge_qq_url', qqUrl);
  }, [qqUrl]);

  const [channelLogs, setChannelLogs] = useState<ChannelTestLog[]>([
    { time: new Date().toLocaleTimeString(), type: 'info', text: '消息连接网络诊断系统初始化完毕。' }
  ]);

  const [isTestingChannel, setIsTestingChannel] = useState<string | null>(null);

  const testChannelConnection = async (type: 'feishu' | 'wechat' | 'qq') => {
    const channelNames = { feishu: '飞书机器人', wechat: '企业微信', qq: 'QQ Webhook' };
    const url = type === 'feishu' ? feishuUrl : type === 'wechat' ? wechatUrl : qqUrl;

    const timestamp = () => new Date().toLocaleTimeString();

    // Log check active
    if (!selectedChannels[type]) {
      setChannelLogs(prev => [
        { time: timestamp(), type: 'error', text: `[${channelNames[type]}] 通道暂未启用。请先勾选右上角开关以激活此通道。` },
        ...prev
      ]);
      return;
    }

    if (!url) {
      setChannelLogs(prev => [
        { time: timestamp(), type: 'error', text: `[${channelNames[type]}] 诊断失败：未配置 Webhook URL 接口地址。` },
        ...prev
      ]);
      return;
    }

    setIsTestingChannel(type);
    setChannelLogs(prev => [
      { time: timestamp(), type: 'info', text: `[${channelNames[type]}] 正在发起网络诊断连接。请求端终点 -> ${url}` },
      ...prev
    ]);

    try {
      const response = await fetch('/api/channels/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelType: type, webhookUrl: url })
      });

      const data = await response.json();

      if (data.success) {
        setChannelLogs(prev => [
          { time: timestamp(), type: 'success', text: `[${channelNames[type]}] 诊断测试成功！服务器返回成功状态 [HTTP ${data.status}]。远程返回报文: ${data.apiReply || '{}'}` },
          ...prev
        ]);
      } else {
        setChannelLogs(prev => [
          {
            time: timestamp(),
            type: 'error',
            text: `[${channelNames[type]}] 网络测试返回错误 [HTTP ${data.status || 'ERROR'}]。详情: ${data.error || data.apiReply || '未知投递故障'}`
          },
          ...prev
        ]);
      }
    } catch (err: any) {
      setChannelLogs(prev => [
        { time: timestamp(), type: 'error', text: `[${channelNames[type]}] 本地通讯异常: ${err.message || '连接失败'}` },
        ...prev
      ]);
    } finally {
      setIsTestingChannel(null);
    }
  };

  return (
    <div className="space-y-4 animate-fadeIn flex flex-col h-full max-h-[580px] overflow-hidden">
      <div className="border-b border-[var(--color-outline)]/20 pb-3 shrink-0">
        <h3 className="text-base font-bold text-[var(--color-on-surface)]">消息连接注入</h3>
        <p className="text-xs text-on-surface/50 mt-1">关联飞书、企业微信机器人或自定义 QQ Webhook，提供一击即合的主信道报警与事件归档</p>
      </div>

      {/* 3 columns Channels configuration row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 shrink-0">
        {/* Channel Card: Feishu */}
        <div className="p-4 bg-[var(--color-surface-bright)]/45 border border-[var(--color-outline)]/15 rounded-xl flex flex-col gap-3 relative overflow-hidden group">
          <div className="flex items-center justify-between">
            <span className="text-[13.5px] font-bold text-[var(--color-on-surface)] flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${selectedChannels.feishu ? 'bg-blue-400 animate-pulse shadow-[0_0_8px_rgba(96,165,250,0.6)]' : 'bg-on-surface/30'}`} />
              <span>飞书机器人</span>
            </span>
            <input
              type="checkbox"
              id="feishu-active-chk"
              className="accent-[var(--color-primary)] cursor-pointer w-4 h-4 rounded"
              checked={selectedChannels.feishu}
              onChange={() => setSelectedChannels({...selectedChannels, feishu: !selectedChannels.feishu})}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="feishu-url-input" className="text-[10px] uppercase font-mono tracking-wider text-on-surface/40">Webhook URL 地址</label>
            <input
              type="text"
              id="feishu-url-input"
              placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
              className="w-full bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded px-2.5 py-1 text-xs font-mono text-[var(--color-on-surface)] focus:border-[var(--color-primary)]/50 focus:outline-none transition-all placeholder:text-on-surface/20"
              value={feishuUrl}
              onChange={(e) => setFeishuUrl(e.target.value)}
            />
          </div>

          <div className="flex items-center justify-between mt-1">
            <span className="text-[10px] text-on-surface/40 leading-tight">支持飞书群自定义助手机器人</span>
            <button
              onClick={() => testChannelConnection('feishu')}
              disabled={isTestingChannel !== null}
              className="text-[11px] font-semibold bg-[var(--color-primary)]/15 hover:bg-[var(--color-primary)]/20 active:scale-95 text-[var(--color-primary)] hover:text-[var(--color-on-surface)] px-3 py-1 rounded transition-all cursor-pointer font-sans flex items-center gap-1.5 disabled:opacity-40"
            >
              {isTestingChannel === 'feishu' ? (
                <>
                  <span className="w-2 h-2 border-2 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin" />
                  <span>诊断中</span>
                </>
              ) : (
                <span>测试连接</span>
              )}
            </button>
          </div>
        </div>

        {/* Channel Card: WeChat */}
        <div className="p-4 bg-[var(--color-surface-bright)]/45 border border-[var(--color-outline)]/15 rounded-xl flex flex-col gap-3 relative overflow-hidden group">
          <div className="flex items-center justify-between">
            <span className="text-[13.5px] font-bold text-[var(--color-on-surface)] flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${selectedChannels.wechat ? 'bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.6)]' : 'bg-on-surface/30'}`} />
              <span>企业微信</span>
            </span>
            <input
              type="checkbox"
              id="wechat-active-chk"
              className="accent-[var(--color-primary)] cursor-pointer w-4 h-4 rounded"
              checked={selectedChannels.wechat}
              onChange={() => setSelectedChannels({...selectedChannels, wechat: !selectedChannels.wechat})}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="wechat-url-input" className="text-[10px] uppercase font-mono tracking-wider text-on-surface/40">Webhook Key/地址</label>
            <input
              type="text"
              id="wechat-url-input"
              placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send..."
              className="w-full bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded px-2.5 py-1 text-xs font-mono text-[var(--color-on-surface)] focus:border-[var(--color-primary)]/50 focus:outline-none transition-all placeholder:text-on-surface/20"
              value={wechatUrl}
              onChange={(e) => setWechatUrl(e.target.value)}
            />
          </div>

          <div className="flex items-center justify-between mt-1">
            <span className="text-[10px] text-on-surface/40 leading-tight">兼容 WxPusher / 企微 Webhook</span>
            <button
              onClick={() => testChannelConnection('wechat')}
              disabled={isTestingChannel !== null}
              className="text-[11px] font-semibold bg-[var(--color-primary)]/15 hover:bg-[var(--color-primary)]/20 active:scale-95 text-[var(--color-primary)] hover:text-[var(--color-on-surface)] px-3 py-1 rounded transition-all cursor-pointer font-sans flex items-center gap-1.5 disabled:opacity-40"
            >
              {isTestingChannel === 'wechat' ? (
                <>
                  <span className="w-2 h-2 border-2 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin" />
                  <span>诊断中</span>
                </>
              ) : (
                <span>测试连接</span>
              )}
            </button>
          </div>
        </div>

        {/* Channel Card: QQ Webhook */}
        <div className="p-4 bg-[var(--color-surface-bright)]/45 border border-[var(--color-outline)]/15 rounded-xl flex flex-col gap-3 relative overflow-hidden group">
          <div className="flex items-center justify-between">
            <span className="text-[13.5px] font-bold text-[var(--color-on-surface)] flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${selectedChannels.qq ? 'bg-red-400 animate-pulse shadow-[0_0_8px_rgba(248,113,113,0.6)]' : 'bg-on-surface/30'}`} />
              <span>QQ Webhook</span>
            </span>
            <input
              type="checkbox"
              id="qq-active-chk"
              className="accent-[var(--color-primary)] cursor-pointer w-4 h-4 rounded"
              checked={selectedChannels.qq}
              onChange={() => setSelectedChannels({...selectedChannels, qq: !selectedChannels.qq})}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="qq-url-input" className="text-[10px] uppercase font-mono tracking-wider text-on-surface/40">HTTP Webhook 地址</label>
            <input
              type="text"
              id="qq-url-input"
              placeholder="http://127.0.0.1:5700/send_private_msg?..."
              className="w-full bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded px-2.5 py-1 text-xs font-mono text-[var(--color-on-surface)] focus:border-[var(--color-primary)]/50 focus:outline-none transition-all placeholder:text-on-surface/20"
              value={qqUrl}
              onChange={(e) => setQqUrl(e.target.value)}
            />
          </div>

          <div className="flex items-center justify-between mt-1">
            <span className="text-[10px] text-on-surface/40 leading-tight">挂载 QBot 常用轻量事件回调</span>
            <button
              onClick={() => testChannelConnection('qq')}
              disabled={isTestingChannel !== null}
              className="text-[11px] font-semibold bg-[var(--color-primary)]/15 hover:bg-[var(--color-primary)]/20 active:scale-95 text-[var(--color-primary)] hover:text-[var(--color-on-surface)] px-3 py-1 rounded transition-all cursor-pointer font-sans flex items-center gap-1.5 disabled:opacity-40"
            >
              {isTestingChannel === 'qq' ? (
                <>
                  <span className="w-2 h-2 border-2 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin" />
                  <span>诊断中</span>
                </>
              ) : (
                <span>测试连接</span>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Connection Logger terminal section */}
      <div className="flex-1 flex flex-col min-h-0 bg-black/90 rounded-2xl border border-[var(--color-outline)]/15 p-4 font-mono select-text relative">
        {/* Console Header */}
        <div className="flex items-center justify-between border-b border-white/5 pb-2.5 mb-2.5 shrink-0 select-none">
          <div className="flex items-center gap-2 text-xs text-zinc-400 font-semibold font-sans">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
            <span>📡 消息连接网络诊断控制台 (Persistent Webhook Logger)</span>
          </div>

          <button
            onClick={() => setChannelLogs([{ time: new Date().toLocaleTimeString(), type: 'info', text: '终端日志已清空。消息网络连接引擎就绪。' }])}
            className="text-[10px] text-zinc-550 hover:text-white transition-all bg-white/5 hover:bg-white/10 px-2 py-0.5 rounded cursor-pointer font-sans"
          >
            清空终端
          </button>
        </div>

        {/* Lines Scroll area */}
        <div className="flex-1 overflow-y-auto space-y-1.5 text-xs text-zinc-300 pr-1 select-text scrollbar-thin">
          {channelLogs.map((log, lIdx) => (
            <div key={lIdx} className="flex gap-2.5 items-start leading-relaxed hover:bg-white/5 px-1 py-0.5 rounded transition-colors break-all">
              <span className="text-zinc-500 select-none shrink-0">[{log.time}]</span>
              <span className={`shrink-0 font-bold select-none ${
                log.type === 'success'
                  ? 'text-emerald-400'
                  : log.type === 'error'
                  ? 'text-rose-400'
                  : 'text-sky-400'
              }`}>
                {log.type === 'success' ? '✔ [SUCCESS]' : log.type === 'error' ? '✘ [ERROR]' : 'ℹ [INFO]'}
              </span>
              <span className="flex-1 text-zinc-300 font-sans text-[11.5px] leading-relaxed">{log.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

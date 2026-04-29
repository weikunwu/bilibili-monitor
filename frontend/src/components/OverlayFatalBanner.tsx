// OBS 浏览器源里足够显眼的告警卡：黑底红框 + 字号大到主播扫一眼能看清，
// 但只占顶部一条不挡画面主体。三个 overlay 页（Gifts / Effects / WeeklyTasks）
// 共用这个组件，做到 403 token 失效 / 410 房间到期 / 缺 token 时主播一眼能看到、
// 不再吃哑巴亏继续推流。
export function OverlayFatalBanner({ title, hint }: { title: string; hint: string }) {
  return (
    <div
      style={{
        position: 'fixed',
        top: 16, left: '50%', transform: 'translateX(-50%)',
        background: 'rgba(20, 0, 0, 0.92)',
        border: '2px solid #ef5350',
        borderRadius: 8,
        padding: '12px 18px',
        color: '#fff',
        fontFamily: '-apple-system, "PingFang SC", sans-serif',
        textAlign: 'center',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.5)',
        maxWidth: '80%',
        zIndex: 9999,
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 600, color: '#ef5350', marginBottom: 4 }}>
        ⚠ {title}
      </div>
      <div style={{ fontSize: 13, opacity: 0.9 }}>{hint}</div>
    </div>
  )
}

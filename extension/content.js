// 注入到 fanbox 页面：
//  ① 提供 API 代理（页面域发请求，扩展域直接请求会被 400）
//  ② 放两个「一眼能看懂在干什么」的入口按钮：下载本篇 / 下载该画师全部
;(() => {
  if (window.__fbFolderDlInjected) return
  window.__fbFolderDlInjected = true

  /** 从当前页面认出 { creatorId, postId } */
  function detect() {
    const out = { creatorId: '', postId: '' }
    try {
      // /@xxx/posts/123
      let m = location.pathname.match(/\/@([A-Za-z0-9_-]+)\/posts\/(\d+)/)
      if (m) {
        out.creatorId = m[1]
        out.postId = m[2]
        return out
      }
      // xxx.fanbox.cc/posts/123
      m = location.hostname.match(/^([A-Za-z0-9_-]+)\.fanbox\.cc$/)
      if (m) {
        out.creatorId = m[1]
        const mp = location.pathname.match(/\/posts\/(\d+)/)
        if (mp) out.postId = mp[1]
        return out
      }
      // /@xxx
      m = location.pathname.match(/\/@([A-Za-z0-9_-]+)/)
      if (m) out.creatorId = m[1]
    } catch (e) {
      /* 忽略 */
    }
    return out
  }

  // ---------------- API 代理 ----------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'fapi' || !msg.url) return
    // 只代理 fanbox 的 API，避免变成任意 URL 的带登录态代理
    let ok = false
    try {
      ok = new URL(msg.url).origin === 'https://api.fanbox.cc'
    } catch (e) {
      ok = false
    }
    if (!ok) {
      sendResponse({ ok: false, error: '只允许 api.fanbox.cc' })
      return
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 30000) // 避免一个卡死的请求拖住整轮
    fetch(msg.url, {
      credentials: 'include',
      signal: ctrl.signal,
      headers: { Accept: 'application/json, text/plain, */*' },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return await r.json()
      })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }))
      .finally(() => clearTimeout(timer))
    return true
  })

  // ---------------- 保活 ----------------
  let keepAliveCtx = null
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'keepalive') return
    try {
      if (keepAliveCtx) {
        keepAliveCtx.resume().catch(() => {})
        return
      }
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return
      const ctx = new Ctx()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      gain.gain.value = 0.0001
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      // 没有用户手势时 AudioContext 会以 suspended 状态创建，必须主动 resume
      ctx.resume().catch(() => {})
      keepAliveCtx = ctx
    } catch (e) {
      /* 自动播放被拦时忽略 */
    }
  })

  // ---------------- 入口按钮 ----------------
  const box = document.createElement('div')
  box.style.cssText =
    'position:fixed;left:8px;bottom:132px;z-index:2147483600;display:flex;flex-direction:column;gap:6px;align-items:flex-start'

  function mkBtn(label, hint, bg, onClick) {
    const b = document.createElement('div')
    b.textContent = label
    b.title = hint
    b.style.cssText =
      'cursor:pointer;background:' +
      bg +
      ';color:#fff;padding:7px 11px;border-radius:999px;font:12px/1.25 sans-serif;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.28);opacity:.95;white-space:nowrap'
    b.addEventListener('click', (ev) => {
      ev.stopPropagation()
      onClick()
    })
    return b
  }

  function fire(mode, info) {
    try {
      chrome.runtime.sendMessage(
        {
          type: 'open-app',
          creatorId: info.creatorId,
          postId: mode === 'post' ? info.postId : '',
          mode: mode,
        },
        () => void chrome.runtime.lastError,
      )
    } catch (e) {
      /* 扩展被重载时忽略 */
    }
  }

  let lastKey = ''
  function render(force) {
    const info = detect()
    const key = info.creatorId + '|' + info.postId
    if (!force && key === lastKey) return
    lastKey = key
    box.textContent = ''
    if (info.postId) {
      box.appendChild(
        mkBtn('📁 下载本篇（' + info.postId + '）', '把这一篇投稿单独存成一个文件夹（含全部图片）', '#1677ff', () =>
          fire('post', info),
        ),
      )
    }
    if (info.creatorId) {
      box.appendChild(
        mkBtn(
          '📁 下载该画师全部投稿',
          '把 ' + info.creatorId + ' 的全部投稿按「每篇一个文件夹」存下来',
          '#0a7d4f',
          () => fire('all', info),
        ),
      )
    }
    if (!info.creatorId) {
      box.appendChild(mkBtn('📁 打开下载工作台', '当前页面认不出画师，打开工作台手动填', '#555', () => fire('all', info)))
    }
  }

  const mount = () => {
    if (!document.documentElement) return
    document.documentElement.appendChild(box)
    render(true)
  }
  if (document.documentElement) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })

  // fanbox 是单页应用，切页面不会重新注入；这里盯着 URL 变化重画按钮
  let lastHref = location.href
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href
      render(true)
    }
  }, 1000)
  window.addEventListener('popstate', () => render(true))
})()

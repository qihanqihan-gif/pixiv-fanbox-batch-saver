// 注入到 pixiv 页面：识别当前页是「作品」还是「画师」，并给出对应入口。
// 说明（实测）：
//  · i.pximg.net 不发 CORS 头，连 pixiv 页面自己 fetch 也会被挡，且要求 Referer = https://www.pixiv.net/。
//    所以图片必须由「扩展页面」去取（靠 host_permissions 绕 CORS）+ declarativeNetRequest 改写 Referer。
//  · 但 /ajax/illust 是**同源**接口，内容脚本里直接 fetch 就能拿到 userId —— 作品页 URL 里没有画师 ID，
//    之前靠 ?u= 猜，猜不到就把空 creatorId 传给工作台（实测会直接坏掉），这里改成落接口查。
// 这个脚本只负责 UI 与「告诉工作台目标是什么」。
;(() => {
  if (window.__pxDlInjected) return
  window.__pxDlInjected = true

  /** 同步能认出的东西：路径 + 查询参数 */
  function detect() {
    const out = { userId: '', illustId: '', kind: '' }
    try {
      const p = location.pathname
      const q = new URLSearchParams(location.search)
      let m = p.match(/\/artworks\/(\d+)/) || p.match(/\/i\/(\d+)/)
      if (m) {
        out.illustId = m[1]
      } else if (/\/novel\/show\.php$/.test(p)) {
        // 小说页：/novel/show.php?id=NNN，同样是"一件作品"
        const id = q.get('id') || ''
        if (/^\d+$/.test(id)) {
          out.illustId = id
          out.kind = 'novel'
        }
      } else {
        const lid = q.get('illust_id') || ''
        if (/^\d+$/.test(lid)) out.illustId = lid
      }
      m = p.match(/\/users\/(\d+)/) || p.match(/\/member_illust\.php/)
      if (m && m[1]) out.userId = m[1]
      if (m && !m[1]) {
        const mid = q.get('id') || ''
        if (/^\d+$/.test(mid)) out.userId = mid
      }
      if (!out.userId) {
        const u = q.get('u') || ''
        if (/^\d+$/.test(u)) out.userId = u
      }
    } catch (e) {
      /* 忽略 */
    }
    return out
  }

  // 作品 ID → 画师 ID。同源接口，一条作品只查一次。
  const uidCache = new Map()
  async function resolveUser(info) {
    if (info.userId) return info.userId
    if (!info.illustId) return ''
    if (uidCache.has(info.illustId)) {
      info.userId = uidCache.get(info.illustId)
      return info.userId
    }
    try {
      // 小说页必须查小说接口：小说 id 和插画 id 是两条独立序列，
      // 用 /ajax/illust/<小说id> 有可能返回**另一件**插画，uid 就认错了
      const api = info.kind === 'novel' ? '/ajax/novel/' : '/ajax/illust/'
      const r = await fetch(api + info.illustId, { credentials: 'same-origin' })
      if (!r.ok) return ''
      const j = await r.json()
      const uid = j && j.body && j.body.userId ? String(j.body.userId) : ''
      if (uid) {
        uidCache.set(info.illustId, uid)
        info.userId = uid
      }
      return uid
    } catch (e) {
      return ''
    }
  }

  const box = document.createElement('div')
  box.id = 'pxdl-box'
  box.style.cssText =
    'position:fixed;left:8px;bottom:132px;z-index:2147483600;display:flex;flex-direction:column;' +
    'gap:6px;align-items:flex-start;pointer-events:none'
  box.style.display = 'none'

  /** 顶部短提示（手机上没有控制台，必须给看得见的反馈） */
  function toast(text, ok) {
    let t = document.getElementById('pxdl-toast')
    if (!t) {
      t = document.createElement('div')
      t.id = 'pxdl-toast'
      t.style.cssText =
        'position:fixed;left:50%;bottom:200px;transform:translateX(-50%);z-index:2147483601;' +
        'color:#fff;padding:9px 14px;border-radius:10px;font:13px/1.35 sans-serif;max-width:80vw;' +
        'text-align:center;pointer-events:none;box-shadow:0 3px 14px rgba(0,0,0,.35)'
      document.documentElement.appendChild(t)
    }
    t.textContent = text
    t.style.background = ok ? 'rgba(10,125,79,.94)' : 'rgba(178,44,44,.94)'
    clearTimeout(toast._t)
    toast._t = setTimeout(() => {
      if (t.parentNode) t.parentNode.removeChild(t)
    }, 2800)
  }

  function mkBtn(label, hint, bg, onClick) {
    const b = document.createElement('div')
    b.textContent = label
    b.title = hint
    b.style.cssText =
      'cursor:pointer;pointer-events:auto;touch-action:manipulation;-webkit-user-select:none;user-select:none;' +
      'background:' + bg + ';color:#fff;padding:7px 11px;border-radius:999px;' +
      'font:12px/1.25 sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.28);opacity:.95;white-space:nowrap'
    // 别让 pixiv 自己的点击/滑动处理吃掉这一下
    const stop = (ev) => ev.stopPropagation()
    ;['touchstart', 'touchend', 'pointerdown', 'mousedown'].forEach((n) => b.addEventListener(n, stop, { passive: true }))
    b.addEventListener('click', (ev) => {
      ev.stopPropagation()
      ev.preventDefault()
      if (b.dataset.busy) return
      b.dataset.busy = '1'
      onClick(b)
    })
    return b
  }

  /** 要点：先把画师 ID 认出来，再交给后台；认不出就明说，不发半截参数 */
  async function fire(mode, info, btn) {
    const label = btn.textContent
    btn.textContent = '识别中…'
    try {
      const uid = await resolveUser(info)
      if (!uid) {
        toast('认不出画师 ID：请打开该作品页或画师主页再点', false)
        return
      }
      if (mode === 'post' && !info.illustId) {
        toast('认不出作品 ID', false)
        return
      }
      const payload = {
        type: 'open-app',
        site: 'pixiv',
        creatorId: uid,
        postId: mode === 'post' ? info.illustId : '',
        mode: mode,
        workKind: info.kind || '',
        pageUrl: location.href,
      }
      const r = await new Promise((res) => {
        try {
          chrome.runtime.sendMessage(payload, (x) => {
            if (chrome.runtime.lastError) res({ ok: false, error: chrome.runtime.lastError.message })
            else res(x || { ok: false, error: '后台没有回应（扩展可能被重新加载过，刷新本页再试）' })
          })
        } catch (e) {
          res({ ok: false, error: String((e && e.message) || e) })
        }
      })
      if (r && r.ok) {
        toast(mode === 'post' ? '已带到工作台：单篇 ' + info.illustId : '已带到工作台：画师 ' + uid + ' 全部', true)
      } else {
        toast('打开工作台失败：' + ((r && r.error) || '未知原因'), false)
      }
    } finally {
      btn.textContent = label
      delete btn.dataset.busy
    }
  }

  let lastKey = ''
  function render(force) {
    const info = detect()
    const key = info.userId + '|' + info.illustId
    if (!force && key === lastKey) return
    lastKey = key
    box.textContent = ''
    if (!info.userId && !info.illustId) {
      box.style.display = 'none'
      return
    }
    box.style.display = 'flex'
    if (info.illustId) {
      box.appendChild(
        mkBtn('📁 下载本篇（' + info.illustId + '）', '把这一篇作品的全部页存成一个文件夹', '#1677ff', (b) =>
          fire('post', info, b),
        ),
      )
    }
    box.appendChild(
      mkBtn('📁 下载该画师全部作品', '把该画师的全部作品按「每篇一个文件夹」存下来', '#0a7d4f', (b) => fire('all', info, b)),
    )
  }

  const mount = () => {
    if (!document.documentElement) return
    document.documentElement.appendChild(box)
    render(true)
  }
  if (document.documentElement) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })

  let lastHref = location.href
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href
      render(true)
    }
  }, 1000)
  window.addEventListener('popstate', () => render(true))
})()

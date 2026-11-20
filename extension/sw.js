// 后台 Service Worker：打开工作台、定位 fanbox 标签页、从页面 URL 认画师
// 说明：API 只能从 fanbox 页面域发起，所以工作台需要借一个 fanbox 标签页做代理。

/** 从 fanbox 页面 URL 里解析 creatorId（主页 /@xxx、投稿 /@xxx/posts/1、子域 xxx.fanbox.cc） */
function parseCreatorFromUrl(u) {
  try {
    const url = new URL(u)
    if (!/(^|\.)fanbox\.cc$/.test(url.hostname)) return ''
    let m = url.pathname.match(/\/@([A-Za-z0-9_-]+)/)
    if (m) return m[1]
    m = url.hostname.match(/^([A-Za-z0-9_-]+)\.fanbox\.cc$/)
    if (m) return m[1]
  } catch (e) {
    /* 忽略 */
  }
  return ''
}

/** 找到已经打开的工作台标签页 */
async function findAppTab() {
  const base = chrome.runtime.getURL('app.html')
  const tabs = await chrome.tabs.query({})
  const t = tabs.find((x) => x.id && x.url && x.url.indexOf(base) === 0)
  return t || null
}

/** 打开（或聚焦）工作台；有 creatorId 就把「站点 / 画师 / 单篇」目标带过去 */
async function openApp(creatorId, postId, mode, site, kind) {
  const base = chrome.runtime.getURL('app.html')
  const usedSite = site === 'pixiv' ? 'pixiv' : 'fanbox'
  const found = await findAppTab()
  if (found) {
    await chrome.tabs.update(found.id, { active: true })
    if (creatorId) {
      // 页面已经开着时不要刷新它（会打断正在进行的下载），改用消息填字段
      chrome.runtime
        .sendMessage({
          type: 'set-target',
          site: usedSite,
          creatorId: creatorId,
          postId: postId || '',
          mode: mode || 'all',
          kind: kind || '',
        })
        .catch(() => {})
    }
    return found.id
  }
  const q = ['site=' + usedSite]
  if (creatorId) q.push('creator=' + encodeURIComponent(creatorId))
  if (postId) q.push('post=' + encodeURIComponent(postId))
  if (mode) q.push('mode=' + encodeURIComponent(mode))
  if (kind) q.push('kind=' + encodeURIComponent(kind))
  const url = base + '?' + q.join('&')
  const t = await chrome.tabs.create({ url })
  return t.id
}

/** 找到可用的 fanbox 标签页；没有就新建一个（工作台靠它做 API 代理） */
async function ensureFanboxTab(creatorId) {
  const tabs = await chrome.tabs.query({ url: '*://*.fanbox.cc/*' })
  const usable = tabs.filter((t) => t.id && t.url && !t.url.includes('chrome-extension://') && !t.discarded)
  // 优先用**没在看**的标签页做代理：代理页在被自动 reload 修复，
  // 挑中用户正在阅读的那一页会把它刷掉
  const pick = usable.find((t) => !t.active) || usable[0]
  if (pick) return pick.id
  const url = creatorId
    ? 'https://www.fanbox.cc/@' + encodeURIComponent(creatorId)
    : 'https://www.fanbox.cc/'
  const t = await chrome.tabs.create({ url, active: false })
  return t.id
}

chrome.action.onClicked.addListener(() => {
  openApp('').catch(() => {})
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return
  if (msg.type === 'open-app') {
    openApp(msg.creatorId || '', msg.postId || '', msg.mode || '', msg.site || '', msg.workKind || '')
      .then((id) => sendResponse({ ok: true, id }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }))
    return true
  }
  if (msg.type === 'ensure-fanbox-tab') {
    ensureFanboxTab(msg.creatorId)
      .then((id) => sendResponse({ ok: true, tabId: id }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }))
    return true
  }
  if (msg.type === 'detect-creator') {
    ;(async () => {
      try {
        const tabs = await chrome.tabs.query({ url: '*://*.fanbox.cc/*' })
        // 开多个 fanbox 标签时优先取当前正在看的那个，否则会填进错的画师
        const cand =
          tabs.find((t) => t.active && t.url && !t.url.includes('chrome-extension://')) ||
          tabs.find((t) => t.url && !t.url.includes('chrome-extension://'))
        sendResponse({
          ok: true,
          creatorId: cand ? parseCreatorFromUrl(cand.url) : '',
          url: cand ? cand.url : '',
        })
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) })
      }
    })()
    return true
  }
})

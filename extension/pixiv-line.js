// pixiv 下载线：只负责「取 pixiv 的数据 + 生成文件清单」，落盘/清单/进度仍由 app.js 统一处理。
// 背景（都实测过）：
//  · 从扩展页面 fetch www.pixiv.net/ajax/* 可以直接用（host_permissions 绕开 CORS），
//    实测 /ajax/user/<uid>、/ajax/user/<uid>/profile/all、/ajax/illust/<id>、
//    /ajax/illust/<id>/pages、/ajax/illust/<id>/ugoira_meta 都是 200。
//  · /ajax/user/<uid>/illusts 这类「批量作品列表」接口会返回 400「不正确的请求」，
//    所以枚举只拿 id 列表（profile/all），标题/类型/页数在做每一件时现取（1~2 个请求/件）。
//  · i.pximg.net 不发 CORS 头且要求 Referer: https://www.pixiv.net/，靠 manifest 的
//    host_permissions + rules-pixiv.json(declarativeNetRequest) 解决。
;(() => {
  const BASE = 'https://www.pixiv.net'
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /** 带超时/重试的 JSON 请求。4xx 视为确定性结果，不重试。 */
  async function getJson(url, { tries = 3, timeout = 20000 } = {}) {
    let lastErr = null
    for (let i = 0; i < tries; i++) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeout)
      try {
        const r = await fetch(url, { credentials: 'include', cache: 'no-store', signal: ac.signal })
        if (!r.ok) {
          const e = new Error('HTTP ' + r.status)
          e.status = r.status
          // 429 是 pixiv 的反爬信号：照上游插件的做法长等再试，硬退避没用还容易封号
          if (r.status === 429) {
            lastErr = e
            await sleep(200000)
            i--
            continue
          }
          if (r.status >= 400 && r.status < 500) throw Object.assign(e, { fatal: true })
          throw e
        }
        const j = await r.json()
        if (j && j.error) throw new Error('pixiv 返回 error：' + (j.message || ''))
        return j
      } catch (e) {
        lastErr = e
        if (e && e.fatal) throw e
      } finally {
        clearTimeout(timer)
      }
      await sleep(1200 * (i + 1))
    }
    throw lastErr || new Error('请求失败')
  }

  const q = (u) => (u.indexOf('?') >= 0 ? u + '&lang=zh' : u + '?lang=zh')

  /** 画师基本信息：body.{userId,name,imageBig,...} */
  async function getUser(uid) {
    const j = await getJson(q(BASE + '/ajax/user/' + encodeURIComponent(uid)))
    return (j && j.body) || {}
  }

  /** 画师全部作品 id：body.{illusts:{id:null},manga:{id:null},novels:{id:null}} */
  async function getProfileAll(uid) {
    const j = await getJson(q(BASE + '/ajax/user/' + encodeURIComponent(uid) + '/profile/all'))
    const b = (j && j.body) || {}
    const pick = (o) => Object.keys(o || {}).filter((k) => /^\d+$/.test(k))
    return { illusts: pick(b.illusts), manga: pick(b.manga), novels: pick(b.novels) }
  }

  /** 自己的 uid：从 dashboard 页面里抠，取不到就返回 ''（让用户手填）。
   *  为什么不用接口：pixiv 没有 /ajax/user/self，只有带 uid 的接口；
   *  dashboard 的 HTML 里带 `pixiv.user.id = "12345"`，是最省事的一条路。 */
  async function getSelfUid() {
    try {
      const r = await fetch(BASE + '/dashboard', { credentials: 'include' })
      if (!r.ok) return ''
      const t = await r.text()
      const m = t.match(/pixiv\.user\.id\s*=\s*"(\d+)"/) || t.match(/"user_id"\s*:\s*"(\d+)"/)
      return m ? String(m[1]) : ''
    } catch (e) {
      return ''
    }
  }

  /** 收藏夹枚举（B32）。实测端点：
   *   /ajax/user/<uid>/illusts/bookmarks?tag=&offset=<n>&limit=48&rest=show  → body.works / body.total
   *   /ajax/user/<uid>/novels/bookmarks?tag=&offset=<n>&limit=48&rest=show   → body.novels / body.total
   *  返回 [{ id, kind, userId, userName, title }]；`userId` 是**作者**，用来按画师分组。
   *  注意：这是"我收藏了谁的作品"，不是"我的作品"，所以不能复用 profile/all 那条枚举。 */
  async function getBookmarks(uid, { kind = 'illust', rest = 'show', max = 50000, onPage = null } = {}) {
    const out = []
    const LIMIT = 48
    let offset = 0
    for (;;) {
      const path = kind === 'novel' ? '/novels/bookmarks' : '/illusts/bookmarks'
      const url = BASE + '/ajax/user/' + encodeURIComponent(uid) + path + '?tag=&offset=' + offset + '&limit=' + LIMIT + '&rest=' + rest
      const j = await getJson(q(url))
      const b = (j && j.body) || {}
      // 实测：插画和小说**都返回 body.works**（小说那条是 works/total/... ，没有 novels 字段）。
      // 文档/旧代码写的是 body.novels，两个都认，免得哪天真换键就一条都读不到。
      const list = (Array.isArray(b.works) && b.works) || (Array.isArray(b.novels) && b.novels) || []
      if (!list.length) break
      for (const w of list) {
        const wid = w && (w.id != null ? w.id : w.workId)
        if (wid == null) continue
        out.push({
          id: String(wid),
          kind: kind === 'novel' ? 'novel' : 'illust',
          userId: String(w.userId || ''),
          userName: w.userName || '',
          title: w.title || '',
        })
      }
      if (onPage) {
        try {
          onPage(out.length, Number(b.total) || 0)
        } catch (e) {
          /* 回调出错不影响枚举 */
        }
      }
      if (list.length < LIMIT) break
      offset += LIMIT
      if (out.length >= max) break
      await sleep(700 + Math.round(Math.random() * 600)) // 别拿等距节奏去打收藏列表
    }
    return out
  }

  /** 单件作品元数据：illustType 0=插画 1=漫画 2=动图 */
  async function getIllust(id) {    const j = await getJson(q(BASE + '/ajax/illust/' + encodeURIComponent(id)))
    return (j && j.body) || {}
  }

  /** 多页作品的每页原图 */
  async function getPages(id) {
    const j = await getJson(q(BASE + '/ajax/illust/' + encodeURIComponent(id) + '/pages'))
    return Array.isArray(j && j.body) ? j.body : []
  }

  /** 动图：src(600x600 zip) / originalSrc(1920x1080 zip) / frames:[{file,delay}] */
  async function getUgoiraMeta(id) {
    const j = await getJson(q(BASE + '/ajax/illust/' + encodeURIComponent(id) + '/ugoira_meta'))
    return (j && j.body) || {}
  }

  /** 小说：body.{title,content(HTML),uploadDate,userName,tags} */
  async function getNovel(id) {
    const j = await getJson(q(BASE + '/ajax/novel/' + encodeURIComponent(id)))
    return (j && j.body) || {}
  }

  function guessExt(url, fallback = 'jpg') {
    const m = String(url).match(/\.([a-z0-9]{2,5})(?:\?|$)/i)
    return m ? m[1].toLowerCase() : fallback
  }

  const pad = (n, w = 3) => String(n).padStart(w, '0')

  /** 多页插画 / 漫画：pages 的 original 就是画师上传的原图 */
  function filesFromPages(pages) {
    const files = []
    pages.forEach((p, i) => {
      const url = p && p.urls && (p.urls.original || p.urls.regular)
      if (!url) return
      files.push({
        url,
        ext: guessExt(url, 'jpg'),
        name: '',
        kind: 'image',
        seq: pad(i + 1, 3),
        page: i,
        width: p.width || 0,
        height: p.height || 0,
      })
    })
    return files
  }

  /** 动图：先落原始 zip，再把帧拆出来（帧在 zip 里，见 unzip 部分） */
  function filesFromUgoira(meta) {
    const zipUrl = meta.originalSrc || meta.src
    if (!zipUrl) return []
    const isOriginal = !!meta.originalSrc
    return [
      {
        url: zipUrl,
        ext: 'zip',
        name: '',
        kind: 'ugoira_zip',
        seq: '001',
        ugoira: { mime: meta.mime_type || 'image/jpeg', frames: (meta.frames || []).length },
        note: isOriginal ? '1920x1080 原始 zip' : '600x600 zip',
      },
    ]
  }

  window.PixivLine = {
    getJson,
    getUser,
    getProfileAll,
    getIllust,
    getPages,
    getUgoiraMeta,
    getNovel,
    getSelfUid,
    getBookmarks,
    guessExt,
    pad,
    filesFromPages,
    filesFromUgoira,
  }
})()

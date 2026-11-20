// ==UserScript==
// @name         Fanbox/Pixiv 文件夹下载器（油猴版）
// @namespace    local.ffdl.userscript
// @version      0.2.3
// @description  把某位 Fanbox / Pixiv 画师的全部作品，按「总文件夹/作品文件夹/文件」直接写进你选择的目录（手机可用，绕开浏览器下载层的平铺限制）
// @author       local lab
// @match        https://*.fanbox.cc/*
// @match        https://fanbox.cc/*
// @match        https://www.pixiv.net/*
// @connect      api.fanbox.cc
// @connect      downloads.fanbox.cc
// @connect      fanbox.cc
// @connect      www.fanbox.cc
// @connect      pximg.net
// @connect      i.pximg.net
// @connect      www.pixiv.net
// @connect      pixiv.net
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* 画师文件夹下载器 · 油猴版 v0.2.1
 *
 * 与扩展版 v0.3.38 是同一套引擎，只换掉三处“平台相关”的实现：
 *   ① 网络     扩展页 fetch（host_permissions 绕 CORS）  →  GM_xmlhttpRequest（@connect + 手工 Referer）
 *              0.2.0 起：下载改成 Range 分块（每块 6MB）+ 定位写 + `_半截.json` 台账，
 *              断流最多丢当前这块；服务器不吃 Range（回 200）时退回从头整包写。
 *   ② API 代理 chrome.tabs.sendMessage 走内容脚本代理    →  直接 GM_xmlhttpRequest（不需要代理页）
 *   ③ UI       独立扩展页 app.html                       →  页面内 Shadow DOM 浮层
 * 写盘、清单、断点续传、完整性校验全部沿用（File System Access API，路径 = 所选目录/画师/作品/文件）。
 * 0.2.1 起补上「Pixiv 我的收藏」整条线：分页枚举 → 平铺 `_我的收藏 (PIXIV)/` 或
 *       分组 `_我的收藏 (PIXIV)/<画师名> (PIXIV)/` → 逐篇落盘；清单另存本地账本并可导出/导入。
 * 0.2.2：真机冒烟（v0.2.1 上跑出来的问题）
 *   · 数字行四个框被 flex 挤成 18px、上限MB 跑出屏 → 固定 76px + 拆成两行
 *   · 收藏模式会静默沿用输入框里残留的画师 uid → 开跑前显式提示
 *   · 收藏里被屏蔽的条目（作者被抹成 -----）分组时归到「_未标注作者」，并在枚举后报数
 *   · 页面刚加载时点开始会误报「请先选择保存文件夹」→ ensurePermission 先补一次句柄恢复
 *   · 分块下载：区间响应比请求短且未到总长时按失败重试，不再静默留下短文件
 *   · 平铺收藏的 `_站点.json` 不再把首件作品的作者当画师名；「已写清单」不再重复打两条
 * 0.2.3：真机第二轮（小说/导出/预检/暂停/分组落盘）
 *   · 导出清单在油猴沙箱里必然甩 Illegal invocation → 改从 unsafeWindow 调，失败就写进所选目录
 *   · 收藏里被抹成 "-----" 的作者不再建出「----- (PIXIV)/」，统一归「_未标注作者」
 *   · 已删除/转私密的收藏条目（HTTP 404）记「已失效、跳过」，不再每轮算一次失败
 *   · 扫到多个画师文件夹后，动作行被列表挤到视口外 → 列表高度 27vh → 18vh
 */
;(() => {
  'use strict'

  const VERSION = '0.2.3'
  const HOST = location.hostname
  const SITE = /(^|\.)fanbox\.cc$/i.test(HOST) ? 'fanbox' : /(^|\.)pixiv\.net$/i.test(HOST) ? 'pixiv' : ''
  if (!SITE) return
  if (document.getElementById('ffdl-fab')) return // 防重复注入

  // 面板在 Shadow DOM 里：$() 必须先进 shadowRoot 找，否则 querySelector 全返回 null
  //（v0.1.0 真机踩过：画师框读到空串 → 直接报「uid 解析失败」）
  let uiRoot = null
  let shadow = null
  function $(s) {
    if (shadow) {
      const el = shadow.querySelector(s)
      if (el) return el
    }
    return document.querySelector(s)
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const pad = (n, w = 3) => String(n).padStart(w, '0')

  const S = {
    site: SITE,
    parent: null,
    artistDir: null,
    running: false,
    paused: false,
    stopFlag: false,
    creatorId: '',
    totalFolder: '',
    posts: [],
    done: {},
    progSig: '',
    index: new Map(),
    records: [],
    failed: [],
    stats: { postsTotal: 0, postsDone: 0, filesDone: 0, skip: 0, skipPosts: 0, fail: 0, bytes: 0 },
    logLines: [],
    wakeLock: null,
    audioCtx: null,
    singlePostId: '',
    singlePostKind: '',
    scanned: [],
    scanning: false,
    presetArtist: null,
    verified: {}, // 本轮真正“整篇跑完”的篇，落进 _完成篇.jsonl 当证据
    optsCur: null, // 本轮选项快照（写进 _进度.json）
    source: 'artist', // 来源：artist=按画师枚举 / fav=我的收藏（收藏是 pixiv 专属，选中就切站点）
    favLayout: 'flat', // 收藏的落点：flat=平铺 / group=先按画师分一层
    favUid: '', // 收藏模式那个「账号 uid」（分组时 S.creatorId 会被改成 fav:<uid>:<画师uid>，导出要用它）
    importedPosts: null, // 手工导入的枚举 JSON（一次性使用；不另开写盘通道，灌进现成的逐篇循环）
    importedFor: null, // 上面那份清单是给「哪个站点 + 哪个画师」导入的 { site, creator }
    diskFolders: null, // 画师目录下现存的投稿文件夹名集合
    diskFoldersDir: null,
  }

  /* ================= 基础工具 ================= */

  function log(msg) {
    const t = new Date().toTimeString().slice(0, 8)
    const line = `[${t}] ${msg}`
    S.logLines.push(line)
    if (S.logLines.length > 400) S.logLines.splice(0, S.logLines.length - 400)
    try {
      console.log('[FFDL] ' + msg)
    } catch (e) {
      /* 忽略 */
    }
    if (!S._logDirty) {
      S._logDirty = true
      setTimeout(flushLog, 200)
    }
  }

  function flushLog() {
    S._logDirty = false
    const el = $('#log')
    if (!el) return
    el.textContent = S.logLines.join('\n')
    el.scrollTop = el.scrollHeight
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B'
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB'
    return (n / 1048576).toFixed(1) + ' MB'
  }

  function hex(u8, from, cnt) {
    const out = []
    for (let i = 0; i < (cnt || 4); i++) {
      const v = u8[from + i]
      if (v == null) break
      out.push(v.toString(16).padStart(2, '0').toUpperCase())
    }
    return out.join(' ')
  }

  /** 文件/文件夹名清洗：非法字符、控制符、首尾点，并限制长度 */
  function sanitize(s, max = 60) {
    let out = String(s == null ? '' : s)
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
    if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1)
    out = out.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
    return out || '无题'
  }

  function guessExt(url, fallback = 'jpg') {
    const m = String(url).match(/\.([a-z0-9]{2,5})(?:\?|$)/i)
    return m ? m[1].toLowerCase() : fallback
  }

  function parseCreator(input) {
    const s = (input || '').trim()
    if (!s) return ''
    let m = s.match(/fanbox\.cc\/@([A-Za-z0-9_-]+)/)
    if (m) return m[1]
    m = s.match(/^([A-Za-z0-9_-]+)\.fanbox\.cc/)
    if (m) return m[1]
    m = s.match(/^@?([A-Za-z0-9_-]+)$/)
    if (m) return m[1]
    return ''
  }

  function parsePixivUid(input) {
    const s = String(input || '').trim()
    if (!s) return ''
    if (/^\d+$/.test(s)) return s
    const m = s.match(/pixiv\.net\/(?:[a-z]{2}\/)?users\/(\d+)/i)
    if (m) return m[1]
    return ''
  }

  function lsGet(key, def) {
    try {
      const v = localStorage.getItem(key)
      return v ? JSON.parse(v) : def
    } catch (e) {
      return def
    }
  }
  function lsSet(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val))
      return true
    } catch (e) {
      log('! 本机缓存写入失败（配额满）：' + (e && e.message))
      return false
    }
  }

  /* ================= IndexedDB：记住上次选的目录 ================= */

  function idbOpen() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('ffdl-userscript', 1)
      r.onupgradeneeded = () => r.result.createObjectStore('kv')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
  }
  async function idbGet(k) {
    const db = await idbOpen()
    return await new Promise((res, rej) => {
      const q = db.transaction('kv', 'readonly').objectStore('kv').get(k)
      q.onsuccess = () => res(q.result)
      q.onerror = () => rej(q.error)
    })
  }
  async function idbSet(k, v) {
    const db = await idbOpen()
    return await new Promise((res, rej) => {
      const q = db.transaction('kv', 'readwrite').objectStore('kv').put(v, k)
      q.onsuccess = () => res()
      q.onerror = () => rej(q.error)
    })
  }

  /* ================= 目录选择与写盘 ================= */

  async function pickFolder() {
    if (typeof showDirectoryPicker !== 'function') {
      throw new Error('此浏览器不支持目录选择（File System Access API 不可用）')
    }
    const h = await showDirectoryPicker({ id: 'ffdl-userscript', mode: 'readwrite' })
    S.parent = h
    try {
      await idbSet('parent', h)
    } catch (e) {
      /* 句柄不能序列化时忽略 */
    }
    const el = $('#dirName')
    if (el) el.textContent = '已选：' + h.name
    log('保存目录：' + h.name)
    // 选完就扫：里面有哪些画师、各自下了多少
    await scanArtists()
    return h
  }

  async function ensurePermission() {
    // 0.2.2：页面刚加载时 startup 的 restoreParent() 可能还没跑完，
    // 这时点「开始」会直接报「请先选择保存文件夹」，而句柄其实就在 IndexedDB 里。
    // 所以先自己补一次恢复，再判断。
    if (!S.parent) {
      try {
        await restoreParent()
      } catch (e) {
        /* 没有记录就照旧报错 */
      }
    }
    if (!S.parent) throw new Error('请先选择保存文件夹')
    let p = await S.parent.queryPermission({ mode: 'readwrite' })
    if (p === 'granted') return
    if (document.visibilityState !== 'visible') {
      throw new Error('授权弹窗需要页面在前台：请切回本页再点「开始下载」')
    }
    p = await Promise.race([
      S.parent.requestPermission({ mode: 'readwrite' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('等待授权超时 30 秒，请重试并在弹窗里点「允许」')), 30000)),
    ])
    if (p !== 'granted') throw new Error('没有目录写入权限')
  }

  async function writeBuffer(dir, name, buf) {
    const fh = await dir.getFileHandle(name, { create: true })
    const w = await fh.createWritable()
    try {
      await w.write(new Blob([buf]))
      await w.close()
    } catch (e) {
      try {
        await w.abort()
      } catch (e2) {
        /* 已结束，忽略 */
      }
      throw e
    }
  }

  async function writeText(dir, name, text) {
    await writeBuffer(dir, name, new TextEncoder().encode(text))
  }

  async function getSize(dir, name) {
    try {
      return (await (await dir.getFileHandle(name)).getFile()).size
    } catch (e) {
      return 0
    }
  }

  async function fileOk(dir, name, expectBytes) {
    try {
      const f = await (await dir.getFileHandle(name)).getFile()
      if (f.size <= 0) return false
      if (expectBytes && f.size < expectBytes) return false
      return true
    } catch (e) {
      return false
    }
  }

  /** 纯函数：只看「名称 + 末尾字节」判断文件是否真的下完。
   *  所有判据都是“相对文件末尾”的，所以只需要文件尾部一段字节就能判，
   *  也让单元测试不必碰磁盘。 */
  function tailCheckBytes(name, bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    const m = String(name).match(/\.([A-Za-z0-9]{1,5})$/)
    const ext = m ? m[1].toLowerCase() : ''
    const n = u8.length
    if (n < 4) return { ok: false, why: '文件太小（' + n + 'B）' }
    if (ext === 'jpg' || ext === 'jpeg') {
      const ok = u8[n - 2] === 0xff && u8[n - 1] === 0xd9
      return { ok, why: ok ? '尾标 FFD9' : '尾字节 ' + hex(u8, n - 2, 2) }
    }
    if (ext === 'png') {
      if (n < 8) return { ok: false, why: 'PNG 不足 8 字节' }
      const sig = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]
      let ok = true
      for (let i = 0; i < 8; i++) if (u8[n - 8 + i] !== sig[i]) ok = false
      return { ok, why: ok ? '尾标 IEND' : '尾 8 字节 ' + hex(u8, n - 8, 8) }
    }
    if (ext === 'gif') {
      const ok = u8[n - 1] === 0x3b
      return { ok, why: ok ? '尾标 3B' : '尾字节 ' + hex(u8, n - 1, 2) }
    }
    if (ext === 'zip') {
      // zip 以 EOCD（PK\x05\x06）结尾，后面可跟最多 64KB 注释；必须校验「EOCD + 22 + 注释长度 === 末尾」
      const win = Math.min(n, 66000)
      const start = n - win
      const u16 = (o) => u8[start + o] | (u8[start + o + 1] << 8)
      for (let i = win - 22; i >= 0; i--) {
        if (u8[start + i] === 0x50 && u8[start + i + 1] === 0x4b && u8[start + i + 2] === 0x05 && u8[start + i + 3] === 0x06) {
          const cmt = u16(i + 20)
          if (i + 22 + cmt === win) return { ok: true, why: 'EOCD@' + i + (cmt ? '（注释 ' + cmt + 'B）' : '') }
        }
      }
      return { ok: false, why: '找不到合法 EOCD（可能被截断）' }
    }
    return { ok: true, why: '该格式无尾标（放行）' }
  }

  function tailVerifiable(name) {
    const m = String(name).match(/\.([A-Za-z0-9]{1,5})$/)
    const ext = m ? m[1].toLowerCase() : ''
    return ext === 'jpg' || ext === 'jpeg' || ext === 'png' || ext === 'gif' || ext === 'zip'
  }

  /** 读文件尾部（最多 66KB）再判 */
  async function tailCheck(dir, name) {
    try {
      const f = await (await dir.getFileHandle(name)).getFile()
      if (f.size < 4) return { ok: false, why: '文件太小（' + f.size + 'B）' }
      const n = Math.min(f.size, 66000)
      const u8 = new Uint8Array(await f.slice(f.size - n).arrayBuffer())
      return tailCheckBytes(name, u8)
    } catch (e) {
      return { ok: false, why: '读取失败：' + ((e && e.message) || e) }
    }
  }

  async function fileComplete(dir, name, expect) {
    if (Number(expect) > 0) return true
    if (!tailVerifiable(name)) {
      log('  · ' + name + ' 存在但无法校验完整性（该格式没有尾标），重下一次')
      return false
    }
    const r = await tailCheck(dir, name)
    if (!r.ok) log('  · ' + name + ' 末尾校验没过（' + r.why + '），重下')
    return r.ok
  }

  /* ================= 0.2.0：半截台账（断点续传用） =================
   * 扩展版靠单连接流式写盘，断流时把已收字节 close() 进文件就行；
   * 油猴版拿不到流（GM_xmlhttpRequest 只能整包返回），所以改成
   * 「按区间分块取 + 定位写」：每块自己一个请求，断流最多丢这一块，
   * 台账记下「整个文件多长 / 已经写进去多少」，下次从断点接着要。
   */
  const PART_FILE = '_半截.json'

  async function loadParts(dir) {
    try {
      const f = await dir.getFileHandle(PART_FILE)
      return JSON.parse(await (await f.getFile()).text()) || {}
    } catch (e) {
      return {}
    }
  }

  async function partsWrite(dir, all) {
    try {
      await writeText(dir, PART_FILE, JSON.stringify(all || {}))
    } catch (e) {
      log('! 写 ' + PART_FILE + ' 失败：' + ((e && e.message) || e))
    }
  }

  async function partSet(dir, name, exp, got) {
    const all = await loadParts(dir)
    all[name] = { exp: Number(exp) || 0, got: Number(got) || 0, ts: Date.now() }
    await partsWrite(dir, all)
  }

  async function partClear(dir, name) {
    const all = await loadParts(dir)
    if (!(name in all)) return
    delete all[name]
    await partsWrite(dir, all)
  }

  /* ================= 站点标记：画师文件夹怎么命名、怎么认 ================= */

  const SITE_SUFFIX = { fanbox: ' (FANBOX)', pixiv: ' (PIXIV)' }

  function siteTag(site) {
    return site === 'pixiv' ? 'PIXIV' : 'FANBOX'
  }

  /** 新画师文件夹：名字本体先截断，站点后缀在截断之后再拼，避免括号被切掉 */
  function folderNameFor(artistName, site) {
    const suf = SITE_SUFFIX[site === 'pixiv' ? 'pixiv' : 'fanbox']
    return sanitize(artistName || '', Math.max(8, 60 - suf.length)) + suf
  }

  function stripSiteSuffix(name) {
    return String(name || '')
      .replace(/\s*\((?:FANBOX|PIXIV)\)\s*$/i, '')
      .trim()
  }

  /** 认文件夹的站点：_站点.json → _进度.json.site → 名字后缀 */
  async function readSiteOf(dir) {
    const out = { site: '', creatorId: '', creatorName: '' }
    try {
      const j = JSON.parse(await (await dir.getFileHandle('_站点.json')).getFile().then((f) => f.text()))
      if (j && (j.site === 'fanbox' || j.site === 'pixiv')) out.site = j.site
      if (j && j.creatorId) out.creatorId = String(j.creatorId)
      if (j && j.creatorName) out.creatorName = String(j.creatorName)
    } catch (e) {
      /* 老文件夹没有标记 */
    }
    if (!out.site) {
      try {
        const j = JSON.parse(await (await dir.getFileHandle('_进度.json')).getFile().then((f) => f.text()))
        if (j && (j.site === 'fanbox' || j.site === 'pixiv')) out.site = j.site
        if (!out.creatorId && j && j.creatorId) out.creatorId = String(j.creatorId)
      } catch (e) {
        /* 忽略 */
      }
    }
    if (!out.site) {
      const m = String(dir.name).match(/\((FANBOX|PIXIV)\)\s*$/i)
      if (m) out.site = m[1].toLowerCase()
    }
    return out
  }

  async function writeSiteFile(dir, creatorId, creatorName) {
    try {
      await writeText(
        dir,
        '_站点.json',
        JSON.stringify(
          {
            site: S.site,
            creatorId: creatorId || '',
            // 0.2.2：平铺收藏的「画师名」其实是第一件作品的作者，写进站点标记会误导
            // （实测被写成某件作品的作者名，而这一层其实是某个账号的收藏混合存放）。
            // 收藏线的 creatorId 是 fav:<账号uid>，就用它当名字；分组那层是 fav:<账号>:<画师>，照旧用画师名。
            // 0.2.3：分组里「未标注作者」那组的 creatorId 是 fav:<账号>:unknown，名字要跟着改，
            // 否则会残留上一组画师的名字（实测写成了「鴉」，跟这组内容完全对不上）。
            creatorName: (() => {
              const cid = String(creatorId || '')
              const mFlat = cid.match(/^fav:(\d+)$/)
              if (mFlat) return '收藏账号 ' + mFlat[1]
              const mUnk = cid.match(/^fav:(\d+):unknown$/)
              if (mUnk) return '收藏账号 ' + mUnk[1] + '（未标注作者）'
              return creatorName || stripSiteSuffix(dir.name)
            })(),
            updatedAt: new Date().toISOString(),
            note: 'pixiv 的 uid 与 fanbox 的 creatorId 是两套编号，同名画师靠这个文件区分站点',
          },
          null,
          1,
        ),
      )
    } catch (e) {
      log('! 写 _站点.json 失败：' + e.message)
    }
  }

  /** 老文件夹没有 _站点.json 时，从内容反推站点（清单里的 url 域名是最硬的证据）。
   *  证据优先于假设：盲写标记会把另一个站的老目录永久标错，程序里没有撤销路径。 */
  async function sniffSite(dir) {
    const pick = (u) => {
      const s = String(u || '')
      if (/pximg\.net|pixiv\.net|i\.pximg/.test(s)) return 'pixiv'
      if (/fanbox\.cc|fanbox\.pixiv/.test(s)) return 'fanbox'
      return ''
    }
    try {
      const txt = await (await dir.getFileHandle('_清单.jsonl')).getFile().then((f) => f.text())
      const m = txt.match(/"url":"([^"]+)"/)
      const s1 = m ? pick(m[1]) : ''
      if (s1) return s1
    } catch (e) {
      /* 没清单 */
    }
    try {
      const j = JSON.parse(await (await dir.getFileHandle('_投稿列表.json')).getFile().then((f) => f.text()))
      if (Array.isArray(j) && j.some((x) => x && (x.kind === 'novel' || x.kind === 'illust'))) return 'pixiv'
    } catch (e) {
      /* 没投稿列表 */
    }
    return ''
  }

  /** 落盘文件夹：老的「纯名字」优先沿用（只补标记、不改名），否则新建「名字 (站点)」 */
  async function resolveArtistDir(artistName) {
    const wanted = folderNameFor(artistName, S.site)
    const legacy = sanitize(artistName || '', 60)
    const tries = []
    if (legacy && legacy !== wanted) tries.push(legacy)
    tries.push(wanted)
    for (const name of tries) {
      let d = null
      try {
        d = await S.parent.getDirectoryHandle(name)
      } catch (e) {
        continue
      }
      const info = await readSiteOf(d)
      if (info.site && info.site !== S.site) {
        log(`! 「${name}」已标记为 ${siteTag(info.site)}，与本次 ${siteTag(S.site)} 不同，跳过`)
        continue
      }
      if (!info.site) {
        // 老文件夹没有标记：先嗅一下内容属于哪个站，别盲写
        const sniffed = await sniffSite(d)
        if (sniffed && sniffed !== S.site) {
          log(`! 「${name}」里的清单是 ${siteTag(sniffed)} 的内容，与本次 ${siteTag(S.site)} 不符，跳过`)
          continue
        }
        await writeSiteFile(d, S.creatorId, artistName)
        log(`沿用已有文件夹「${name}」（老文件夹无站点标记，已补写 _站点.json，未改名）`)
      } else {
        log(`沿用已有文件夹「${name}」［${siteTag(info.site)}］（不重下已有文件）`)
      }
      return { dir: d, name, adopted: true }
    }
    const d = await S.parent.getDirectoryHandle(wanted, { create: true })
    await writeSiteFile(d, S.creatorId, artistName)
    log(`新建画师文件夹：${wanted}`)
    return { dir: d, name: wanted, adopted: false }
  }

  /* ---------- 「这一篇到底整篇跑完过没有」的落盘证据 ----------
   * 旧做法「_清单.jsonl 里出现过这个投稿文件夹就算下过」会踩两个坑：
   *   ① 中断在半篇：文件夹在、清单里有记录 → 判完成 → 剩下几个文件永远不会再下；
   *   ② 同文件夹后来勾上「附件/压缩包」再跑：签名变了槽位空，反推却把上一轮那些只下过图片的
   *      篇全标完成 → 一个附件都不下，错标记还会被存下去。
   * 所以另记 _完成篇.jsonl：只有真跑完的篇才写，并记下当时的选项；反推时要求当时的选项覆盖本轮。 */
  function optsFlags(opts) {
    return { files: opts && opts.files ? 1 : 0, cover: opts && opts.cover ? 1 : 0, text: opts && opts.text ? 1 : 0 }
  }

  function optsCovers(have, need) {
    const h = have || {}
    const n = need || {}
    if (n.files && !h.files) return false
    if (n.cover && !h.cover) return false
    if (n.text && !h.text) return false
    return true
  }

  function optsText(o) {
    const parts = ['图片']
    if (o && o.files) parts.push('附件')
    if (o && o.cover) parts.push('封面')
    if (o && o.text) parts.push('正文')
    return parts.join('+')
  }

  async function readDonePosts(dir) {
    const out = new Map()
    try {
      const txt = await (await dir.getFileHandle('_完成篇.jsonl')).getFile().then((f) => f.text())
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line)
          if (r && r.id != null) out.set(String(r.id), r)
        } catch (e) {
          /* 坏行跳过 */
        }
      }
    } catch (e) {
      /* 没有这份文件 = 老文件夹 */
    }
    return out
  }

  async function writeDonePosts() {
    if (!S.artistDir) return
    try {
      const all = await readDonePosts(S.artistDir)
      const cur = optsFlags(S.optsCur)
      const t = new Date().toISOString()
      for (const id of Object.keys(S.verified || {})) all.set(String(id), { id: String(id), files: cur.files, cover: cur.cover, text: cur.text, t })
      if (!all.size) return
      await writeText(S.artistDir, '_完成篇.jsonl', Array.from(all.values()).map((r) => JSON.stringify(r)).join('\n'))
    } catch (e) {
      log('! 写 _完成篇.jsonl 失败：' + e.message)
    }
  }

  async function applyManifestInference(list, opts) {
    const inferred = {}
    let hit = 0
    let blocked = 0
    if (!S.artistDir || !Array.isArray(list)) return { inferred, hit, blocked }
    const need = optsFlags(opts)
    const doneMap = await readDonePosts(S.artistDir)
    for (const p of list) {
      if (!p || p.id == null) continue
      const rec = doneMap.get(String(p.id))
      if (!rec) continue
      if (!optsCovers(rec, need)) {
        blocked++
        continue
      }
      inferred[p.id] = 1
      hit++
    }
    if (hit) log(`从 _完成篇.jsonl 反推：${hit} 篇确认整篇下完过`)
    if (blocked) log(`! 另有 ${blocked} 篇是在「${optsText(need)} 之外」的选项下跑完的，本轮要多下东西，不做反推（会逐篇核对，已存在的文件照样跳过）`)
    return { inferred, hit, blocked }
  }

  async function loadDiskFolders(dir) {
    const s = new Set()
    try {
      for await (const [name, h] of dir.entries()) if (h && h.kind === 'directory') s.add(name)
    } catch (e) {
      /* 列不出来留空集 */
    }
    S.diskFolders = s
    S.diskFoldersDir = dir
    return s
  }

  function diskHasPost(post) {
    const set = S.diskFolders
    if (!set || !set.size) return false
    if (post.title) {
      try {
        if (set.has(folderNameOf(post))) return true
      } catch (e) {
        /* 算不出来就走 id 段匹配 */
      }
    }
    let re = null
    try {
      re = new RegExp('(^|-)' + String(post.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-')
    } catch (e) {
      return false
    }
    for (const n of set) if (re.test(n)) return true
    return false
  }

  /** 跳过闸门：有完成标记 + 磁盘上文件夹还在 + 不是单篇指名 */
  async function shouldSkipPost(artistDir, post, opts) {
    if (!opts || !opts.skip || S.singlePostId) return false
    if (!post || post.id == null || !S.done[post.id]) return false
    if (!artistDir) return false
    if (!S.diskFolders || S.diskFoldersDir !== artistDir) await loadDiskFolders(artistDir)
    if (diskHasPost(post)) return true
    await loadDiskFolders(artistDir)
    if (diskHasPost(post)) return true
    log(`! ${post.id} 记着已完成，但磁盘上找不到它的文件夹，重新处理`)
    delete S.done[post.id]
    return false
  }

  /* ================= 选完目录就扫描 ================= */

  async function scanArtists() {
    if (!S.parent || S.scanning) return
    S.scanning = true
    const box = $('#artistList')
    if (box) box.textContent = '正在扫描…'
    const t0 = Date.now()
    const items = []
    let scanComplete = true // entries() 中途抛错时不能拿半份列表覆盖旧结果（B20）
    try {
      for await (const [name, h] of S.parent.entries()) {
        if (!h || h.kind !== 'directory') continue
        const info = await readSiteOf(h)
        let prog = null
        try {
          prog = JSON.parse(await (await h.getFileHandle('_进度.json')).getFile().then((f) => f.text()))
        } catch (e) {
          prog = null
        }
        // 文件数 / 体积一律以清单为准（_进度.json 的 files/bytes 可能是老版本的「本轮统计」）
        let files = null
        let bytes = null
        try {
          const txt = await (await h.getFileHandle('_清单.jsonl')).getFile().then((f) => f.text())
          let n = 0
          let sum = 0
          for (const line of txt.split('\n')) {
            if (!line.trim()) continue
            n++
            const m = line.match(/"bytes":(\d+)/)
            if (m) sum += Number(m[1])
          }
          files = n
          bytes = sum
        } catch (e) {
          files = prog && prog.files != null ? Number(prog.files) : null
          bytes = prog && prog.bytes != null ? Number(prog.bytes) : null
        }
        items.push({
          folder: name,
          site: info.site,
          creatorId: info.creatorId || (prog && prog.creatorId ? String(prog.creatorId) : ''),
          artistName: info.creatorName || stripSiteSuffix(name),
          done: prog && prog.donePosts != null ? Number(prog.donePosts) : null,
          total: prog && prog.total != null ? Number(prog.total) : null,
          files,
          bytes,
        })
      }
    } catch (e) {
      scanComplete = false
      log('! 扫描目录失败：' + e.message)
    }
    const fresh = items.sort((a, b) => (b.bytes || 0) - (a.bytes || 0))
    if (!scanComplete && S.scanned && S.scanned.length) {
      // entries() 中途抛错时 items 只有一半，整份覆盖会让卡片凭空少一批（看着像丢画师）。
      // 只更新这一轮真扫到的，没扫到的旧条目原样留着（B20）。
      const seen = new Set(fresh.map((x) => x.folder))
      const kept = S.scanned.filter((x) => !seen.has(x.folder))
      if (kept.length) log(`! 扫描中断，保留上次已知的 ${kept.length} 个文件夹（未覆盖）`)
      S.scanned = fresh.concat(kept).sort((a, b) => (b.bytes || 0) - (a.bytes || 0))
    } else {
      S.scanned = fresh
    }
    S.scanning = false
    renderArtists()
    log(`扫描完成：${S.scanned.length} 个画师文件夹（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`)
  }

  function renderArtists() {
    const box = $('#artistList')
    const cnt = $('#scanCount')
    if (cnt) cnt.textContent = String(S.scanned.length)
    if (!box) return
    box.textContent = ''
    if (!S.scanned.length) {
      box.textContent = '这个目录里还没有画师文件夹'
      return
    }
    for (const it of S.scanned) {
      const row = document.createElement('div')
      row.className = 'ar'
      const head = document.createElement('div')
      head.className = 'ar-h'
      const nm = document.createElement('span')
      nm.className = 'ar-n'
      nm.textContent = it.folder
      const tag = document.createElement('span')
      tag.className = 'ar-t'
      tag.textContent = it.site ? siteTag(it.site) : '未标记'
      tag.style.background = it.site === 'pixiv' ? '#2b6cb0' : it.site === 'fanbox' ? '#0a7d4f' : '#5b5f66'
      head.appendChild(nm)
      head.appendChild(tag)
      row.appendChild(head)
      const meta = document.createElement('div')
      meta.className = 'ar-m'
      const parts = []
      if (it.done != null) {
        if (it.total != null && it.total >= it.done) parts.push(`${it.done}/${it.total} 篇`)
        else parts.push(`${it.done} 篇已完成`)
      }
      if (it.files != null) parts.push(`${it.files} 个文件`)
      if (it.bytes) parts.push(fmtBytes(it.bytes))
      if (!it.creatorId) parts.push('⚠ 没有画师 ID')
      meta.textContent = parts.join(' · ') || '（空文件夹）'
      row.appendChild(meta)
      const btns = document.createElement('div')
      btns.className = 'ar-b'
      const crossSite = it.site && it.site !== S.site
      // 收藏汇总文件夹的 creatorId 是 fav:<uid>（不是画师 uid）：点「继续这一位」必然解析失败，
      // 所以不给这个按钮，改成一句指路的说明
      const favAgg = /^fav:/.test(String(it.creatorId || ''))
      if (favAgg) {
        const s = document.createElement('span')
        s.className = 'ar-m'
        s.textContent = '收藏汇总文件夹：要续跑把「来源」选成「我的收藏」'
        btns.appendChild(s)
      } else if (it.creatorId && !crossSite) {
        const b = document.createElement('button')
        b.textContent = '继续这一位'
        b.addEventListener('click', (ev) => {
          ev.stopPropagation()
          useArtist(it)
        })
        btns.appendChild(b)
      } else if (crossSite) {
        const s = document.createElement('span')
        s.className = 'ar-m'
        s.textContent = `这是 ${siteTag(it.site)} 的文件夹，要切到对应站点页面才能续跑`
        btns.appendChild(s)
      }
      if (!it.site) {
        const b2 = document.createElement('button')
        b2.style.background = '#4a4e55'
        b2.textContent = '标记为 ' + siteTag(S.site)
        b2.addEventListener('click', async (ev) => {
          ev.stopPropagation()
          try {
            const d = await S.parent.getDirectoryHandle(it.folder)
            await writeSiteFile(d, it.creatorId, stripSiteSuffix(it.folder))
            log(`已给「${it.folder}」补写 _站点.json（${siteTag(S.site)}），未改名`)
            await scanArtists()
          } catch (e) {
            log('! 标记失败：' + e.message)
          }
        })
        btns.appendChild(b2)
      }
      if (btns.childNodes.length) row.appendChild(btns)
      box.appendChild(row)
    }
  }

  function useArtist(it) {
    if (S.running) {
      log('正在下载，先点「停止」再换目标')
      return
    }
    S.presetArtist = { folder: it.folder, creatorId: it.creatorId, site: it.site || S.site, artistName: it.artistName }
    const cIn = $('#creator')
    if (cIn) cIn.value = it.creatorId
    log(`已选中「${it.folder}」：[${siteTag(S.site)}] ${it.creatorId}`, 'ok')
  }

  /* ================= 后台保活 ================= */

  function startSilentAudio() {
    try {
      if (S.audioCtx) {
        S.audioCtx.resume().catch(() => {})
        return
      }
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return
      const ctx = new Ctx()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      gain.gain.value = 0.0001
      osc.frequency.value = 220
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      S.audioCtx = ctx
      ctx.resume().catch(() => {})
    } catch (e) {
      /* 忽略 */
    }
  }

  async function keepScreenOn() {
    try {
      if (S.wakeLock || !navigator.wakeLock) return
      const l = await navigator.wakeLock.request('screen')
      S.wakeLock = l
      l.addEventListener('release', () => {
        S.wakeLock = null
      })
    } catch (e) {
      /* 忽略 */
    }
  }

  function stopKeepAlive() {
    try {
      if (S.wakeLock) S.wakeLock.release()
    } catch (e) {
      /* 忽略 */
    }
    S.wakeLock = null
  }

  /* ================= 网络层：GM_xmlhttpRequest ================= */

  const GMX = (() => {
    try {
      if (typeof GM_xmlhttpRequest === 'function') return (o) => GM_xmlhttpRequest(o)
    } catch (e) {
      /* 忽略 */
    }
    try {
      if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') return (o) => GM.xmlHttpRequest(o)
    } catch (e) {
      /* 忽略 */
    }
    return null
  })()

  function headerOf(text, name) {
    if (!text) return ''
    const m = String(text).match(new RegExp('^\\s*' + name + '\\s*:\\s*(.+?)\\s*$', 'im'))
    return m ? m[1] : ''
  }

  /** 抓一个 url 的默认 Referer：pixiv 原图必须带，fanbox CDN 也带上更稳 */
  function refererFor(url) {
    let h = ''
    try {
      h = new URL(url).hostname.toLowerCase()
    } catch (e) {
      return ''
    }
    if (/(^|\.)pximg\.net$/.test(h)) return 'https://www.pixiv.net/'
    if (/(^|\.)fanbox\.cc$/.test(h) || /(^|\.)pximg\.net$/.test(h)) return 'https://www.fanbox.cc/'
    return ''
  }

  /** 在途请求集合：点「停止」时要把它们全掐断，
   *  否则一个 5MB 还在下的文件会继续写到 10 分钟看门狗才断（B15） */
  const INFLIGHT = new Set()

  /** 掐断所有在途 GM 请求（停止按钮用；返回掐断的个数） */
  function abortAllInflight() {
    let n = 0
    for (const b of Array.from(INFLIGHT)) {
      b.aborted = true
      try {
        if (b.req && b.req.abort) {
          b.req.abort()
          n++
        }
      } catch (e) {
        /* 忽略 */
      }
    }
    INFLIGHT.clear()
    return n
  }

  /** 只发请求拿原始结果（支持进度、超时、可中断） */
  function gmRequest(opt) {
    if (!GMX) return Promise.reject(new Error('GM_xmlhttpRequest 不可用（@grant / @connect 没生效）'))
    const box = { req: null, aborted: false }
    const p = new Promise((resolve, reject) => {
      let settled = false
      const fin = (fn, v) => {
        if (settled) return
        settled = true
        box.settled = true
        INFLIGHT.delete(box)
        fn(v)
      }
      try {
        box.req = GMX({
          method: opt.method || 'GET',
          url: opt.url,
          headers: opt.headers || {},
          responseType: opt.responseType || 'text',
          timeout: opt.timeout || 120000,
          onprogress: (e) => {
            box.lastTick = Date.now()
            if (opt.onprogress) opt.onprogress(e)
          },
          onload: (r) => fin(resolve, r),
          onerror: () => fin(reject, new Error(box.aborted ? '已中止' : '网络错误（连接失败）')),
          ontimeout: () => fin(reject, new Error('请求超时')),
          onabort: () => fin(reject, new Error('已中止')),
        })
      } catch (e) {
        fin(reject, e)
      }
    })
    p.box = box
    if (!box.settled) INFLIGHT.add(box) // 同步就失败的（GMX 抛错）不进集合，否则集合永远留着死项
    p.abort = () => {
      box.aborted = true
      try {
        if (box.req && box.req.abort) box.req.abort()
      } catch (e) {
        /* 忽略 */
      }
    }
    return p
  }

  /** 取 JSON（带重试；4xx 视为确定性结果不重试；429 长等） */
  async function gmJson(url, opt = {}) {
    const tries = opt.tries || 3
    let lastErr = null
    for (let i = 0; i < tries; i++) {
      try {
        const r = await gmRequest({
          url,
          headers: Object.assign({ Accept: 'application/json, text/plain, */*' }, opt.headers || {}),
          responseType: 'text',
          timeout: opt.timeout || 25000,
        })
        if (r.status < 200 || r.status >= 300) {
          const e = new Error('HTTP ' + r.status)
          e.status = r.status
          if (r.status === 429 && opt.patience) {
            lastErr = e
            log('pixiv 返回 429（反爬），等 120 秒再试')
            await sleep(120000)
            i--
            continue
          }
          if (r.status >= 400 && r.status < 500) throw Object.assign(e, { fatal: true })
          throw e
        }
        let j = null
        try {
          j = JSON.parse(r.responseText)
        } catch (e) {
          throw new Error('返回不是 JSON：' + String(r.responseText || '').slice(0, 80))
        }
        if (j && j.error) throw new Error('接口返回 error：' + (j.message || ''))
        return j
      } catch (e) {
        lastErr = e
        if (e && e.fatal) throw e
      }
      await sleep(1200 * (i + 1))
    }
    throw lastErr || new Error('请求失败')
  }

  /* ---------------- fanbox API ---------------- */

  let apiFailStreak = 0
  const API_FAIL_LIMIT = 12

  /** 页内 fetch 取 JSON。
   *  api.fanbox.cc 的 CORS 白名单只放行 fanbox 自己的页面源：
   *   - 用 GM_xmlhttpRequest（扩展源）实测 HTTP 400，和扩展版「扩展域直连会 400」是同一个原因；
   *   - 用页内 fetch（Origin = https://www.fanbox.cc）实测 HTTP 200、返回真 JSON。
   *  所以 fanbox 的接口一律走这里，GM 只在非 fanbox 页面兜底。 */
  async function pageFetchJson(url, timeout = 25000) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeout)
    try {
      const r = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        signal: ac.signal,
        headers: { Accept: 'application/json, text/plain, */*' },
      })
      const txt = await r.text()
      if (!r.ok) {
        const e = new Error('HTTP ' + r.status)
        e.status = r.status
        e.body = txt.slice(0, 120)
        throw e
      }
      let j = null
      try {
        j = JSON.parse(txt)
      } catch (e) {
        throw new Error('返回不是 JSON：' + txt.slice(0, 80))
      }
      if (j && j.error) throw new Error('接口返回 error：' + (j.message || ''))
      return j
    } finally {
      clearTimeout(timer)
    }
  }

  async function apiFanbox(path) {
    const url = /^https?:/.test(path) ? path : 'https://api.fanbox.cc/' + path
    const onFanbox = /(^|\.)fanbox\.cc$/i.test(location.hostname)
    let lastErr = null
    let gotHttp = false
    for (let i = 0; i < 5; i++) {
      try {
        let j = null
        if (onFanbox) {
          j = await pageFetchJson(url)
        } else {
          j = await gmJson(url, {
            headers: { Referer: 'https://www.fanbox.cc/', Accept: 'application/json, text/plain, */*' },
            tries: 1,
            timeout: 25000,
          })
        }
        apiFailStreak = 0
        return j
      } catch (e) {
        lastErr = e
        if (e && e.status) gotHttp = true
        if (e && e.status >= 400 && e.status < 500) break
      }
      await sleep(1500)
    }
    if (gotHttp) apiFailStreak = 0
    else if (++apiFailStreak >= API_FAIL_LIMIT) {
      S.stopFlag = true
      throw new Error('连续 ' + apiFailStreak + ' 次 API 失败，已自动停止；检查是否还登录着 fanbox')
    }
    throw new Error('API 失败：' + url + '（' + ((lastErr && lastErr.message) || lastErr) + '）')
  }

  /* ================= 下载：GM 抓 → FSA 写 → 尾标校验 ================= */

  /** 目录句柄还活着吗（SAF 桥接层会在目录还在时偶发 NotFoundError，别据此整轮停机，见 B23） */
  async function dirAlive(dir) {
    try {
      if (!dir || typeof dir.entries !== 'function') return true
      const it = dir.entries()
      if (!it || typeof it.next !== 'function') return true
      await it.next()
      return true
    } catch (e) {
      return false
    }
  }

  const CHUNK_BYTES = 6 * 1024 * 1024

  /** 0.2.0：Range 分块下载（下载主路径）。
   *  油猴环境拿不到响应流，所以「续传」= 按区间重发 + 定位写，而不是单连接流式：
   *  每块单独一个 GM 请求，断流最多丢当前这块，台账记下总长与已写字节，下次接着要。
   *  S.rangeResume === false 时退回老路径（整包缓冲，见 downloadToFileBuffered）。 */
  async function downloadToFile(dir, name, url, opt = {}) {
    if (S.rangeResume === false) return downloadToFileBuffered(dir, name, url, opt)
    const startedAt = Date.now()
    let lastTick = Date.now()
    let req = null
    let watchdog = null
    let fh = null
    let w = null
    let startAt = 0
    let exp = 0
    let wrote = 0
    let resumed = false
    let done = false
    try {
      if (S.stopFlag) throw new Error('已停止')
      // 1) 台账 → 续传起点。必须在开可写流之前量文件长度：开流（不带 keepExistingData）会截断
      const rec = (await loadParts(dir))[name]
      if (rec) {
        const have = await getSize(dir, name)
        const e0 = Number(rec.exp) || 0
        if (have > 0 && e0 > have) {
          startAt = have
          exp = e0
          resumed = true
        } else if (have > 0 && e0 > 0 && have >= e0) {
          await partClear(dir, name) // 上次写完没销账：交给末尾校验
        }
      }
      // 2) 续传必须保留已有字节，否则一开流就把半截抹掉
      fh = await dir.getFileHandle(name, { create: true })
      w = await fh.createWritable(startAt > 0 ? { keepExistingData: true } : undefined)
      wrote = startAt
      if (resumed) log(`  ↺ ${name} 从 ${fmtBytes(startAt)} 接着下${exp ? '（共 ' + fmtBytes(exp) + '）' : ''}`)
      // 3) 一块一块要
      for (;;) {
        if (S.stopFlag) throw new Error('已停止')
        const from = startAt
        const headers = Object.assign({}, opt.headers || {})
        const ref = refererFor(url)
        if (ref && !headers.Referer) headers.Referer = ref
        headers.Range = 'bytes=' + from + '-' + (from + CHUNK_BYTES - 1)
        lastTick = Date.now()
        // 看门狗：单块 60 秒没新数据 / 整个文件 10 分钟 → 掐断（掐断后按「留半截」处理）
        watchdog = setInterval(() => {
          const now = Date.now()
          if (now - lastTick > 60000 || now - startedAt > 600000) {
            log('! 下载看门狗触发（' + Math.round((now - lastTick) / 1000) + ' 秒无新数据），掐断：' + name)
            if (req && req.abort) req.abort()
          }
        }, 5000)
        req = gmRequest({
          url,
          headers,
          responseType: 'arraybuffer',
          timeout: 300000,
          onprogress: () => {
            lastTick = Date.now()
          },
        })
        const r = await req
        clearInterval(watchdog)
        watchdog = null
        if (r.status === 416) {
          done = true // 已经下满，服务器不再给区间
          break
        }
        if (r.status !== 200 && r.status !== 206) {
          const e = new Error('HTTP ' + r.status)
          e.status = r.status
          throw e
        }
        const buf = r.response
        if (!buf || !buf.byteLength) throw new Error('响应为空（0 字节）')
        const cl = Number(headerOf(r.responseHeaders, 'content-length') || 0)
        const cr = String(headerOf(r.responseHeaders, 'content-range') || '')
        const m = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i)
        if (r.status === 200) {
          // 服务器不吃 Range（整包回 200）：从 0 重写，别在旧字节上叠加
          if (from > 0) log(`  · ${name} 服务器不支持续传（HTTP 200），从头下`)
          if (m && m[3] !== '*') exp = Number(m[3]) || exp
          if (cl) exp = cl
          await w.truncate(0)
          await w.write({ type: 'write', position: 0, data: new Blob([buf]) })
          wrote = buf.byteLength
          startAt = wrote
          if (cl && cl !== wrote) throw new Error('字节数不符 ' + wrote + '/' + cl)
          done = true
          break
        }
        const rangeStart = m ? Number(m[1]) : from
        if (m && m[3] !== '*') exp = Number(m[3]) || exp
        if (rangeStart !== from) throw new Error('服务器回的区间对不上（' + (cr || '空') + '）')
        await w.write({ type: 'write', position: rangeStart, data: new Blob([buf]) })
        startAt = rangeStart + buf.byteLength
        wrote = startAt
        if (exp && startAt >= exp) {
          done = true
          break
        }
        if (buf.byteLength < CHUNK_BYTES) {
          // 给不满一块：正常就是到文件尾了。但如果 Content-Range 已经给出总长、这里还没到总长，
          // 那就是这一段被截短了（代理/服务器只回了一部分）。不能当成功——mp4/psd 这类没有尾标的
          // 格式会静默留下一个短文件，而清单还把它记成已完成。抛出去，让重试按断点把剩下的补齐。
          if (exp && startAt < exp) {
            throw new Error('区间响应偏短（本段 ' + buf.byteLength + ' 字节，只到 ' + startAt + '/' + exp + '）')
          }
          done = true // 给不满一块 = 已经到底
          break
        }
      }
      if (!done) throw new Error('分块下载没有正常结束')
      if (!wrote) throw new Error('响应为空（0 字节）')
      await w.close()
      w = null
      // 关掉之后再验一次末尾：没 Content-Length 时这是唯一能识破「干净截断」的办法
      const chk = await tailCheck(dir, name)
      if (!chk.ok) throw new Error('文件末尾校验失败（' + chk.why + '）')
      await partClear(dir, name)
      return wrote
    } catch (e) {
      if (watchdog) clearInterval(watchdog)
      if (req && req.abort) {
        try {
          req.abort()
        } catch (e2) {
          /* 忽略 */
        }
      }
      const eName = e && e.name
      const badName = eName === 'TypeError' && /not allowed/i.test(String((e && e.message) || ''))
      let dirGone = false
      if (eName === 'NotAllowedError' || eName === 'NotFoundError') {
        dirGone = !(await dirAlive(dir))
        if (!dirGone) log(`! 写「${name}」时报 ${eName}，但目录还在 → 按单文件失败重试（不停整轮）`)
      }
      if (dirGone || eName === 'QuotaExceededError' || badName) {
        e.isFatal = true
        S.stopFlag = true
        abortAllInflight() // 空间不足/权限失效时，其它 worker 手上那几个文件也别再白下了
        if (dirGone) log('! 目录权限失效或目录已被移走，已自动停止；重新选一次文件夹再继续')
        if (eName === 'QuotaExceededError') log('! 存储空间不足，已自动停止；清出空间后点开始会续跑')
        if (badName) log('! 文件名被系统拒绝（' + name + '），已自动停止')
      }
      // 留不留半截：开了续传 / 非致命 / 真写进去过 / 知道整个多长且还没写完
      const keep = S.rangeResume !== false && !e.isFatal && wrote > 0 && exp > wrote
      if (keep) {
        try {
          // close() 才把已写字节提交进文件；abort() 会把缓冲整段丢掉
          if (w) {
            await w.close()
            w = null
          }
        } catch (e2) {
          try {
            if (w) await w.abort()
          } catch (e3) {
            /* 忽略 */
          }
        }
        await partSet(dir, name, exp, wrote)
        log(`↻ ${name} 已下 ${fmtBytes(wrote)}/${fmtBytes(exp)}，保留半截，下次从断点续传`)
      } else {
        try {
          if (w) await w.abort()
        } catch (e2) {
          /* 忽略 */
        }
        try {
          if (fh) {
            const w2 = await fh.createWritable()
            await w2.truncate(0)
            await w2.close()
          }
        } catch (e2) {
          log('! 清空残文件失败（' + name + '）：' + ((e2 && e2.message) || e2))
        }
        await partClear(dir, name)
      }
      throw e
    }
  }

  async function downloadToFileBuffered(dir, name, url, opt = {}) {
    const startedAt = Date.now()
    let lastTick = Date.now()
    let req = null
    let watchdog = null
    let fh = null
    let w = null
    try {
      if (S.stopFlag) throw new Error('已停止')
      const headers = Object.assign({}, opt.headers || {})
      const ref = refererFor(url)
      if (ref && !headers.Referer) headers.Referer = ref
      const promise = gmRequest({
        url,
        headers,
        responseType: 'arraybuffer',
        timeout: opt.timeout || 600000,
        onprogress: () => {
          lastTick = Date.now()
        },
      })
      req = promise
      // 看门狗：60 秒没有新数据 / 单文件 10 分钟绝对上限 → 掐断
      watchdog = setInterval(() => {
        const now = Date.now()
        if (now - lastTick > 60000 || now - startedAt > 600000) {
          log('! 下载看门狗触发（' + Math.round((now - lastTick) / 1000) + ' 秒无新数据），掐断：' + name)
          promise.abort()
        }
      }, 5000)
      const r = await promise
      if (r.status < 200 || r.status >= 300) {
        const e = new Error('HTTP ' + r.status)
        e.status = r.status
        throw e
      }
      let buf = r.response
      if (typeof buf === 'string' || !buf || !buf.byteLength) {
        // 绝不拿 responseText 兜底：把二进制先当文本读、再 TextEncoder 编码回去，
        // 字节会被 UTF-8 重编码（>=0x80 全变），而 jpg/png 的尾标校验根本查不出来，
        // 于是一张坏图被记成「已下完」永久跳过（B16）。拿不到二进制就直接失败。
        const e = new Error(
          typeof buf === 'string'
            ? '拿到的是文本不是二进制（responseType=arraybuffer 未生效）'
            : '响应为空（0 字节）',
        )
        e.isFatal = true
        throw e
      }
      const cl = Number(headerOf(r.responseHeaders, 'content-length') || 0)
      if (cl && cl !== buf.byteLength) throw new Error('字节数不符 ' + buf.byteLength + '/' + cl)
      clearInterval(watchdog)
      watchdog = null
      fh = await dir.getFileHandle(name, { create: true })
      w = await fh.createWritable()
      await w.write(new Blob([buf]))
      await w.close()
      w = null
      // 关掉之后再验一次末尾：没 Content-Length 时这是唯一能识破“干净截断”的办法
      const chk = await tailCheck(dir, name)
      if (!chk.ok) throw new Error('文件末尾校验失败（' + chk.why + '）')
      return buf.byteLength
    } catch (e) {
      if (watchdog) clearInterval(watchdog)
      if (req && req.abort && /超时|中止|网络错误/.test(String(e && e.message))) {
        try {
          req.abort()
        } catch (e2) {
          /* 忽略 */
        }
      }
      const eName = e && e.name
      const badName = eName === 'TypeError' && /not allowed/i.test(String((e && e.message) || ''))
      // NotAllowed/NotFound 先探活：SAF 桥接层会在目录还在的时候偶发 NotFoundError（B23），
      // 活着就只算这个文件失败（重试几轮后进失败清单，整轮继续）
      let dirGone = false
      if (eName === 'NotAllowedError' || eName === 'NotFoundError') {
        dirGone = !(await dirAlive(dir))
        if (!dirGone) log(`! 写「${name}」时报 ${eName}，但目录还在 → 按单文件失败重试（不停整轮）`)
      }
      if (dirGone || eName === 'QuotaExceededError' || badName) {
        e.isFatal = true
        S.stopFlag = true
        abortAllInflight() // 空间不足/权限失效时，其它 worker 手上那几个文件也别再白下了
        if (dirGone) log('! 目录权限失效或目录已被移走，已自动停止；重新选一次文件夹再继续')
        if (eName === 'QuotaExceededError') log('! 存储空间不足，已自动停止；清出空间后点开始会续跑')
        if (badName) log('! 文件名被系统拒绝（' + name + '），已自动停止')
      }
      // 半截文件必须清空：否则清单没记录 → 下次 expect=0 → size>0 就被当成“下完了”永久跳过
      try {
        if (w) await w.abort()
      } catch (e2) {
        /* 忽略 */
      }
      if (fh) {
        try {
          const w2 = await fh.createWritable()
          await w2.truncate(0)
          await w2.close()
        } catch (e2) {
          log('! 清空残文件失败（' + name + '）：' + ((e2 && e2.message) || e2))
        }
      }
      throw e
    }
  }

  async function downloadToFileRetry(dir, name, url, times = 4) {
    let last = null
    // 不能在 url 字符串上挂标记：'use strict' 下给原始值加属性直接抛 TypeError
    //（真机日志会变成 "Cannot create property '__refTried' on string …"），403 重试整段被打死
    let refTried = false
    for (let i = 0; i < times; i++) {
      try {
        const opt = refTried
          ? { headers: { Referer: /pximg|pixiv\.net/.test(String(url)) ? 'https://www.pixiv.net/' : 'https://www.fanbox.cc/' } }
          : undefined
        return await downloadToFile(dir, name, url, opt)
      } catch (e) {
        last = e
        if (S.stopFlag || (e && e.isFatal)) break
        // 403 常见于 CDN 校验 Referer：补一次显式 Referer 再试
        if (e && e.status === 403 && !refTried) {
          refTried = true
          log('  · HTTP 403，补 Referer 重试一次')
          continue
        }
        await sleep(1500 * (i + 1))
      }
    }
    throw last
  }

  /* ================= fanbox：投稿解析 ================= */

  /** 间隔抖动（B31）：等距节奏是脚本特征，±30%；0 表示不限速 */
  function jit(ms) {
    const base = Math.max(0, Number(ms) || 0)
    if (!base) return 0
    return Math.round(base * (0.7 + Math.random() * 0.6))
  }

  /** 单文件上限（B30）：同插件线，只拦"接口给了大小"的文件；被拦掉的篇绝不能记完成 */
  function applySizeCap(files, opts) {
    const mb = Math.max(0, Number(opts && opts.maxMB) || 0)
    if (!mb) return { keep: files, skipped: [] }
    const cap = Math.round(mb * 1048576)
    const keep = []
    const skipped = []
    for (const f of files) {
      const sz = Number(f.size) || 0
      if (sz > 0 && sz > cap) skipped.push(f)
      else keep.push(f)
    }
    return { keep, skipped }
  }

  function collectFiles(p, opts) {
    const out = []
    const seen = new Set()
    const add = (url, ext, name, kind, size) => {
      if (!url) return
      const key = String(url).split('?')[0]
      if (seen.has(key)) return
      seen.add(key)
      out.push({ url, ext: (ext || guessExt(url, 'bin')).replace(/^\./, ''), name: name || '', kind, size: Number(size) || 0 })
    }
    const b = p.body || {}
    for (const im of b.images || []) add(im.originalUrl, im.extension, '', 'image')
    if (!(b.images || []).length && b.imageMap) {
      for (const k of Object.keys(b.imageMap)) {
        const im = b.imageMap[k] || {}
        add(im.originalUrl, im.extension, '', 'image')
      }
    }
    if (opts.files) for (const f of b.files || []) add(f.url, f.extension, f.name || '', 'file', f.size)
    if (opts.cover && p.coverImage) add(p.coverImage.originalUrl, p.coverImage.extension, '', 'cover')
    if (opts.files) {
      const scan = (o, depth) => {
        if (!o || typeof o !== 'object' || depth > 4) return
        for (const k of Object.keys(o)) {
          const v = o[k]
          if (!v || typeof v !== 'object') continue
          if (typeof v.url === 'string' && /\.(mp4|webm|mov|m4a|mp3|wav|flac|zip|rar|7z|psd)$/i.test(v.url)) {
            add(v.url, '', v.name || '', 'file', v.size)
          }
          scan(v, depth + 1)
        }
      }
      scan(b, 0)
    }
    return out
  }

  function postDate(p) {
    const s = String(p.publishedDatetime || p.updatedDatetime || '')
    const m = s.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/)
    if (m) return m[1] + m[2] + m[3]
    const d = new Date(s)
    if (isNaN(d.getTime())) return '00000000'
    return d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2)
  }

  function folderNameOf(p) {
    return `${postDate(p)}-${p.id}-${sanitize(p.title, 52)}`
  }

  function fileDisplayName(f, idx) {
    const n = pad(idx + 1, 3)
    if (f.kind === 'file' && f.name) {
      const base = sanitize(f.name, 48)
      const ext = String(f.ext || '').replace(/^\./, '').toLowerCase()
      const hasReal = !!ext && base.toLowerCase().endsWith('.' + ext)
      return hasReal ? `${n}_${base}` : `${n}_${base}.${ext || 'bin'}`
    }
    return `${n}.${f.ext}`
  }

  function buildInfoText(p) {
    const lines = []
    lines.push('标题: ' + (p.title || ''))
    lines.push('投稿ID: ' + p.id)
    lines.push('日期: ' + (p.publishedDatetime || ''))
    lines.push('费用: ' + (p.feeRequired == null ? '' : p.feeRequired + ' 円'))
    lines.push('类型: ' + (p.type || ''))
    lines.push('标签: ' + ((p.tags || []).join(', ') || ''))
    lines.push('链接: https://www.fanbox.cc/@' + S.creatorId + '/posts/' + p.id)
    const author = (p.user && p.user.name) || ''
    if (author) lines.push('作者: ' + author)
    const text = (p.body && p.body.text) || ''
    if (text) {
      lines.push('')
      lines.push('---- 正文 ----')
      lines.push(text)
    }
    return lines.join('\n')
  }

  async function enumerate(creatorId, opts) {
    log('开始枚举投稿列表…')
    const first = await apiFanbox('post.paginateCreator?creatorId=' + encodeURIComponent(creatorId))
    const body = (first && first.body) || {}
    if (!Array.isArray(body.posts) && !Array.isArray(body.pageUrls)) {
      throw new Error('枚举返回异常，可能是登录态失效：' + JSON.stringify(Object.keys(body)).slice(0, 120))
    }
    const posts = Array.isArray(body.posts) ? body.posts.slice() : []
    const pageUrls = Array.isArray(body.pageUrls) ? body.pageUrls.slice() : []
    if (!posts.length && !pageUrls.length) {
      throw new Error('该画师枚举到 0 篇（检查 creatorId 是否正确、是否还登录着）')
    }
    log(`第 1 页：${posts.length} 篇；后续页 ${pageUrls.length} 个`)
    // 完整性：中途停止 / 某页没有 posts 时这份列表是残缺的，残缺表不能写进缓存
    let complete = true
    for (let i = 0; i < pageUrls.length; i++) {
      if (S.stopFlag) {
        complete = false
        break
      }
      await waitIfPaused()
      const d = await apiFanbox(pageUrls[i])
      const bodyI = d && d.body
      const ps = bodyI && Array.isArray(bodyI.posts) ? bodyI.posts : null
      if (!ps) {
        complete = false
        log(`! 第 ${i + 1}/${pageUrls.length} 页没有返回 posts（接口异常），本次枚举标记为不完整`)
        await sleep(jit(opts.interval))
        continue
      }
      posts.push(...ps)
      if ((i + 1) % 10 === 0) log(`已取 ${i + 1}/${pageUrls.length} 页，累计 ${posts.length} 篇`)
      await sleep(jit(opts.interval))
    }
    S.enumComplete = complete
    if (!complete) log('! 本次枚举不完整：结果不写入缓存，下次会重新枚举')
    const seen = new Set()
    const uniq = posts.filter((p) => {
      if (!p || !p.id || seen.has(p.id)) return false
      seen.add(p.id)
      return true
    })
    uniq.sort((a, b) => String(b.publishedDatetime || '').localeCompare(String(a.publishedDatetime || '')))
    log(`枚举完成：${uniq.length} 篇`)
    return uniq
  }

  /* ================= fanbox：单篇处理 ================= */

  function waitIfPaused() {
    return new Promise((resolve) => {
      const tick = () => {
        if (!S.paused || S.stopFlag) return resolve()
        setTimeout(tick, 300)
      }
      tick()
    })
  }

  function refreshStats() {
    const st = S.stats
    const pct = st.postsTotal ? Math.floor((st.postsDone / st.postsTotal) * 100) : 0
    const bar = $('#barFill')
    if (bar) bar.style.width = pct + '%'
    const el = $('#stats')
    if (el) {
      el.textContent =
        `进度 ${st.postsDone}/${st.postsTotal}（${pct}%） · 文件 ${st.filesDone} · 跳过文件 ${st.skip} / 整篇 ${st.skipPosts} · 失败 ${st.fail} · 已写 ${fmtBytes(st.bytes)}`
    }
  }

  async function handlePost(post, artistDir, opts) {
    const failAtStart = S.stats.fail
    let p = post
    try {
      const info = await apiFanbox('post.info?postId=' + encodeURIComponent(post.id))
      const got = info && info.body && info.body.post
      if (got) p = got
    } catch (e) {
      S.stats.fail++
      log(`✗ 取投稿信息失败 ${post.id}：${e.message}`)
      S.failed.push({ post_id: post.id, title: post.title, folder: '', file: '', url: '', kind: 'post.info', error: String((e && e.message) || e) })
      return { status: 'fail', total: 0, attempted: 0 }
    }
    if (p.isRestricted) {
      S.stats.skipPosts++
      log(`- 受限未购买，跳过：${post.id} ${sanitize(p.title, 30)}`)
      return { status: 'restricted', total: 0, attempted: 0 }
    }
    let files = collectFiles(p, opts)
    const hasText = !!(opts.text && p.body && (p.body.text || p.body.html))
    const bodyHasAttach =
      !!(p.body && p.body.imageMap && Object.keys(p.body.imageMap).length) ||
      !!(p.body && p.body.images && p.body.images.length) ||
      !!(opts.files && p.body && p.body.files && p.body.files.length)
    // B30：先按单文件上限筛一遍；超限的文件本轮不下，这篇也不会被记成完成
    const capRes = applySizeCap(files, opts)
    const capSkip = capRes.skipped.length
    if (capSkip) {
      let capBytes = 0
      for (const f of capRes.skipped) capBytes += Number(f.size) || 0
      S.stats.capSkip = (S.stats.capSkip || 0) + capSkip
      S.stats.capSkipBytes = (S.stats.capSkipBytes || 0) + capBytes
      log(`· 上限跳过 ${capSkip} 个文件（约 ${fmtBytes(capBytes)}，该篇不记完成）`)
    }
    const filesAll = files
    files = capRes.keep
    if (!filesAll.length && bodyHasAttach) {
      S.stats.fail++
      log(`✗ ${post.id} 有附件字段却解析出 0 个文件（接口可能改版），不记完成`)
      S.failed.push({ post_id: p.id, title: p.title, folder: '', file: '', url: '', kind: '接口改版', error: 'suspect' })
      return { status: 'suspect', total: 0, attempted: 0 }
    }
    if (!files.length && !hasText) {
      log(`- 无文件：${post.id} ${sanitize(p.title, 30)}`)
      return { status: 'empty', total: 0, attempted: 0 }
    }
    const folder = folderNameOf(p)
    let dir = null
    try {
      dir = await artistDir.getDirectoryHandle(folder, { create: true })
    } catch (e) {
      S.stats.fail++
      log(`✗ 建作品文件夹失败 ${post.id}：${e.name || ''} ${e.message}`)
      if (e && (e.name === 'NotAllowedError' || e.name === 'NotFoundError') && !(await dirAlive(artistDir))) {
        S.stopFlag = true
        log('! 目录权限失效或目录已被移走，已停止；重新选一次文件夹再继续')
      }
      return { status: 'fail', total: 0, attempted: 0 }
    }
    if (opts.text) {
      try {
        await writeText(dir, '投稿信息.txt', buildInfoText(p))
      } catch (e) {
        log(`! 写 txt 失败 ${post.id}：${e.message}`)
      }
    }
    let savedHere = 0
    let attempted = 0
    const jobs = files.map((f, i) => ({ f, name: fileDisplayName(f, i) }))
    let cursor = 0
    const worker = async () => {
      for (;;) {
        if (S.stopFlag) return
        await waitIfPaused()
        if (S.stopFlag) return
        const idx = cursor++
        if (idx >= jobs.length) return
        attempted++
        const { f, name } = jobs[idx]
        const old = S.index.get(folder + '|' + name)
        const expect = old && Number(old.bytes) > 0 ? Number(old.bytes) : 0
        const sizeOk = await fileOk(dir, name, expect)
        const complete = sizeOk && (await fileComplete(dir, name, expect))
        // 文件级判据永远生效，和「跳过已存在」（整篇级）是两件事（B24）：想强制重下就删掉那个文件
        if (complete) {
          S.stats.skip++
          S.records.push({
            post_id: p.id, title: p.title, date: p.publishedDatetime, fee: p.feeRequired,
            folder, file: name, url: f.url, bytes: await getSize(dir, name), skipped: true,
          })
          continue
        }
        try {
          const bytes = await downloadToFileRetry(dir, name, f.url)
          S.stats.filesDone++
          S.stats.bytes += bytes
          savedHere++
          refreshStats()
          log(`  · ${name}  ${fmtBytes(bytes)}`)
          S.records.push({ post_id: p.id, title: p.title, date: p.publishedDatetime, fee: p.feeRequired, folder, file: name, url: f.url, bytes })
        } catch (e) {
          if (e && e.isFatal) {
            S.stats.fail++
            log(`✗ 下载失败 ${p.id}/${name}：${e.message}`)
            S.failed.push({ post_id: p.id, title: p.title, folder, file: name, url: f.url, kind: '致命错误（权限/空间/文件名）', error: String((e && e.message) || e) })
            S.stopFlag = true
            return
          }
          if (S.stopFlag) return
          S.stats.fail++
          log(`✗ 下载失败 ${p.id}/${name}：${e.message}`)
          log('   ' + f.url)
          S.failed.push({ post_id: p.id, title: p.title, date: p.publishedDatetime, fee: p.feeRequired, folder, file: name, url: f.url, error: String((e && e.message) || e) })
        }
        await sleep(jit(opts.interval))
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(3, opts.concurrency || 1)) }, worker))
    if (S.stopFlag) {
      log(`⊘ ${p.id} 中断（已下 ${savedHere}/${jobs.length}，下次会补齐剩余）`)
      return { status: 'stopped', total: jobs.length, attempted }
    }
    const failedHere = S.stats.fail - failAtStart
    if (failedHere > 0) log(`△ ${p.id} ${sanitize(p.title, 34)}（${files.length} 个文件，新增 ${savedHere}，失败 ${failedHere}）`)
    else log(`✓ ${p.id} ${sanitize(p.title, 34)}（${files.length} 个文件，新增 ${savedHere}）`)
    return { status: 'ok', total: jobs.length, attempted, filtered: capSkip }
  }

  /* ================= 清单 / 索引 / 进度 ================= */

  async function readManifest(name) {
    const f = await (await S.artistDir.getFileHandle(name)).getFile()
    const txt = await f.text()
    const m = new Map()
    let bad = 0
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line)
        if (r && r.folder && r.file) m.set(r.folder + '|' + r.file, r)
        else bad++
      } catch (e) {
        bad++
      }
    }
    return { map: m, bad, size: f.size }
  }

  async function loadIndex() {
    S.index = new Map()
    if (!S.artistDir) return
    let main = null
    let bak = null
    try {
      main = await readManifest('_清单.jsonl')
    } catch (e) {
      main = null
    }
    try {
      bak = await readManifest('_清单.bak.jsonl')
    } catch (e) {
      bak = null
    }
    if (main) {
      S.index = main.map
      log(`读到上一轮清单：${main.map.size} 条`)
    } else {
      log('上一轮没有清单，按首次运行处理')
    }
    let added = 0
    if (bak && bak.map.size) {
      for (const [k, v] of bak.map) {
        if (!S.index.has(k)) {
          S.index.set(k, v)
          added++
        }
      }
    }
    if (added > 0) log(`! 主清单少了 ${added} 条且备份更完整，已从 _清单.bak.jsonl 补齐（合计 ${S.index.size} 条）`)
    else if (main && main.bad > 0) log(`! 主清单有 ${main.bad} 行解析失败，已跳过这些行`)
  }

  // quiet=true：照常落盘但少打一条日志。收藏分组每组都要落盘一次，
  // 而 endRunUI 收尾还会再写一次 —— 不静音的话一轮会看到两条一模一样的「已写清单」。
  async function writeIndex(quiet) {
    if (!S.artistDir) return
    try {
      for (const r of S.records) S.index.set(r.folder + '|' + r.file, r)
      S.records = []
      const all = Array.from(S.index.values())
      try {
        const oldF = await (await S.artistDir.getFileHandle('_清单.jsonl')).getFile()
        if (oldF.size > 0) await writeText(S.artistDir, '_清单.bak.jsonl', await oldF.text())
      } catch (e) {
        /* 首次运行 */
      }
      await writeText(S.artistDir, '_清单.jsonl', all.map((r) => JSON.stringify(r)).join('\n'))
      const head = 'post_id,date,fee,folder,file,bytes,url\n'
      const rows = all
        .map((r) =>
          [r.post_id, r.date || '', r.fee == null ? '' : r.fee, r.folder, r.file, r.bytes, r.url]
            .map((x) => `"${String(x).replace(/"/g, '""')}"`)
            .join(','),
        )
        .join('\n')
      await writeText(S.artistDir, '_索引.csv', '\ufeff' + head + rows)
      if (!quiet) log(`已写清单：${all.length} 条（_清单.jsonl / _索引.csv）`)
    } catch (e) {
      log('! 写清单失败：' + e.message)
    }
  }

  const LEGACY_FLAT = '__旧版直存__'

  function progKeyOf(id) {
    return 'ffdl:prog:' + (S.site === 'pixiv' ? 'pixiv:' : '') + id
  }

  function readProgStore(key) {
    let cur = null
    try {
      cur = JSON.parse(localStorage.getItem(key) || 'null')
    } catch (e) {
      cur = null
    }
    if (!cur || typeof cur !== 'object') return {}
    if (cur.runs && typeof cur.runs === 'object') return cur.runs
    const runs = {}
    if (cur.done) {
      runs[String(cur.sig)] = { dir: cur.dir || '', done: cur.done, t: Date.now() }
      return runs
    }
    const keys = Object.keys(cur)
    if (keys.length && keys.every((k) => /^\d+$/.test(k))) runs[LEGACY_FLAT] = { dir: '', done: cur, t: 0 }
    return runs
  }

  /** 从槽位名解析当时的选项（JSON 签名 或 folder|files|cover|text|skip；裸 done 表返回 null） */
  function optsOfSlot(k) {
    const s = String(k)
    if (s.startsWith('{')) {
      try {
        const o = JSON.parse(s)
        return { files: o.files ? 1 : 0, cover: o.cover ? 1 : 0, text: o.text ? 1 : 0 }
      } catch (e) {
        return null
      }
    }
    const m = s.match(/^(.*)\|(\d)\|(\d)\|(\d)\|(\d)$/)
    if (m) return { files: Number(m[2]) ? 1 : 0, cover: Number(m[3]) ? 1 : 0, text: Number(m[4]) ? 1 : 0 }
    return null
  }

  function loadProg(key, curSig, folder, need) {
    const runs = readProgStore(key)
    // 选项不可知的槽位（v0.1.2 裸 done 表等）：本轮只要图片就认领；本轮要附件/封面就不认领，
    // 否则那几十篇被整篇跳过、附件永远下不到（B22，和 B02 同源）。不认领代价很小——已下好的
    // 文件按清单字节数 + 尾标跳过，不会重下。
    const canClaim = (k) => {
      const so = optsOfSlot(k)
      if (!so) {
        if (need && (need.files || need.cover)) {
          log(`! 旧进度「${String(k).slice(0, 20)}」无法确认那一轮下没下过附件；本次勾了附件，不认领它（已下好的文件会按字节跳过，不会重下）`)
          return false
        }
        return true
      }
      return !need || optsCovers(so, need)
    }
    let picked = runs[curSig]
    let how = 'sig'
    if (!picked && runs[LEGACY_FLAT] && canClaim(LEGACY_FLAT)) {
      picked = runs[LEGACY_FLAT]
      how = 'flat'
    }
    if (!picked) {
      let best = null
      const base = stripSiteSuffix(folder)
      for (const k of Object.keys(runs)) {
        if (k === LEGACY_FLAT) continue
        const head = String(k).split('|')[0]
        if (!head) continue
        // 只认「完全同名」和「老的纯名字」；带别的站点后缀的槽位绝不认领，否则同名画师跨站会串进度
        if (head !== folder && head !== base) continue
        const rec = runs[k]
        if (rec && rec.site && rec.site !== S.site) continue
        // 名字对上还不够：那一轮的选项得**覆盖**本轮要下的东西，
        // 否则「同文件夹这次多勾了附件」会认领只下过图片的完成标记 → 整站跳过、附件一个不下
        const slotOpts = optsOfSlot(k)
        if (slotOpts && need && !optsCovers(slotOpts, need)) continue
        if (!slotOpts && !canClaim(k)) continue // 选项不可知 + 本轮要附件 → 同样不认领
        if (!best || Object.keys((runs[k] && runs[k].done) || {}).length > Object.keys((runs[best] && runs[best].done) || {}).length) best = k
      }
      if (best) {
        picked = runs[best]
        how = 'loose'
      }
    }
    if (picked && picked.done) return { done: picked.done, len: Object.keys(picked.done).length, how }
    return { done: {}, len: 0, how: '' }
  }

  function saveProg() {
    if (!S.progSig || !S.creatorId) return
    const key = progKeyOf(S.creatorId)
    const runs = readProgStore(key)
    runs[S.progSig] = { dir: S.totalFolder, done: S.done, t: Date.now(), site: S.site }
    const keys = Object.keys(runs).sort((a, b) => (runs[b].t || 0) - (runs[a].t || 0))
    for (const k of keys.slice(20)) delete runs[k]
    lsSet(key, { runs })
  }

  /* ================= pixiv 数据层 ================= */

  const PL = {
    async getJson(path, opt) {
      const url = /^https?:/.test(path) ? path : 'https://www.pixiv.net' + path
      return await gmJson(url, Object.assign({ patience: true }, opt || {}))
    },
    async getUser(uid) {
      const j = await PL.getJson('/ajax/user/' + encodeURIComponent(uid) + '?lang=zh')
      return (j && j.body) || {}
    },
    async getProfileAll(uid) {
      const j = await PL.getJson('/ajax/user/' + encodeURIComponent(uid) + '/profile/all?lang=zh')
      const b = (j && j.body) || {}
      const pick = (o) => Object.keys(o || {}).filter((k) => /^\d+$/.test(k))
      return { illusts: pick(b.illusts), manga: pick(b.manga), novels: pick(b.novels) }
    },
    /** 自己（当前登录账号）的 uid：收藏模式「uid 留空」时靠它兜底。
     *  三层兜底，越靠前越省事：
     *   ① 页面全局：pixiv 自己的前端把 uid 挂在 pixiv.user.id / pixiv.context.userId 上，同步可取；
     *   ② /ajax/user/extra：登录态下 body 里带 userId（未登录会返回 error，gmJson 直接抛）；
     *   ③ dashboard 的 HTML 里抠 `pixiv.user.id = "12345"`（pixiv 没有 /ajax/user/self 这类接口，
     *      扩展版一直用这条路，油猴版留着当最后一道保险）。
     *  三层全落空就返回 ''，由 doRun 给一句「请在账号 uid 框里填你自己的数字 uid」。 */
    async getSelfUid() {
      try {
        const g = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window
        const u = g.pixiv || {}
        const id = (u.user && u.user.id) || (u.context && u.context.userId) || ''
        if (/^\d+$/.test(String(id))) return String(id)
      } catch (e) {
        /* 拿不到就下一层 */
      }
      try {
        const j = await PL.getJson('/ajax/user/extra?lang=zh')
        const b = (j && j.body) || {}
        const id = b.userId || b.user_id || b.id || ''
        if (/^\d+$/.test(String(id))) return String(id)
      } catch (e) {
        /* 拿不到就下一层 */
      }
      try {
        const r = await gmRequest({ url: 'https://www.pixiv.net/dashboard', headers: { Referer: 'https://www.pixiv.net/' }, timeout: 25000 })
        const t = String(r.responseText || '')
        const m = t.match(/pixiv\.user\.id\s*=\s*"(\d+)"/) || t.match(/"user_id"\s*:\s*"(\d+)"/)
        if (m) return String(m[1])
      } catch (e) {
        /* 三层都失败，让用户手填 */
      }
      return ''
    },
    /** 收藏夹枚举（B32）。真机实测端点（2026-11）：
     *    /ajax/user/<uid>/illusts/bookmarks?tag=&offset=<n>&limit=48&rest=show&lang=zh
     *    /ajax/user/<uid>/novels/bookmarks?tag=&offset=<n>&limit=48&rest=show&lang=zh
     *  两种都返回 body.works / body.total —— 插画和小说**都是 works**（小说那条没有 novels 字段）。
     *  旧文档/别处的实现写的是 body.novels，两个键都认，免得哪天真换键就一条都读不到。
     *  返回 [{ id, kind, userId, userName, title }]，其中 userId 是**作者**的 uid（分组落点要用）。
     *  注意这是「我收藏了谁的作品」，不是「我的作品」，所以不能复用上面的 profile/all 枚举。 */
    async getBookmarks(uid, opt = {}) {
      const kind = opt.kind === 'novel' ? 'novel' : 'illust'
      const sub = kind === 'novel' ? '/novels/bookmarks' : '/illusts/bookmarks'
      const LIMIT = 48
      const out = []
      let offset = 0
      for (;;) {
        // 点「停止」/「暂停」在枚举阶段也要生效：收藏动辄上千条，枚举完再停要等好几分钟。
        // 中途停下的表是残表，直接抛出去 —— 上层就不会把它写进账本（残表当全量，换机会永久漏篇）。
        if (S.stopFlag) throw new Error('已停止（收藏枚举不完整，本次不写账本）')
        await waitIfPaused()
        const url =
          'https://www.pixiv.net/ajax/user/' + encodeURIComponent(uid) + sub + '?tag=&offset=' + offset + '&limit=' + LIMIT + '&rest=show&lang=zh'
        const j = await PL.getJson(url)
        const b = (j && j.body) || {}
        const list = (Array.isArray(b.works) && b.works) || (Array.isArray(b.novels) && b.novels) || []
        if (!list.length) break
        for (const w of list) {
          const wid = w && (w.id != null ? w.id : w.workId)
          if (wid == null) continue
          out.push({
            id: String(wid),
            kind,
            userId: String((w && w.userId) || ''),
            userName: (w && w.userName) || '',
            title: (w && w.title) || '',
          })
        }
        if (opt.onPage) {
          try {
            opt.onPage(out.length, Number(b.total) || 0)
          } catch (e) {
            /* 回调出错不影响枚举 */
          }
        }
        if (list.length < LIMIT) break
        offset += LIMIT
        if (out.length >= (Number(opt.max) || 50000)) break
        // 别用等距节奏去打收藏列表（那是脚本特征）：700ms + 0~600ms 抖动
        await sleep(700 + Math.round(Math.random() * 600))
      }
      return out
    },
    async getIllust(id) {
      const j = await PL.getJson('/ajax/illust/' + encodeURIComponent(id) + '?lang=zh')
      return (j && j.body) || {}
    },
    async getPages(id) {
      const j = await PL.getJson('/ajax/illust/' + encodeURIComponent(id) + '/pages?lang=zh')
      return Array.isArray(j && j.body) ? j.body : []
    },
    async getUgoiraMeta(id) {
      const j = await PL.getJson('/ajax/illust/' + encodeURIComponent(id) + '/ugoira_meta?lang=zh')
      return (j && j.body) || {}
    },
    async getNovel(id) {
      const j = await PL.getJson('/ajax/novel/' + encodeURIComponent(id) + '?lang=zh')
      return (j && j.body) || {}
    },
    guessExt,
    pad,
    filesFromPages(pages) {
      const files = []
      pages.forEach((p, i) => {
        const url = p && p.urls && (p.urls.original || p.urls.regular)
        if (!url) return
        files.push({ url, ext: guessExt(url, 'jpg'), name: '', kind: 'image', seq: pad(i + 1, 3), page: i, width: p.width || 0, height: p.height || 0 })
      })
      return files
    },
    filesFromUgoira(meta) {
      const zipUrl = meta.originalSrc || meta.src
      if (!zipUrl) return []
      return [
        {
          url: zipUrl,
          ext: 'zip',
          name: '',
          kind: 'ugoira_zip',
          seq: '001',
          ugoira: { mime: meta.mime_type || 'image/jpeg', frames: (meta.frames || []).length },
          note: meta.originalSrc ? '1920x1080 原始 zip' : '600x600 zip',
        },
      ]
    },
  }

  /** 取用「手工导入的枚举」：只认同一站点、同一个画师的清单，对不上就作废。
   *  只「取用」不「消费」——预检也要用这份清单，真正清空等过了预检分支（与扩展版 B14 同一条规矩）。
   *  不清空的话这个标志会永远挂着，「用上次枚举」等于被永久关掉。 */
  function takeImported(creatorId) {
    const list = S.importedPosts
    if (!Array.isArray(list) || !list.length) return null
    const f = S.importedFor
    const cid = String(creatorId || '')
    if (f && (String(f.site || '') !== String(S.site || '') || String(f.creator || '') !== cid)) {
      log(`! 导入的清单属于 ${siteTag(f.site)} 的 ${f.creator || '（未填画师）'}，与本次 ${siteTag(S.site)} 的 ${cid || '（未填画师）'} 不同，作废不用`)
      S.importedPosts = null
      S.importedFor = null
      return null
    }
    return list
  }

  function toIso(d) {
    const s = String(d || '')
    const m = s.match(/^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
    if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00`
    return s
  }

  function pixivWorkToPost(w) {
    return {
      id: String(w.id),
      title: w.title || '',
      publishedDatetime: toIso(w.createDate || w.uploadDate),
      feeRequired: 0,
      tags: (w.tags && w.tags.tags ? w.tags.tags : []).map((t) => t.tag).filter(Boolean),
      user: { name: w.userName || '' },
      xRestrict: w.xRestrict,
      illustType: w.illustType,
      pageCount: w.pageCount,
    }
  }

  function htmlToText(html) {
    return String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  function pixivInfoText(detail, post, isNovel) {
    const lines = []
    const t = Number(detail.illustType)
    const typeName = isNovel ? '小说' : t === 2 ? '动图(ugoira)' : t === 1 ? '漫画' : '插画'
    lines.push('标题: ' + (detail.title || ''))
    lines.push('作品ID: ' + detail.id)
    lines.push('类型: ' + typeName)
    lines.push('日期: ' + (detail.createDate || detail.uploadDate || ''))
    if (isNovel) {
      lines.push('字数: ' + htmlToText(detail.content).length)
    } else {
      lines.push('页数: ' + (detail.pageCount == null ? '' : detail.pageCount))
      lines.push('宽高: ' + (detail.width || '') + ' x ' + (detail.height || ''))
    }
    lines.push('年龄限制: ' + (Number(detail.xRestrict) === 1 ? 'R-18' : Number(detail.xRestrict) === 2 ? 'R-18G' : '全年龄'))
    lines.push('标签: ' + (post.tags.join(', ') || ''))
    lines.push('作者: ' + (detail.userName || ''))
    lines.push('作者ID: ' + (detail.userId || ''))
    lines.push('链接: ' + (isNovel ? 'https://www.pixiv.net/novel/show.php?id=' + detail.id : 'https://www.pixiv.net/artworks/' + detail.id))
    if (detail.ugoiraMeta) {
      lines.push('动图帧数: ' + (detail.ugoiraMeta.frames || []).length)
      lines.push('动图原始zip: ' + (detail.ugoiraMeta.originalSrc || detail.ugoiraMeta.src || ''))
    }
    return lines.join('\n') + '\n'
  }

  async function buildPixivFiles(w, detail) {
    if (w.kind === 'novel') return []
    const t = Number(detail.illustType)
    if (t === 2) {
      const meta = await PL.getUgoiraMeta(detail.id)
      detail.ugoiraMeta = meta
      return PL.filesFromUgoira(meta)
    }
    const pc = Number(detail.pageCount) || 1
    if (pc <= 1) {
      const u = detail.urls || {}
      const url = u.original || u.regular
      return url ? [{ url, ext: guessExt(url, 'jpg'), name: '', kind: 'image', seq: pad(1, 3) }] : []
    }
    const pages = await PL.getPages(detail.id)
    return PL.filesFromPages(pages)
  }

  function pixivFileName(f) {
    if (f.kind === 'ugoira_zip') return `${f.seq}_ugoira.${f.ext}`
    return `${f.seq}.${f.ext}`
  }

  async function writeUgoiraInfo(dir, zipName, detail) {
    const meta = detail.ugoiraMeta || {}
    const frames = (meta.frames || []).map((f) => ({ file: f.file, delay: f.delay }))
    try {
      await writeText(dir, '动图信息.json', JSON.stringify({ id: String(detail.id), mime: meta.mime_type || '', zip: zipName, frameCount: frames.length, frames }, null, 1))
    } catch (e) {
      log('! 写 动图信息.json 失败：' + e.message)
    }
  }

  /** 0.2.3：已删除 / 转私密的作品，详情或动图元数据会回 HTTP 404。
   *  收藏里这种条目会一直躺在列表里，按「失败」记等于每轮都报一片红；
   *  按「已失效、跳过」记更诚实（日志里说清原因，不计进失败数）。 */
  function isGone404(e) {
    return /HTTP 404/.test(String((e && e.message) || e))
  }

  async function handlePixivWork(w, artistDir, opts) {
    const failAtStart = S.stats.fail
    const isNovel = w.kind === 'novel'
    let detail = null
    try {
      detail = isNovel ? await PL.getNovel(w.id) : await PL.getIllust(w.id)
    } catch (e) {
      if (isGone404(e)) {
        S.stats.skipPosts++
        log(`· ${w.id} 已失效（HTTP 404），跳过：收藏里被删掉或转私密的作品会一直这样`)
        return { status: 'gone', total: 0, attempted: 0 }
      }
      S.stats.fail++
      log(`✗ 取作品信息失败 ${w.id}：${(e && e.message) || e}`)
      S.failed.push({ post_id: w.id, folder: '', file: '', url: '', kind: 'work.info', error: String((e && e.message) || e) })
      return { status: 'fail', total: 0, attempted: 0 }
    }
    const post = pixivWorkToPost(detail)
    let files = []
    try {
      files = await buildPixivFiles({ id: w.id, kind: isNovel ? 'novel' : 'illust' }, detail)
    } catch (e) {
      if (isGone404(e)) {
        S.stats.skipPosts++
        // 详情接口 404 = 作品真没了；而「详情好、页面列表 404」是另一种情况（受限/被拒绝），
        // 两种都跳过，但话要说准，不然会把还活着的作品记成「已失效」。
        log(`· ${w.id} 取页面列表被拒（HTTP 404），跳过：作品详情正常，这篇可能是受限内容`)
        return { status: 'gone', total: 0, attempted: 0 }
      }
      S.stats.fail++
      log(`✗ 取文件列表失败 ${w.id}：${(e && e.message) || e}`)
      S.failed.push({ post_id: w.id, folder: '', file: '', url: '', kind: 'work.files', error: String((e && e.message) || e) })
      return { status: 'fail', total: 0, attempted: 0 }
    }
    // B30：pixiv 侧同样受单文件上限约束（命中的主要是动图 zip 这类大文件）
    const capRes2 = applySizeCap(files, opts)
    const capSkip2 = capRes2.skipped.length
    if (capSkip2) {
      let capBytes = 0
      for (const f of capRes2.skipped) capBytes += Number(f.size) || 0
      S.stats.capSkip = (S.stats.capSkip || 0) + capSkip2
      S.stats.capSkipBytes = (S.stats.capSkipBytes || 0) + capBytes
      log(`· 上限跳过 ${capSkip2} 个文件（约 ${fmtBytes(capBytes)}，该篇不记完成）`)
    }
    const filesAll2 = files
    files = capRes2.keep
    if (!filesAll2.length && !isNovel) {
      log(`- 无文件：${w.id} ${sanitize(post.title, 30)}`)
      return { status: 'empty', total: 0, attempted: 0 }
    }
    const folder = folderNameOf(post)
    let dir = null
    try {
      dir = await artistDir.getDirectoryHandle(folder, { create: true })
    } catch (e) {
      S.stats.fail++
      log(`✗ 建作品文件夹失败 ${w.id}：${e.name || ''} ${e.message}`)
      if (e && (e.name === 'NotAllowedError' || e.name === 'NotFoundError') && !(await dirAlive(artistDir))) {
        S.stopFlag = true
        log('! 目录权限失效或目录已被移走，已停止；重新选一次文件夹再继续')
      }
      return { status: 'fail', total: 0, attempted: 0 }
    }
    if (opts.text) {
      try {
        await writeText(dir, '投稿信息.txt', pixivInfoText(detail, post, isNovel))
        if (isNovel) {
          await writeText(dir, '正文.txt', `${detail.title || ''}\n\n${htmlToText(detail.content)}\n`)
          log(`  · 小说正文 ${htmlToText(detail.content).length} 字`)
        }
      } catch (e) {
        log(`! 写 txt 失败 ${w.id}：${e.message}`)
      }
    }
    if (isNovel) {
      if (!opts.text) {
        // 没勾「投稿信息 txt」时小说没有文件可写：不能建个空文件夹然后记完成，
        // 否则以后勾上 txt 也不会再补写正文
        log(`- 小说但未勾「投稿信息 txt」，跳过：${w.id}`)
        return { status: 'empty', total: 0, attempted: 0 }
      }
      log(`✓ ${w.id} ${sanitize(post.title, 34)}（小说，已写正文）`)
      return { status: 'ok', total: 1, attempted: 1 }
    }

    let savedHere = 0
    let attempted = 0
    let zipName = ''
    let zipOk = false
    const jobs = files.map((f) => ({ f, name: pixivFileName(f) }))
    let cursor = 0
    const worker = async () => {
      for (;;) {
        if (S.stopFlag) return
        await waitIfPaused()
        if (S.stopFlag) return
        const idx = cursor++
        if (idx >= jobs.length) return
        attempted++
        const { f, name } = jobs[idx]
        const old = S.index.get(folder + '|' + name)
        const expect = old && Number(old.bytes) > 0 ? Number(old.bytes) : 0
        const sizeOk = await fileOk(dir, name, expect)
        const complete = sizeOk && (await fileComplete(dir, name, expect))
        // 文件级判据永远生效，和「跳过已存在」（整篇级）是两件事（B24）：想强制重下就删掉那个文件
        if (complete) {
          S.stats.skip++
          if (f.kind === 'ugoira_zip') {
            zipName = name
            zipOk = true
          }
          S.records.push({ post_id: post.id, title: post.title, date: post.publishedDatetime, folder, file: name, url: f.url, bytes: await getSize(dir, name), skipped: true })
          continue
        }
        try {
          const bytes = await downloadToFileRetry(dir, name, f.url)
          S.stats.filesDone++
          S.stats.bytes += bytes
          savedHere++
          if (f.kind === 'ugoira_zip') {
            zipName = name
            zipOk = true
          }
          refreshStats()
          log(`  · ${name}  ${fmtBytes(bytes)}`)
          S.records.push({ post_id: post.id, title: post.title, date: post.publishedDatetime, folder, file: name, url: f.url, bytes })
        } catch (e) {
          if (e && e.isFatal) {
            S.stats.fail++
            log(`✗ 下载失败 ${post.id}/${name}：${e.message}`)
            S.failed.push({ post_id: post.id, folder, file: name, url: f.url, kind: '致命错误', error: String(e.message || e) })
            S.stopFlag = true
            return
          }
          if (S.stopFlag) return
          S.stats.fail++
          log(`✗ 下载失败 ${post.id}/${name}：${e.message}`)
          log('   ' + f.url)
          S.failed.push({ post_id: post.id, title: post.title, folder, file: name, url: f.url, error: String((e && e.message) || e) })
        }
        await sleep(jit(opts.interval))
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(3, opts.concurrency || 1)) }, worker))
    if (zipOk && !S.stopFlag) await writeUgoiraInfo(dir, zipName, detail)
    if (S.stopFlag) {
      log(`⊘ ${post.id} 中断（已下 ${savedHere}/${jobs.length}，下次会补齐剩余）`)
      return { status: 'stopped', total: jobs.length, attempted }
    }
    const failedHere = S.stats.fail - failAtStart
    if (failedHere > 0) log(`△ ${post.id} ${sanitize(post.title, 34)}（${jobs.length} 个文件，新增 ${savedHere}，失败 ${failedHere}）`)
    else log(`✓ ${post.id} ${sanitize(post.title, 34)}（${jobs.length} 个文件，新增 ${savedHere}）`)
    return { status: 'ok', total: jobs.length, attempted, filtered: capSkip2 }
  }

  /* ================= 主流程 ================= */

  /** 当前「来源」下拉的值：artist=按画师枚举 / fav=我的收藏。
   *  统一从这里读，别各处直接摸 #optSource —— 判定散在多处时总有一处会忘更新。 */
  function sourceOf() {
    const el = $('#optSource')
    return el && el.value === 'fav' ? 'fav' : 'artist'
  }

  function favLayoutOf() {
    const el = $('#optFavLayout')
    return el && el.value === 'group' ? 'group' : 'flat'
  }

  /** 「来源」变了：站点、徽标、输入框提示、收藏结构行、导入按钮的可用性一起跟着切。
   *  收藏是 pixiv 专属功能，所以来源=我的收藏时运行时站点强制切 pixiv（fanbox 页面上也一样）；
   *  切回去时站点还原成页面自己的站点 —— 否则在 fanbox 页面里选过一次收藏，
   *  之后按画师下载会用 pixiv 的接口去查 fanbox 的 creatorId。 */
  function syncSource() {
    S.source = sourceOf()
    S.favLayout = favLayoutOf()
    S.site = S.source === 'fav' ? 'pixiv' : SITE
    const badge = $('#siteBadge')
    if (badge) badge.textContent = S.site === 'pixiv' ? 'PIXIV' : 'FANBOX'
    const cIn = $('#creator')
    if (cIn) {
      cIn.placeholder =
        S.source === 'fav' ? '数字 uid（留空 = 当前登录账号）' : SITE === 'pixiv' ? 'uid 或 /users/<uid> 链接' : 'creatorId 或主页链接'
    }
    const layRow = $('#favLayoutRow')
    if (layRow) layRow.style.display = S.source === 'fav' ? 'flex' : 'none'
    const hint = $('#srcHint')
    if (hint) {
      hint.textContent =
        S.source === 'fav'
          ? '收藏：枚举「我的收藏」全部作品 → _我的收藏 (PIXIV)/' + (S.favLayout === 'group' ? '<画师名> (PIXIV)/' : '') + '<作品文件夹>/'
          : `按画师枚举（目标站点 ${siteTag(S.site)}）`
    }
    const imp = $('#importPosts')
    if (imp) {
      // 收藏是按画师分组分别下的，没有「一份清单 = 一个目录」的落点：按钮上就写清楚，
      // 别让用户挑完文件才发现点了没用
      imp.disabled = S.source === 'fav'
      imp.textContent = S.source === 'fav' ? '导入清单（收藏模式不可用）' : '导入清单'
      imp.title =
        S.source === 'fav'
          ? '收藏是按画师分组分别下的，导进来的清单没有落点，所以收藏模式不支持导入'
          : '从 JSON 清单导入要下的作品/投稿（导入后点「开始下载」）'
    }
  }

  function readOpts() {
    const num = (sel, def) => {
      const el = $(sel)
      const v = el ? Number(el.value) : NaN
      return isNaN(v) ? def : v
    }
    const chk = (sel, def) => {
      const el = $(sel)
      return el ? !!el.checked : def
    }
    return {
      interval: Math.max(0, num('#optInterval', 300)),
      concurrency: Math.max(1, Math.min(3, num('#optConcurrency', 1))),
      limit: Math.max(0, num('#optLimit', 0)),
      skip: chk('#optSkip', true),
      files: chk('#optFiles', true),
      cover: chk('#optCover', false),
      text: chk('#optText', true),
      useCache: chk('#optUseCache', true),
      maxMB: Math.max(0, num('#optMaxMB', 0)),
    }
  }

  function beginRunUI() {
    S.paused = false
    S.stopFlag = false
    S.stats = { postsTotal: 0, postsDone: 0, filesDone: 0, skip: 0, skipPosts: 0, fail: 0, bytes: 0 }
    S.records = []
    S.failed = []
    S.artistDir = null
    S.posts = []
    S.done = {}
    S.progSig = ''
    S.totalFolder = ''
    S.verified = {}
    S.optsCur = null
    S.diskFolders = null
    S.diskFoldersDir = null
    S.postsAll = null
    S.enumComplete = true
    const set = (sel, dis) => {
      const el = $(sel)
      if (el) el.disabled = dis
    }
    set('#start', true)
    set('#precheck', true)
    set('#pause', false)
    set('#stop', false)
  }

  async function endRunUI() {
    stopKeepAlive()
    try {
      await writeIndex()
    } catch (e) {
      /* 自己会记日志 */
    }
    try {
      saveProg()
      if (S.artistDir && S.stats.postsTotal) {
        if (!S.singlePostId && S.enumComplete !== false) {
          await writeText(
            S.artistDir,
            '_投稿列表.json',
            // 用 postsAll（「最多篇数」截断之前）：把截断表当全量存档，换机续跑会永久漏篇
            JSON.stringify((S.postsAll && S.postsAll.length ? S.postsAll : S.posts).map((p) => ({ id: p.id, title: p.title, date: p.publishedDatetime, fee: p.feeRequired, kind: p.kind || '' })), null, 1),
          )
        }
        await writeText(
          S.artistDir,
          '_进度.json',
          JSON.stringify(
            {
              site: S.site,
              creatorId: S.creatorId,
              folder: S.totalFolder,
              // 这份清单是在什么选项下写的：以后多勾了文件种类时靠它判断旧标记还算不算数
              opts: optsFlags(S.optsCur),
              total: S.stats.postsTotal,
              donePosts: Object.keys(S.done).length,
              // 累计口径（清单合计），不是本轮统计
              files: Array.from(S.index.values()).length,
              bytes: Array.from(S.index.values()).reduce((a, r) => a + (Number(r && r.bytes) || 0), 0),
              lastRun: { files: S.stats.filesDone, bytes: S.stats.bytes, fail: S.stats.fail },
              skip: S.stats.skip,
              skipPosts: S.stats.skipPosts,
              fail: S.stats.fail,
              updatedAt: new Date().toISOString(),
            },
            null,
            1,
          ),
        )
        await writeText(S.artistDir, '_失败清单.json', JSON.stringify(S.failed, null, 1))
        await writeDonePosts()
      }
    } catch (e) {
      log('! 写进度文件失败：' + e.message)
    }
    S.running = false
    const set = (sel, dis) => {
      const el = $(sel)
      if (el) el.disabled = dis
    }
    set('#start', false)
    set('#precheck', false)
    set('#pause', true)
    set('#stop', true)
    const pz = $('#pause')
    if (pz) pz.textContent = '暂停'
  }

  async function doRun(mode) {
    if (S.running) return
    S.running = true
    try {
      // 放进 try：beginRunUI 要碰 DOM，抛错时 S.running 已置真 → 按钮全灰且再也点不动
      beginRunUI()
      const raw = ($('#creator') && $('#creator').value) || ''
      const favSrc = sourceOf() === 'fav'
      S.source = favSrc ? 'fav' : 'artist'
      // 收藏是 pixiv 专属：判定只认「来源」下拉，不再依赖进页面时是什么站点。
      // 不切站点的话，同一个数字 uid 会被当成 fanbox 的 creatorId 去查另一套编号。
      if (favSrc && S.site !== 'pixiv') {
        S.site = 'pixiv'
        const b0 = $('#siteBadge')
        if (b0) b0.textContent = 'PIXIV'
        log('! 来源＝我的收藏 → 切到 pixiv 线')
      }
      let creatorId = S.site === 'pixiv' ? parsePixivUid(raw) : parseCreator(raw)
      if (favSrc) {
        // 目录权限必须趁「刚点过按钮」的用户手势窗口期申请：下面可能要查自己的 uid、
        // 再枚举上千件收藏（真机约 80 秒），等枚举完再申请必然报 User activation is required。
        await ensurePermission()
        if (creatorId) {
          // 0.2.2：「画师」和「收藏」共用同一个输入框，切到收藏时里面常留着上次的画师 uid。
          // 不提醒的话会以为在下「自己的收藏」，实际枚举的是那个 uid 的公开收藏（真机踩到过）。
          log(`! 收藏用的是输入框里的 uid ${creatorId}（不是当前登录账号）；要下自己的收藏请把这个框清空`)
        }
        if (!creatorId) {
          creatorId = await PL.getSelfUid()
          if (creatorId) log(`用当前登录账号的 uid：${creatorId}`)
        }
      }
      if (!creatorId) {
        throw new Error(
          favSrc
            ? '拿不到你的 pixiv uid：请在「账号 uid」框里填你自己的数字 uid（或先登录 pixiv 再试）'
            : S.site === 'pixiv'
              ? 'pixiv uid 解析失败（填数字 uid 或 /users/<uid> 链接）'
              : '画师 ID 解析失败，请填主页链接或 creatorId',
        )
      }
      S.creatorId = creatorId
      if (favSrc) S.favUid = creatorId // 导出/账本要用「账号 uid」，别用后面按组改写的 S.creatorId
      // 站点分叉：pixiv 的 uid 与 fanbox 的 creatorId 是两套体系，绝不能混着请求
      if (S.site === 'pixiv') {
        if (favSrc) await runFav(mode, creatorId, favLayoutOf())
        else await runPixiv(mode, creatorId)
      } else await runFanbox(mode, creatorId)
    } catch (e) {
      log('✗ 中断：' + ((e && e.message) || e))
    } finally {
      await endRunUI()
    }
  }

  async function runFanbox(mode, creatorId) {
    await ensurePermission()
    const o = readOpts()
    const opts = { interval: o.interval, concurrency: o.concurrency, skip: o.skip, files: o.files, cover: o.cover, text: o.text, useCache: o.useCache, maxMB: Math.max(0, Number(o.maxMB) || 0) }
    S.optsCur = opts
    const listKey = 'ffdl:posts:' + creatorId
    const progKey = progKeyOf(creatorId)
    let posts = []
    // 从画师卡片进来时，先用文件夹里的 _投稿列表.json 顶替枚举：换机/清 localStorage 也能不联网枚举就续跑
    let presetPosts = null
    if (opts.useCache && S.presetArtist && S.presetArtist.folder) {
      try {
        const d0 = await S.parent.getDirectoryHandle(S.presetArtist.folder)
        const arr = JSON.parse(await (await d0.getFileHandle('_投稿列表.json')).getFile().then((f) => f.text()))
        if (Array.isArray(arr) && arr.length) {
          const nm = S.presetArtist.artistName || stripSiteSuffix(S.presetArtist.folder)
          presetPosts = arr
            .map((p) => ({ id: String(p.id), title: p.title || '', publishedDatetime: p.date || p.publishedDatetime || '', feeRequired: p.fee, user: { name: nm } }))
            .filter((p) => p.id)
          if (presetPosts.length) log(`用文件夹里的 _投稿列表.json：${presetPosts.length} 篇（免枚举）`)
        }
      } catch (e) {
        /* 没有就算了 */
      }
    }
    const importedF = takeImported(creatorId) // 手工导入的清单要先验来源：站点/画师对不上就作废
    const cached = opts.useCache ? lsGet(listKey, null) : null
    if (importedF) {
      posts = importedF
        .map((p) => ({ id: String(p.id), title: p.title || '', publishedDatetime: p.publishedDatetime || p.date || '', feeRequired: p.feeRequired != null ? p.feeRequired : p.fee, user: p.user || null }))
        .filter((p) => p.id)
      log(`用导入的清单：${posts.length} 篇`)
    } else if (Array.isArray(cached) && cached.length) {
      posts = cached
      log(`用上次枚举：${posts.length} 篇（取消勾「用上次枚举」可重新枚举）`)
    } else if (presetPosts && presetPosts.length) {
      posts = presetPosts
    } else {
      posts = await enumerate(creatorId, opts)
      if (S.enumComplete === false) {
        log('! 枚举不完整，这份列表不写进缓存（避免往后每轮都在残表上续跑）')
      } else {
        lsSet(listKey, posts.map((p) => ({ id: p.id, title: p.title, publishedDatetime: p.publishedDatetime, feeRequired: p.feeRequired, tags: p.tags, user: p.user ? { name: p.user.name } : null })))
        log(`枚举列表已存档（${posts.length} 篇）`)
      }
    }
    let list = posts
    if (S.singlePostId) {
      const one = posts.filter((p) => String(p.id) === String(S.singlePostId))
      if (!one.length) {
        // 缓存枚举可能是昨天的：新发的投稿点「下载本篇」不该直接失败（post.info 会补标题/日期）
        log(`! ${S.singlePostId} 不在枚举结果里，仍按单篇处理（post.info 会补标题）`)
        list = [{ id: S.singlePostId, title: '', publishedDatetime: '', user: (posts[0] && posts[0].user) || null }]
      } else {
        list = one
        log(`单篇模式：只处理投稿 ${S.singlePostId}`)
      }
    }
    if (o.limit > 0) list = list.slice(0, o.limit)
    S.postsAll = list.slice() // 截断前的完整表（截断表不能当全量存档）
    S.posts = list
    S.stats.postsTotal = list.length
    refreshStats()

    if (mode === 'precheck') {
      const sample = Math.max(1, Math.min(3, list.length))
      let files = 0
      for (const p of list.slice(0, sample)) {
        try {
          const info = await apiFanbox('post.info?postId=' + p.id)
          const got = info && info.body && info.body.post
          if (got) files += collectFiles(got, opts).length
          await sleep(jit(opts.interval))
        } catch (e) {
          /* 忽略 */
        }
      }
      const avg = files / sample
      log(`预检：约 ${list.length} 篇，平均 ${avg.toFixed(1)} 个文件/篇 → 约 ${Math.round(avg * list.length)} 个文件`)
      log('预检结束（没有下载任何文件）')
      return
    }

    // 过了预检分支才消费掉导入的清单（预检也要用这份清单；不消费的话它永远挂着，「用上次枚举」等于被关掉）
    S.importedPosts = null
    S.importedFor = null

    keepScreenOn()
    startSilentAudio()

    const artistName = sanitize((posts[0] && posts[0].user && posts[0].user.name) || creatorId, 60)
    const override = String(($('#optArtistFolder') && $('#optArtistFolder').value) || '').trim()
    let totalFolder = override ? sanitize(override, 60) : ''
    let resolved = null
    if (!totalFolder && S.presetArtist && S.presetArtist.folder) {
      // 只认同一站点的预设，并核对文件夹里的站点标记（跨站会把文件写进另一站的文件夹，
      // 还会把它的 _站点.json 覆盖成错的站点，而程序里没有撤销路径）
      if (S.presetArtist.site && S.presetArtist.site !== S.site) {
        log(`! 卡片上的文件夹属于 ${siteTag(S.presetArtist.site)}，本次是 ${siteTag(S.site)}，不用它`)
        S.presetArtist = null
      } else {
        const cand = await S.parent.getDirectoryHandle(S.presetArtist.folder).catch(() => null)
        const info = cand ? await readSiteOf(cand) : null
        if (cand && info && info.site && info.site !== S.site) {
          log(`! 文件夹「${S.presetArtist.folder}」已标记为 ${siteTag(info.site)}，与本次 ${siteTag(S.site)} 不同，不沿用`)
          S.presetArtist = null
        } else if (cand) {
          totalFolder = S.presetArtist.folder
          resolved = { dir: cand, name: totalFolder }
        }
      }
    }
    if (!resolved) {
      resolved = await resolveArtistDir(totalFolder || artistName)
      totalFolder = resolved.name
    }
    S.totalFolder = totalFolder
    const sigObj = { parent: (S.parent && S.parent.name) || '', folder: totalFolder, files: opts.files ? 1 : 0, cover: opts.cover ? 1 : 0, text: opts.text ? 1 : 0, skip: opts.skip ? 1 : 0 }
    S.progSig = JSON.stringify(sigObj)
    const prog = loadProg(progKey, S.progSig, totalFolder, optsFlags(opts))
    S.artistDir = resolved.dir
    await writeSiteFile(S.artistDir, creatorId, artistName)
    let progDone = prog.done
    let progLen = prog.len
    // 老进度只看总文件夹名、不认父目录：换到另一个同名空目录时会整套认领旧标记 →
    // 进度条跑满、一篇不下，还把空目录永久记成已完成。空目录里不可能有已完成的篇。
    if (progLen && prog.how !== 'sig') {
      let hasSub = false
      try {
        for await (const [, h] of S.artistDir.entries()) {
          if (h.kind === 'directory') {
            hasSub = true
            break
          }
        }
      } catch (e) {
        hasSub = true
      }
      if (!hasSub) {
        log(`! 旧版进度（${progLen} 篇）在本目录里找不到任何作品文件夹，判定是另一个目录的同名文件夹，不沿用`)
        progDone = {}
        progLen = 0
      }
    }
    S.done = progDone
    if (progLen) log(`续跑：已有 ${progLen} 篇完成标记${prog.how === 'sig' ? '' : '（沿用旧版进度）'}`)
    await loadIndex()
    try {
      const inferred = await applyManifestInference(list, opts)
      let added = 0
      for (const k of Object.keys(inferred.inferred)) {
        if (!S.done[k]) {
          S.done[k] = 1
          added++
        }
      }
      if (added) {
        log(`其中 ${added} 篇是 localStorage 里没有的，已补上`)
        saveProg()
      }
    } catch (e) {
      log('! 落盘进度反推失败：' + e.message)
    }
    log(`总文件夹：${totalFolder}/（共 ${list.length} 篇）`)

    for (let i = 0; i < list.length; i++) {
      if (S.stopFlag) {
        log('已停止')
        break
      }
      await waitIfPaused()
      const post = list[i]
      // 跳过闸门：不只看 localStorage 标记，还要确认磁盘上这篇的文件夹还在
      if (await shouldSkipPost(S.artistDir, post, opts)) {
        S.stats.skipPosts++
        S.stats.postsDone = i + 1
        refreshStats()
        continue
      }
      const failBefore = S.stats.fail
      const r = await handlePost(post, S.artistDir, opts)
      const complete = !S.stopFlag && !!r && r.status === 'ok' && S.stats.fail === failBefore && r.attempted === r.total && !r.filtered
      if (complete) {
        S.done[post.id] = 1
        S.verified[post.id] = 1 // 「整篇跑完」的落盘证据（清单里出现过文件夹不算）
      } else delete S.done[post.id]
      S.stats.postsDone = i + 1
      refreshStats()
      if ((i + 1) % 20 === 0) {
        await writeIndex()
        await writeDonePosts()
        saveProg()
      }
    }
    if (!S.stopFlag && S.failed.length) await retryFailed(opts)
    log(`${S.stopFlag ? '已中止：' : '完成：'}新增 ${S.stats.filesDone} 个文件，跳过文件 ${S.stats.skip} / 整篇 ${S.stats.skipPosts}，失败 ${S.stats.fail}，共 ${fmtBytes(S.stats.bytes)}`)
  }

  /* ================= 我的收藏（B32） =================
   * 收藏是「我收藏了谁的作品」，不是「我的作品」，所以不能复用上面的 profile/all 枚举。
   * 落盘一行都不新写：每组作品通过 S.importedPosts 灌进 runPixiv（就是「导入枚举」那条通道），
   * 再用「总文件夹名」输入框钉住这一组的文件夹名 —— 清单 / 进度 / 完成证据 / 补漏轮全部沿用现成管线，
   * 也就不存在「收藏一套写盘、画师一套写盘」两个版本以后各修各的。
   *  layout='flat'  → <下载根>/_我的收藏 (PIXIV)/<作品文件夹>/
   *  layout='group' → <下载根>/_我的收藏 (PIXIV)/<画师名> (PIXIV)/<作品文件夹>/
   */

  /** 按作者分组：件数多的组在前（先下大的，中途停了也先拿到多的那些）；组内保持枚举顺序 */
  function groupByArtist(works) {
    const m = new Map()
    for (const w of works || []) {
      const key = String(w.userId || 'unknown')
      if (!m.has(key)) {
        const nm = String(w.userName || '').trim()
        // 0.2.3：收藏列表把「已屏蔽 / 已删除」的条目抹成 "-----"（userId 给 0）——
        // 这种名字不能当真画师名用，否则会在收藏目录下建出一个「----- (PIXIV)/」。
        const placeholder = !nm || /^-+$/.test(nm)
        m.set(key, { key, userId: key, name: placeholder ? '_未标注作者' : sanitize(nm, 60), works: [] })
      }
      m.get(key).works.push(w)
    }
    return [...m.values()].sort((a, b) => b.works.length - a.works.length)
  }

  async function runFav(mode, uid, layout) {
    const group = layout === 'group'
    log(`枚举收藏（uid ${uid}）：插画/漫画 + 小说…`)
    const illus = await PL.getBookmarks(uid, { kind: 'illust', onPage: (n, total) => log(`  · 收藏已读 ${n}${total ? '/' + total : ''} 条`) })
    const novels = await PL.getBookmarks(uid, { kind: 'novel' })
    const seen = new Set()
    let works = illus.concat(novels).filter((w) => (seen.has(w.id) ? false : (seen.add(w.id), true)))
    log(`收藏共 ${works.length} 件（插画/漫画 ${illus.length}，小说 ${novels.length}，去重后 ${works.length}）`)
    // 0.2.2：被屏蔽/未公开的条目在列表里作者被抹成 -----（userId=0）。平面落点不受影响，
    // 分组落点却会把这些凑成一组；先报个数，让人知道那个「_未标注作者」是怎么来的。
    const noAuthor = works.filter((w) => !w.userId).length
    if (noAuthor) log(`  · 其中 ${noAuthor} 件作者被列表抹成 "-----"（多半已被屏蔽/未公开），分组时归到「_未标注作者」`)
    if (!works.length) throw new Error('这个 uid 没有收藏（或没登录 / uid 不对）')
    // 账本要在「最多篇数」截断**之前**存：截断后的表当全量存档，换机续跑会永久漏篇。
    // 键里带 fav: 前缀，不会和这个 uid 当画师时的 ffdl:posts:pixiv:<uid> 撞。
    // 元素带 userId/userName：分组落点靠它分画师，导出后也还能看出谁是作者。
    lsSet(
      'posts:pixiv:fav:' + uid,
      works.map((w) => ({ id: w.id, kind: w.kind, title: w.title || '', userId: w.userId || '', userName: w.userName || '' })),
    )
    const limit = readOpts().limit
    if (limit > 0) works = works.slice(0, limit) // 截断日志交给 runPixiv 打印，别重复两条
    const groups = group ? groupByArtist(works) : [{ key: 'all', userId: '', name: '_我的收藏', works }]
    if (group) log(`按画师分组：${groups.length} 位画师（${groups.slice(0, 3).map((g) => g.name + '×' + g.works.length).join('、')}${groups.length > 3 ? ' …' : ''}）`)

    const rootParent = S.parent
    const folderInput = $('#optArtistFolder')
    const oldFolderValue = folderInput ? folderInput.value : ''
    try {
      if (group) {
        // 把「下载根」临时下移一层：这样每个画师就是一个正常的画师文件夹，runPixiv 一行都不用改
        S.parent = await rootParent.getDirectoryHandle('_我的收藏 (PIXIV)', { create: true })
        log('写入位置：_我的收藏 (PIXIV)/<画师名> (PIXIV)/<作品文件夹>/')
      } else {
        log('写入位置：_我的收藏 (PIXIV)/<作品文件夹>/')
      }
      for (let gi = 0; gi < groups.length; gi++) {
        if (S.stopFlag) break
        const g = groups[gi]
        if (group) log(`—— 画师 ${gi + 1}/${groups.length}：${g.name}（${g.works.length} 件）`)
        // 总文件夹名钉成这一组的名字（平铺那一组就叫 _我的收藏，后缀由 resolveArtistDir 补成 (PIXIV)）
        if (folderInput) folderInput.value = g.name
        const cid = 'fav:' + uid + (group ? ':' + g.userId : '')
        S.importedPosts = g.works.map((w) => ({ id: w.id, kind: w.kind }))
        S.importedFor = { site: 'pixiv', creator: cid }
        S.creatorId = cid // 进度槽位按组分开：saveProg 用的是 S.creatorId，不跟着换就会把各组的完成标记写进同一个槽
        await runPixiv(mode, cid)
        if (mode === 'precheck') continue
        // 每组跑完就把这一组的清单/完成证据落进它自己的文件夹：
        // writeIndex 写的是「当前 artistDir」，攒到最后一组再写会把前几组的记录写进别人的清单
        // quiet：收尾的 endRunUI 还会再写一次，不让「已写清单」一轮打两遍
        await writeIndex(true)
        await writeDonePosts()
        saveProg()
        for (const k of Object.keys(S.verified)) delete S.verified[k]
      }
    } finally {
      // 必须还原：后面所有运行都按 S.parent 算路径，还原晚了就是往收藏文件夹里继续写
      S.parent = rootParent
      if (folderInput) folderInput.value = oldFolderValue
    }
  }

  async function runPixiv(mode, creatorId) {
    await ensurePermission()
    const o = readOpts()
    const opts = { interval: o.interval, concurrency: o.concurrency, skip: o.skip, text: o.text, useCache: o.useCache, maxMB: Math.max(0, Number(o.maxMB) || 0) }
    S.optsCur = opts
    const listKey = 'ffdl:posts:pixiv:' + creatorId
    const progKey = progKeyOf(creatorId)

    let list = null
    let artistName = ''
    // 手工导入的清单 / 收藏分组灌进来的那一组：都走这条通道，不另开一套落盘逻辑。
    // 类型没标的一律按插画处理（导出的是 id+kind，收藏账本里也带 kind）。
    const importedP = takeImported(creatorId)
    if (importedP) {
      list = importedP.map((p) => ({ id: String(p.id), kind: p.kind === 'novel' ? 'novel' : 'illust' }))
      log(`用导入的清单：${list.length} 件（类型没标的一律按插画处理）`)
    }
    if (!list && o.useCache) {
      const c = lsGet(listKey, null)
      if (Array.isArray(c) && c.length) {
        list = c
        log(`用上次枚举：${c.length} 件（取消勾「用上次枚举」可重新枚举）`)
      }
    }
    if (!list) {
      log('枚举 pixiv 作品…')
      const user = await PL.getUser(creatorId)
      artistName = user.name || ''
      const all = await PL.getProfileAll(creatorId)
      const ids = [...new Set([...all.illusts, ...all.manga])].map(Number).sort((a, b) => b - a)
      const novels = [...new Set(all.novels)].map(Number).sort((a, b) => b - a)
      list = ids.map((id) => ({ id, kind: 'illust' })).concat(novels.map((id) => ({ id, kind: 'novel' })))
      log(`枚举到 ${list.length} 件（插画/漫画 ${ids.length}，小说 ${novels.length}）`)
      if (!list.length) throw new Error('一件作品都没枚举到（可能全部受限或未公开）')
      lsSet(listKey, list)
    }
    let works = list
    if (S.singlePostId) {
      works = works.filter((p) => String(p.id) === String(S.singlePostId))
      log('单篇模式：只处理作品 ' + S.singlePostId)
      if (!works.length) {
        works = [{ id: S.singlePostId, kind: S.singlePostKind || 'illust' }]
        log('! 该作品不在公开列表里，仍按单篇处理')
      }
    }
    if (o.limit > 0) {
      works = works.slice(0, o.limit)
      log('限制最多 ' + o.limit + ' 件')
    }
    S.postsAll = works.slice()
    S.posts = works
    S.stats.postsTotal = works.length
    refreshStats()

    if (mode === 'precheck') {
      for (let i = 0; i < works.length; i++) {
        if (S.stopFlag) break
        await waitIfPaused()
        const w = works[i]
        try {
          if (w.kind === 'novel') {
            const n = await PL.getNovel(w.id)
            log(`  ${i + 1}. ${w.id} [小说] ${sanitize(n.title, 26)}`)
          } else {
            const d = await PL.getIllust(w.id)
            const t = Number(d.illustType)
            log(`  ${i + 1}. ${w.id} ${t === 2 ? '[动图]' : t === 1 ? '[漫画]' : '[插画]'} ${sanitize(d.title, 26)} 页=${d.pageCount} R=${d.xRestrict}`)
          }
        } catch (e) {
          log(`  ✗ ${w.id}：${(e && e.message) || e}`)
        }
        S.stats.postsDone = i + 1
        refreshStats()
        await sleep(jit(opts.interval))
      }
      log('预检结束（没有下载任何文件）')
      return
    }

    // 过了预检分支才消费掉导入的清单（与 fanbox 线同一条规矩）
    S.importedPosts = null
    S.importedFor = null

    if (!artistName) {
      try {
        const d0 = await PL.getIllust(works[0].id)
        artistName = d0.userName || ''
      } catch (e) {
        /* 退回 uid */
      }
    }
    // 单篇模式：总文件夹名必须取自「这件作品的作者」，不能取「请求的 uid 的名字」。
    // 真机踩过：点别人的作品进来时 uid 和作品作者不是同一个人 → 同一个作品先后落进两个画师文件夹，
    // 清单也是各存一份，等于白下一遍还把目录搞乱。
    if (S.singlePostId) {
      try {
        const dO = works[0] && works[0].kind === 'novel' ? await PL.getNovel(works[0].id) : await PL.getIllust(works[0].id)
        if (dO && dO.userName) artistName = dO.userName
      } catch (e) {
        /* 取不到就沿用上面的名字 */
      }
    }
    const override = String(($('#optArtistFolder') && $('#optArtistFolder').value) || '').trim()
    let totalFolder = override ? sanitize(override, 60) : ''
    let resolvedP = null
    if (!totalFolder && S.presetArtist && S.presetArtist.folder) {
      if (S.presetArtist.site && S.presetArtist.site !== S.site) {
        log(`! 卡片上的文件夹属于 ${siteTag(S.presetArtist.site)}，本次是 ${siteTag(S.site)}，不用它`)
        S.presetArtist = null
      } else {
        const cand = await S.parent.getDirectoryHandle(S.presetArtist.folder).catch(() => null)
        const info = cand ? await readSiteOf(cand) : null
        if (cand && info && info.site && info.site !== S.site) {
          log(`! 文件夹「${S.presetArtist.folder}」已标记为 ${siteTag(info.site)}，与本次 ${siteTag(S.site)} 不同，不沿用`)
          S.presetArtist = null
        } else if (cand) {
          totalFolder = S.presetArtist.folder
          resolvedP = { dir: cand, name: totalFolder }
        }
      }
    }
    if (!resolvedP) {
      resolvedP = await resolveArtistDir(totalFolder || artistName || creatorId)
      totalFolder = resolvedP.name
    }
    S.totalFolder = totalFolder
    const sigObj = { parent: (S.parent && S.parent.name) || '', folder: totalFolder, text: opts.text ? 1 : 0, skip: opts.skip ? 1 : 0 }
    S.progSig = JSON.stringify(sigObj)
    S.artistDir = resolvedP.dir
    await writeSiteFile(S.artistDir, creatorId, artistName || creatorId)
    const prog = loadProg(progKey, S.progSig, totalFolder, optsFlags(opts))
    let progDone = prog.done
    let progLen = prog.len
    // 与 fanbox 线同一条抽查：老进度不认父目录，换到另一个同名空目录会整套认领 → 一件不下
    if (progLen && prog.how !== 'sig') {
      let hasSub = false
      try {
        for await (const [, h] of S.artistDir.entries()) {
          if (h.kind === 'directory') {
            hasSub = true
            break
          }
        }
      } catch (e) {
        hasSub = true
      }
      if (!hasSub) {
        log(`! 旧版进度（${progLen} 件）在本目录里找不到任何作品文件夹，判定是另一个目录的同名文件夹，不沿用`)
        progDone = {}
        progLen = 0
      }
    }
    S.done = progDone
    if (progLen) log(`续跑：已有 ${progLen} 件完成标记`)
    await loadIndex()
    try {
      const inferred = await applyManifestInference(works, opts)
      let added = 0
      for (const k of Object.keys(inferred.inferred)) {
        if (!S.done[k]) {
          S.done[k] = 1
          added++
        }
      }
      if (added) {
        log(`其中 ${added} 件是 localStorage 里没有的，已补上`)
        saveProg()
      }
    } catch (e) {
      log('! 落盘进度反推失败：' + e.message)
    }
    log(`总文件夹：${totalFolder}/（共 ${works.length} 件）`)

    keepScreenOn()
    startSilentAudio()

    for (let i = 0; i < works.length; i++) {
      if (S.stopFlag) {
        log('已停止')
        break
      }
      await waitIfPaused()
      const w = works[i]
      if (await shouldSkipPost(S.artistDir, w, opts)) {
        S.stats.skipPosts++
        S.stats.postsDone = i + 1
        refreshStats()
        continue
      }
      const failBefore = S.stats.fail
      const r = await handlePixivWork(w, S.artistDir, opts)
      const complete = !S.stopFlag && !!r && r.status === 'ok' && S.stats.fail === failBefore && r.attempted === r.total && !r.filtered
      if (complete) {
        S.done[w.id] = 1
        S.verified[w.id] = 1
      } else delete S.done[w.id]
      S.stats.postsDone = i + 1
      refreshStats()
      if ((i + 1) % 20 === 0) {
        await writeIndex()
        await writeDonePosts()
        saveProg()
      }
      await sleep(jit(opts.interval))
    }
    if (!S.stopFlag && S.failed.length) await retryFailed(opts)
    log(`完成：新增 ${S.stats.filesDone} 个文件，跳过文件 ${S.stats.skip} / 整件 ${S.stats.skipPosts}，失败 ${S.stats.fail}，共 ${fmtBytes(S.stats.bytes)}`)
  }

  async function retryFailed(opts) {
    const retry = S.failed.slice()
    const retryable = retry.filter((it) => it.url && it.file && it.folder)
    S.failed = retry.filter((it) => !(it.url && it.file && it.folder))
    log(`补漏：${retryable.length} 个文件失败，集中重试一轮`)
    let ok = 0
    let streakFail = 0
    for (const it of retryable) {
      if (S.stopFlag) break
      await waitIfPaused()
      try {
        const d = await S.artistDir.getDirectoryHandle(it.folder, { create: true })
        const bytes = await downloadToFileRetry(d, it.file, it.url, 6)
        S.stats.filesDone++
        S.stats.bytes += bytes
        S.stats.fail = Math.max(0, S.stats.fail - 1)
        ok++
        streakFail = 0
        log(`  ✓ 补下 ${it.file} ${fmtBytes(bytes)}`)
        refreshStats()
        S.records.push({ post_id: it.post_id, title: it.title, date: it.date, fee: it.fee, folder: it.folder, file: it.file, url: it.url, bytes })
      } catch (e) {
        S.failed.push(it)
        streakFail++
        log(`  ✗ 补下仍失败 ${it.file}：${(e && e.message) || e}`)
        if (streakFail >= 8) {
          log('! 连续 8 个补下都失败，疑似网络中断，补漏轮提前结束（条目留在 _失败清单.json）')
          break
        }
      }
      await sleep(jit(opts.interval))
    }
    log(`补漏结束：成功 ${ok}，仍失败 ${S.failed.length}`)
  }

  /* ================= 页面识别 ================= */

  function detectPage() {
    const out = { creatorId: '', postId: '', kind: '' }
    try {
      if (SITE === 'fanbox') {
        let m = location.pathname.match(/\/@([A-Za-z0-9_-]+)\/posts\/(\d+)/)
        if (m) {
          out.creatorId = m[1]
          out.postId = m[2]
          return out
        }
        m = HOST.match(/^([A-Za-z0-9_-]+)\.fanbox\.cc$/)
        if (m) {
          out.creatorId = m[1]
          const mp = location.pathname.match(/\/posts\/(\d+)/)
          if (mp) out.postId = mp[1]
          return out
        }
        m = location.pathname.match(/\/@([A-Za-z0-9_-]+)/)
        if (m) out.creatorId = m[1]
      } else {
        const p = location.pathname
        const q = new URLSearchParams(location.search)
        let m = p.match(/\/artworks\/(\d+)/) || p.match(/\/i\/(\d+)/)
        if (m) out.postId = m[1]
        else if (/\/novel\/show\.php$/.test(p)) {
          const id = q.get('id') || ''
          if (/^\d+$/.test(id)) {
            out.postId = id
            out.kind = 'novel'
          }
        } else {
          const lid = q.get('illust_id') || ''
          if (/^\d+$/.test(lid)) out.postId = lid
        }
        m = p.match(/\/users\/(\d+)/)
        if (m) out.creatorId = m[1]
        if (!out.creatorId) {
          const u = q.get('u') || ''
          if (/^\d+$/.test(u)) out.creatorId = u
        }
      }
    } catch (e) {
      /* 忽略 */
    }
    return out
  }

  /* ================= UI ================= */

  const CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:system-ui,-apple-system,"Noto Sans SC",sans-serif}
#fab{position:fixed;right:10px;bottom:calc(120px + env(safe-area-inset-bottom,0px));z-index:2147483600;
  width:46px;height:46px;border-radius:50%;background:#0a7d4f;color:#fff;display:flex;align-items:center;
  justify-content:center;font-size:21px;box-shadow:0 3px 12px rgba(0,0,0,.35);cursor:pointer;
  -webkit-user-select:none;user-select:none;touch-action:manipulation}
#panel{position:fixed;left:0;right:0;bottom:0;z-index:2147483601;background:#1b1d21;color:#e8e8e8;
  border-radius:14px 14px 0 0;padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px));
  max-height:78vh;overflow:auto;box-shadow:0 -4px 20px rgba(0,0,0,.5);display:none;font-size:12px;line-height:1.5}
#panel.on{display:block}
.hd{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.hd b{font-size:13px;font-weight:600}
.badge{background:#2b6cb0;color:#fff;border-radius:6px;padding:1px 6px;font-size:11px}
.hd .sp{flex:1}
.x{width:26px;height:26px;border-radius:50%;background:#33363c;color:#ddd;display:flex;align-items:center;
  justify-content:center;cursor:pointer;font-size:15px}
label.row{display:flex;align-items:center;gap:6px;margin:4px 0}
label.row span{color:#9aa0a6;min-width:62px}
/* 0.2.2：数字框不能跟着 flex:1 一起被压——360px 宽时四个框会被挤成 18px、最后一个跑出屏（真机实测 374>360） */
label.row input[type=number]{flex:0 0 76px;width:76px;min-width:0;text-align:center}
input[type=text],input[type=number],select{flex:1;min-width:0;background:#26292e;border:1px solid #3a3e45;color:#e8e8e8;
  border-radius:7px;padding:6px 8px;font-size:12px}
#srcHint{color:#9aa0a6;font-size:11px;margin:2px 0 5px}
.chks{display:flex;flex-wrap:wrap;gap:10px;margin:6px 0}
.chks label{display:flex;align-items:center;gap:4px;color:#c9ccd1}
.btns{display:flex;flex-wrap:wrap;gap:7px;margin:8px 0}
/* 0.2.3：动作行钉在面板底边。画师文件夹一多，这一行会被列表顶到视口外（真机 y=661 > 656），
   用户一打开看不到「开始下载」就像坏了；sticky 之后无论列表多长都留在可见区。 */
.btns.act{position:sticky;bottom:0;z-index:3;background:#1b1d21;padding:6px 0 3px;margin:8px 0 2px;
  box-shadow:0 -10px 14px -8px rgba(0,0,0,.75)}
button{border:0;border-radius:8px;padding:8px 13px;font-size:12.5px;color:#fff;background:#3a3e45;cursor:pointer}
button:disabled{opacity:.42}
#pick{background:#5b5f66}
#start{background:#0a7d4f}
#precheck{background:#2b6cb0}
#pause{background:#8a6d1f}
#stop{background:#a33}
#exportPosts,#importPosts{background:#4a4e55}
#bar{height:5px;background:#2a2d32;border-radius:3px;overflow:hidden;margin:8px 0 5px}
#barFill{height:100%;width:0;background:#0a7d4f;transition:width .2s}
#stats{color:#9aa0a6;font-size:11.5px}
#log{margin-top:7px;background:#111316;border:1px solid #2a2d32;border-radius:8px;padding:7px;
  height:150px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,monospace;
  font-size:10.5px;line-height:1.45;color:#b9c0c8}
#dirName{color:#7fd1a3;margin-left:2px}
.arw{margin:6px 0 2px}
.arh{display:flex;align-items:center;gap:6px;color:#9aa0a6;font-size:11.5px;margin-bottom:5px}
.arh .sp{flex:1}
.arh button{padding:4px 9px;font-size:11px;background:#3a3e45}
/* 0.2.3：27vh 时，扫到 10 个画师文件夹后「开始下载」会被挤到视口外（真机量到 y=680 > 656），
   面板虽能滚，但一打开看不到按钮就像坏了。压到 18vh，让动作行留在首屏。 */
#artistList{display:flex;flex-direction:column;gap:6px;max-height:18vh;overflow:auto;color:#8b929b;font-size:11px}
.ar{border:1px solid #2f333a;border-radius:9px;padding:6px 8px;background:#20242b}
.ar-h{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ar-n{font-size:12px;color:#e6e9ef;word-break:break-all}
.ar-t{font-size:10px;color:#fff;border-radius:5px;padding:1px 5px;white-space:nowrap}
.ar-m{font-size:11px;color:#8b929b;margin-top:2px}
.ar-b{display:flex;gap:6px;flex-wrap:wrap;margin-top:5px}
.ar-b button{padding:5px 10px;font-size:11.5px;background:#0a7d4f}
`

  /** 导出当前清单：收藏模式导出账本里的全量收藏（posts:pixiv:fav:<uid>），
   *  普通模式导出「上次枚举」缓存。先另存为，浏览器不支持就写进所选目录。 */
  async function exportEnumerated() {
    try {
      const isFav = sourceOf() === 'fav'
      const raw = ($('#creator') && $('#creator').value) || ''
      // 按模式挑解析器：pixiv 的 uid 是纯数字，用 parseCreator 会认错键（拆成另一套键名）
      const id = isFav || S.site === 'pixiv' ? parsePixivUid(raw) : parseCreator(raw)
      // 收藏导出的是「这个 uid 的全部收藏」：枚举完就整份存了一条，
      // 分组管线写的 fav:<uid>:<画师uid> 是碎片，不能拿来当全量。
      const favUid = isFav ? id || S.favUid || '' : ''
      const cached = isFav
        ? favUid
          ? lsGet('posts:pixiv:fav:' + favUid, null)
          : null
        : lsGet('ffdl:posts:' + (S.site === 'pixiv' ? 'pixiv:' : '') + id, null)
      // 缓存是「截断前」的全量；没有缓存才退回本轮列表（本轮可能被「最多篇数」截过）
      const list = Array.isArray(cached) && cached.length ? cached : S.posts
      if (!Array.isArray(list) || !list.length) {
        throw new Error(
          isFav ? '还没有收藏清单：在收藏模式点一次「开始下载」或「预检」，枚举完会把整份清单存下来' : '还没有可导出的清单：先点一次预检或开始',
        )
      }
      const data = JSON.stringify(
        list.map((p) => ({
          id: p.id,
          kind: p.kind || '',
          title: p.title || '',
          userId: p.userId || '',
          userName: p.userName || (p.user && p.user.name) || '',
          date: p.date || p.publishedDatetime || '',
          fee: p.fee != null ? p.fee : p.feeRequired == null ? null : p.feeRequired,
        })),
        null,
        1,
      )
      const name = isFav
        ? `pixiv_收藏_${favUid || 'me'}_${list.length}篇.json`
        : `${S.site === 'pixiv' ? 'pixiv' : 'fanbox'}_枚举_${id || 'creator'}_${list.length}篇.json`
      // 0.2.3：油猴沙箱里直接调 showSaveFilePicker 会甩
      //   Failed to execute 'showSaveFilePicker' on 'Window': Illegal invocation
      // （真机实测）。必须从 unsafeWindow 上取真身来调；再不行就退回写进所选目录，
      // 别让「导出清单」在手机上变成一条必然失败的按钮。
      const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window
      const ssfp = W && typeof W.showSaveFilePicker === 'function' ? W.showSaveFilePicker.bind(W) : null
      let saved = false
      if (ssfp) {
        try {
          const h = await ssfp({ suggestedName: name, types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }] })
          const w = await h.createWritable()
          try {
            await w.write(new Blob([data]))
            await w.close()
          } catch (e) {
            try {
              await w.abort()
            } catch (e2) {
              /* 已结束，忽略 */
            }
            throw e
          }
          log('已导出清单到：' + h.name)
          saved = true
        } catch (e) {
          if (e && e.name === 'AbortError') return
          log('! 「另存为」不可用（' + ((e && e.message) || e) + '），改写到所选目录')
        }
      }
      if (!saved) {
        if (!S.parent) throw new Error('这个浏览器不支持「另存为」，且还没选保存目录')
        await writeText(S.parent, name, data)
        log('已导出清单到所选目录：' + name)
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return
      log('导出清单失败：' + ((e && e.message) || e))
    }
  }

  /** 导入清单：只把 id 灌进 S.importedPosts，落盘仍旧走现成的逐篇下载循环
   *  （不另写一套写盘逻辑，否则收藏/导入/画师三条路以后要各修各的）。 */
  async function importEnumerated(file) {
    try {
      // 收藏模式没有「一份清单 = 一个目录」这回事（按画师分组各下各的），先拦下再挑文件
      if (sourceOf() === 'fav') throw new Error('收藏模式不支持导入清单：收藏是按画师分组分别下的，没有对应目录')
      const arr = JSON.parse(await file.text())
      if (!Array.isArray(arr) || !arr.length) throw new Error('不是有效的清单 JSON（应为非空数组）')
      const raw = ($('#creator') && $('#creator').value) || ''
      const id = S.site === 'pixiv' ? parsePixivUid(raw) : parseCreator(raw)
      // 导入文件里的 JSON 常常没有 user 字段（文件夹里的 _投稿列表.json 就不带）：
      // 缺了它总文件夹名会静默从「画师名」退化成 creatorId，等于另起一个目录把同一批重下一遍。
      // 所以从这份枚举自己的缓存里把 user 补回来（与扩展版导入同一条修法）。
      const cachedP = id ? lsGet('ffdl:posts:' + (S.site === 'pixiv' ? 'pixiv:' : '') + id, []) : []
      const cachedUser = (Array.isArray(cachedP) && cachedP[0] && cachedP[0].user) || null
      const seen = new Set()
      let badId = 0
      const list = []
      for (const p of arr) {
        const rawId = String((p && (p.id || p.post_id)) || '')
        // 清洗只能「拒绝」不能「改写」：把 "12.345" 删成 "12345" 会静默下成另一篇
        const cleaned = rawId.replace(/[^A-Za-z0-9_-]/g, '')
        if (!cleaned || cleaned !== rawId) {
          badId++
          continue
        }
        if (seen.has(cleaned)) continue // 同一 id 重复出现会跑两遍
        seen.add(cleaned)
        list.push({
          id: cleaned,
          title: (p && p.title) || '',
          kind: p && p.kind === 'novel' ? 'novel' : 'illust',
          date: (p && (p.date || p.publishedDatetime)) || '',
          fee: p ? (p.fee != null ? p.fee : p.feeRequired) : null,
          user: (p && p.user) || cachedUser,
        })
      }
      if (!list.length) throw new Error('JSON 里没有可用的作品/投稿 id')
      if (badId) log(`! 有 ${badId} 条的 id 含非法字符，已跳过`)
      S.importedPosts = list
      S.importedFor = { site: S.site, creator: id || '' } // 记下这份清单是谁的：换了站点/画师就作废
      log(`已导入清单：${list.length} 篇（${file.name}），点「开始下载」就会用这份清单`)
    } catch (e) {
      log('导入清单失败：' + ((e && e.message) || e))
    }
  }

  function buildUI() {
    uiRoot = document.createElement('div')
    uiRoot.id = 'ffdl-fab'
    uiRoot.style.cssText = 'all:initial'
    shadow = uiRoot.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = CSS
    shadow.appendChild(style)

    const fab = document.createElement('div')
    fab.id = 'fab'
    fab.textContent = '📁'
    fab.title = 'Fanbox/Pixiv 文件夹下载器（油猴版 ' + VERSION + '）'
    shadow.appendChild(fab)

    const panel = document.createElement('div')
    panel.id = 'panel'
    panel.innerHTML = `
      <div class="hd">
        <b>文件夹下载器</b><span class="badge" id="siteBadge">${SITE === 'pixiv' ? 'PIXIV' : 'FANBOX'}</span>
        <span class="sp"></span><span class="x" id="close">✕</span>
      </div>
      <label class="row"><span>画师</span><input type="text" id="creator" placeholder="${SITE === 'pixiv' ? 'uid 或 /users/<uid> 链接' : 'creatorId 或主页链接'}"></label>
      <label class="row"><span>来源</span>
        <select id="optSource">
          <option value="artist">某位画师</option>
          <option value="fav">我的收藏</option>
        </select></label>
      <label class="row" id="favLayoutRow" style="display:none"><span>收藏结构</span>
        <select id="optFavLayout">
          <option value="flat">平铺（每个作品一个文件夹）</option>
          <option value="group">分组（按画师分层）</option>
        </select></label>
      <div id="srcHint">来源：某位画师</div>
      <label class="row"><span>总文件夹</span><input type="text" id="optArtistFolder" placeholder="留空＝用画师名"></label>
      <label class="row"><span>间隔ms</span><input type="number" id="optInterval" value="300" min="0" step="50">
        <span>并发</span><input type="number" id="optConcurrency" value="1" min="1" max="3"></label>
      <label class="row"><span>最多</span><input type="number" id="optLimit" value="0" min="0">
        <span title="单位 MB，0＝不限。只对接口给了大小的附件生效；超限的文件不下、该篇也不记完成">上限MB</span><input type="number" id="optMaxMB" value="0" min="0" step="10"></label>
      <div class="chks">
        <label><input type="checkbox" id="optSkip" checked title="整篇级：关掉后会逐篇重新核对，但已下好的文件仍按字节跳过、不会重下">跳过已存在</label>
        <label><input type="checkbox" id="optFiles" ${SITE === 'pixiv' ? '' : 'checked'}>附件/压缩包</label>
        <label><input type="checkbox" id="optCover">封面</label>
        <label><input type="checkbox" id="optText" checked>正文/信息txt</label>
        <label><input type="checkbox" id="optUseCache" checked>用上次枚举</label>
      </div>
      <div class="btns">
        <button id="pick">选择文件夹</button><span id="dirName">未选</span>
      </div>
      <div class="btns">
        <button id="exportPosts">导出清单</button>
        <button id="importPosts">导入清单</button>
      </div>
      <div class="arw">
        <div class="arh">这个目录里的画师 <span id="scanCount">0</span><span class="sp"></span><button id="rescan">重扫</button></div>
        <div id="artistList">选好目录后自动识别：站点 / 进度 / 体积</div>
      </div>
      <div class="btns act">
        <button id="start">开始下载</button>
        <button id="precheck">预检</button>
        <button id="pause" disabled>暂停</button>
        <button id="stop" disabled>停止</button>
        <button id="single" style="background:#4a4e55">下载本篇</button>
      </div>
      <div id="bar"><div id="barFill"></div></div>
      <div id="stats">待机</div>
      <input type="file" id="importFile" accept=".json,application/json" style="display:none">
      <div id="log"></div>
    `
    shadow.appendChild(panel)

    const open = () => panel.classList.add('on')
    const close = () => panel.classList.remove('on')
    fab.addEventListener('click', (e) => {
      e.stopPropagation()
      panel.classList.contains('on') ? close() : open()
    })
    shadow.getElementById('close').addEventListener('click', (e) => {
      e.stopPropagation()
      close()
    })

    // 预填本页识别结果
    const info = detectPage()
    const cIn = shadow.getElementById('creator')
    const saved = lsGet('ffdl:form:' + SITE, null)
    if (saved && typeof saved === 'object') {
      if (typeof saved.creator === 'string' && saved.creator) cIn.value = saved.creator
      const setV = (id, v) => {
        const el = shadow.getElementById(id)
        if (el && v !== undefined && v !== null) el.value = String(v)
      }
      const setC = (id, v) => {
        const el = shadow.getElementById(id)
        if (el && typeof v === 'boolean') el.checked = v
      }
      setV('optArtistFolder', saved.folder)
      setV('optInterval', saved.interval)
      setV('optConcurrency', saved.concurrency)
      setV('optLimit', saved.limit)
      setV('optMaxMB', saved.maxMB)
      setV('optSource', saved.source)
      setV('optFavLayout', saved.favLayout)
      setC('optSkip', saved.skip)
      setC('optFiles', saved.files)
      setC('optCover', saved.cover)
      setC('optText', saved.text)
      setC('optUseCache', saved.useCache)
    }
    if (!cIn.value && info.creatorId) cIn.value = info.creatorId
    // 上次若是「我的收藏」，恢复出来的站点/徽标/提示必须当场对齐（默认是页面自己的站点）
    syncSource()

    const saveForm = () => {
      lsSet('ffdl:form:' + SITE, {
        creator: shadow.getElementById('creator').value,
        folder: shadow.getElementById('optArtistFolder').value,
        interval: shadow.getElementById('optInterval').value,
        concurrency: shadow.getElementById('optConcurrency').value,
        limit: shadow.getElementById('optLimit').value,
        maxMB: shadow.getElementById('optMaxMB').value,
        source: shadow.getElementById('optSource').value,
        favLayout: shadow.getElementById('optFavLayout').value,
        skip: shadow.getElementById('optSkip').checked,
        files: shadow.getElementById('optFiles').checked,
        cover: shadow.getElementById('optCover').checked,
        text: shadow.getElementById('optText').checked,
        useCache: shadow.getElementById('optUseCache').checked,
      })
    }
    shadow.addEventListener('change', saveForm)

    // 来源/收藏结构：改了就同步站点与提示；运行中不许改（跑到一半换站点 = 用另一套接口）
    shadow.getElementById('optSource').addEventListener('change', (e) => {
      e.stopPropagation()
      if (S.running) {
        log('运行中不能换来源，请先点「停止」')
        e.target.value = S.source === 'fav' ? 'fav' : 'artist'
        return
      }
      syncSource()
      log(S.source === 'fav' ? '来源：我的收藏（站点已切到 pixiv）' : `来源：某位画师（站点 ${siteTag(S.site)}）`)
    })
    shadow.getElementById('optFavLayout').addEventListener('change', () => {
      syncSource()
      log('收藏结构：' + (S.favLayout === 'group' ? '分组（先按画师分一层，件数多的组在前）' : '平铺（每个作品一个文件夹）'))
    })

    shadow.getElementById('exportPosts').addEventListener('click', (e) => {
      e.stopPropagation()
      exportEnumerated()
    })
    shadow.getElementById('importPosts').addEventListener('click', (e) => {
      e.stopPropagation()
      // 禁用态下浏览器不会派发 click，这里再兜一次：真点了也要有话说，不许静默失败
      if (sourceOf() === 'fav') {
        log('收藏模式不支持导入清单：收藏是按画师分组分别下的，没有对应目录')
        return
      }
      shadow.getElementById('importFile').click()
    })
    shadow.getElementById('importFile').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0]
      e.target.value = '' // 同一个文件改完再选一次也要能触发 change
      if (f) importEnumerated(f)
    })

    shadow.getElementById('pick').addEventListener('click', async (e) => {
      e.stopPropagation()
      if (S.running) {
        log('运行中不能换目录，请先点「停止」')
        return
      }
      try {
        await pickFolder()
      } catch (err) {
        if (err && err.name === 'AbortError') return
        log('! 选目录失败：' + ((err && err.message) || err))
      }
    })
    shadow.getElementById('rescan').addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!S.parent) {
        log('先点一次「选择文件夹」')
        return
      }
      try {
        const p = await S.parent.queryPermission({ mode: 'readwrite' })
        if (p !== 'granted') {
          log('! 需要重新授权：再点一次「选择文件夹」并允许修改文件')
          return
        }
        await scanArtists()
      } catch (err) {
        log('! 重扫失败：' + ((err && err.message) || err))
      }
    })
    const stopEv = (ev) => ev.stopPropagation()
    ;['touchstart', 'touchend', 'pointerdown', 'mousedown'].forEach((n) => panel.addEventListener(n, stopEv, { passive: true }))

    shadow.getElementById('start').addEventListener('click', (e) => {
      e.stopPropagation()
      saveForm()
      doRun('run')
    })
    shadow.getElementById('precheck').addEventListener('click', (e) => {
      e.stopPropagation()
      saveForm()
      doRun('precheck')
    })
    shadow.getElementById('pause').addEventListener('click', (e) => {
      e.stopPropagation()
      S.paused = !S.paused
      e.target.textContent = S.paused ? '继续' : '暂停'
      log(S.paused ? '已暂停（点「继续」恢复）' : '已继续')
    })
    shadow.getElementById('stop').addEventListener('click', (e) => {
      e.stopPropagation()
      S.stopFlag = true
      const n = abortAllInflight()
      log('收到停止请求…' + (n ? `（已掐断 ${n} 个在途请求）` : ''))
    })
    shadow.getElementById('single').addEventListener('click', (e) => {
      e.stopPropagation()
      const info2 = detectPage()
      if (!info2.postId) {
        log('当前页面认不出作品/投稿 ID')
        return
      }
      S.singlePostId = info2.postId
      S.singlePostKind = info2.kind || ''
      const cIn2 = shadow.getElementById('creator')
      if (info2.creatorId) cIn2.value = info2.creatorId
      saveForm()
      log('单篇模式：' + info2.postId)
      doRun('run').finally(() => {
        S.singlePostId = ''
        S.singlePostKind = ''
      })
    })

    document.documentElement.appendChild(uiRoot)
    log('油猴版 v' + VERSION + ' 就绪（' + SITE + '）')
  }

  /** 页面重新加载后把上次选的目录句柄捞回来（句柄存在 IndexedDB 里，可跨会话保存；
   *  权限是否还是 granted 由浏览器决定，缺了就在点「开始」时补一次授权弹窗） */
  async function restoreParent() {
    try {
      const h = await idbGet('parent')
      if (!h || typeof h.queryPermission !== 'function') return
      S.parent = h
      const p = await h.queryPermission({ mode: 'readwrite' })
      const el = $('#dirName')
      if (el) el.textContent = h.name + (p === 'granted' ? '' : '（需重新授权）')
      log('恢复上次目录：' + h.name + '（权限 ' + p + '）')
      // 权限还在就直接扫，否则等用户再点一次「选择文件夹」
      if (p === 'granted') await scanArtists()
    } catch (e) {
      /* 拿不回来就让用户重新选 */
    }
  }

  buildUI()
  restoreParent()

  /* ================= 自检（纯函数单元测试，供 CDP 调用） ================= */

  function selfTest() {
    const res = []
    const chk = (name, got, want) => res.push({ name, ok: got === want, got, want })
    const enc = (arr) => new Uint8Array(arr)
    const jpgOk = enc([0, 1, 2, 0xff, 0xd9, 0xff, 0xd9])
    const jpgBad = enc([0, 1, 2, 3, 4, 5, 6, 7])
    chk('jpg 尾 FFD9', tailCheckBytes('a.jpg', jpgOk).ok, true)
    chk('jpg 截断', tailCheckBytes('a.jpg', jpgBad).ok, false)
    const pngOk = enc([0, 1, 2, 3, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
    const pngBad = enc([0, 1, 2, 3, 0x49, 0x45, 0x4e, 0x00, 0xae, 0x42, 0x60, 0x82])
    chk('png 尾 IEND', tailCheckBytes('a.png', pngOk).ok, true)
    chk('png 截断', tailCheckBytes('a.png', pngBad).ok, false)
    chk('gif 尾 3B', tailCheckBytes('a.gif', enc([0, 0, 0, 0x3b])).ok, true)
    chk('gif 截断', tailCheckBytes('a.gif', enc([0, 0, 0, 0x00])).ok, false)
    const eocd = []
    for (let i = 0; i < 22; i++) eocd.push(0)
    eocd[0] = 0x50
    eocd[1] = 0x4b
    eocd[2] = 0x05
    eocd[3] = 0x06
    chk('zip 无注释', tailCheckBytes('a.zip', enc(eocd)).ok, true)
    const eocdC = eocd.slice()
    eocdC[20] = 8
    for (let i = 0; i < 8; i++) eocdC.push(0x41)
    chk('zip 带 8B 注释', tailCheckBytes('a.zip', enc(eocdC)).ok, true)
    const eocdBad = eocd.slice()
    eocdBad[20] = 40
    chk('zip 注释长度不符', tailCheckBytes('a.zip', enc(eocdBad)).ok, false)
    chk('zip 无 EOCD', tailCheckBytes('a.zip', enc([1, 2, 3, 4, 5, 6, 7, 8])).ok, false)
    chk('psd 放行', tailCheckBytes('a.psd', enc([1, 2, 3, 4, 5])).ok, true)
    chk('psd 无尾标', tailVerifiable('a.psd'), false)
    chk('zip 有尾标', tailVerifiable('a.zip'), true)
    chk('sanitize 控制符', sanitize('a\u200Db\u0007c'), 'a b c')
    chk('sanitize 非法字符', sanitize('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j')
    chk('sanitize 空', sanitize('  ...  '), '无题')
    chk(
      'folderNameOf',
      folderNameOf({ id: 123, title: '试 作', publishedDatetime: '2026-11-15T22:33:46+09:00' }),
      '20261115-123-试 作',
    )
    chk('fileDisplayName 图片', fileDisplayName({ kind: 'image', ext: 'png' }, 0), '001.png')
    chk('fileDisplayName 附件补扩展名', fileDisplayName({ kind: 'file', ext: 'zip', name: '原稿 v1.2' }, 2), '003_原稿 v1.2.zip')
    chk('fileDisplayName 附件已有扩展名', fileDisplayName({ kind: 'file', ext: 'zip', name: '设定集.zip' }, 0), '001_设定集.zip')
    chk('htmlToText', htmlToText('<p>a<br>b</p><p>c</p>'), 'a\nb\n\nc')
    const post = pixivWorkToPost({ id: 7, title: 'T', createDate: '2026/11/15 22:33:46', tags: { tags: [{ tag: 'x' }] }, userName: 'U' })
    chk('pixivWorkToPost 日期', post.publishedDatetime, '2026-11-15T22:33:46+09:00')
    chk('pixivWorkToPost 标签', post.tags.join(','), 'x')
    chk('pixivFileName 动图', pixivFileName({ kind: 'ugoira_zip', seq: '001', ext: 'zip' }), '001_ugoira.zip')
    const files = collectFiles(
      { body: { images: [{ originalUrl: 'https://a/1.png', extension: 'png' }], files: [{ url: 'https://a/x.zip', extension: 'zip', name: 'p' }] } },
      { files: true },
    )
    chk('collectFiles 计数', files.length, 2)
    chk('collectFiles 附件名', files[1].name, 'p')
    // ---- v0.1.4：站点后缀与清单反推 ----
    chk('folderNameFor fanbox', folderNameFor('某画师', 'fanbox'), '某画师 (FANBOX)')
    chk('folderNameFor pixiv', folderNameFor('某画师B', 'pixiv'), '某画师B (PIXIV)')
    chk('folderNameFor 长名不切后缀', / \(FANBOX\)$/.test(folderNameFor('あ'.repeat(80), 'fanbox')), true)
    chk('stripSiteSuffix fanbox', stripSiteSuffix('某画师 (FANBOX)'), '某画师')
    chk('stripSiteSuffix 无后缀', stripSiteSuffix('某画师'), '某画师')
    chk('stripSiteSuffix 小写', stripSiteSuffix('name (pixiv)'), 'name')
    // ---- v0.1.8：完成证据与跳过闸门（原 doneFromManifest 只看"清单里出现过文件夹"，会误判） ----
    chk('optsFlags', JSON.stringify(optsFlags({ files: true, cover: false, text: true })), '{"files":1,"cover":0,"text":1}')
    chk('optsCovers 超集可跳', optsCovers({ files: 1, cover: 1, text: 1 }, { files: 0, cover: 0, text: 1 }), true)
    chk('optsCovers 少附件不可跳', optsCovers({ files: 0, cover: 0, text: 1 }, { files: 1, cover: 0, text: 1 }), false)
    chk('optsCovers 少封面不可跳', optsCovers({ files: 0, cover: 0, text: 1 }, { files: 0, cover: 1, text: 1 }), false)
    chk('optsText', optsText({ files: 1, cover: 0, text: 1 }), '图片+附件+正文')
    const bakIdx = S.index
    const bakDisk = S.diskFolders
    try {
      S.diskFolders = new Set(['20261115-1-试 作'])
      chk('diskHasPost 按全名命中', diskHasPost({ id: 1, title: '试 作', publishedDatetime: '2026-11-15T22:33:46+09:00' }), true)
      chk('diskHasPost 不在磁盘上', diskHasPost({ id: 2, title: '别的', publishedDatetime: '2026-11-15T22:33:46+09:00' }), false)
      // pixiv 枚举只有 id（没有标题）也要能认出来
      chk('diskHasPost 只有 id 也能认（pixiv）', diskHasPost({ id: 1, kind: 'illust' }), true)
    } finally {
      S.index = bakIdx
      S.diskFolders = bakDisk
    }
    const bad = res.filter((r) => !r.ok)
    return { total: res.length, pass: res.length - bad.length, fail: bad.length, bad, all: res }
  }

  const TEST = {
    version: VERSION,
    site: SITE,
    state: S,
    logLines: () => S.logLines.slice(),
    selfTest,
    tailCheckBytes,
    tailCheck,
    tailVerifiable,
    fileComplete,
    sanitize,
    htmlToText,
    collectFiles,
    folderNameOf,
    fileDisplayName,
    buildInfoText,
    pixivWorkToPost,
    pixivInfoText,
    pixivFileName,
    apiFanbox,
    pageFetchJson,
    scanArtists,
    renderArtists,
    useArtist,
    resolveArtistDir,
    readSiteOf,
    writeSiteFile,
    folderNameFor,
    stripSiteSuffix,
    siteTag,
    optsFlags,
    optsCovers,
    optsText,
    readDonePosts,
    writeDonePosts,
    applyManifestInference,
    loadDiskFolders,
    diskHasPost,
    shouldSkipPost,
    sniffSite,
    scanned: () => S.scanned.slice(),
    gmJson,
    PL,
    downloadToFile,
    downloadToFileRetry,
    writeText,
    readManifest,
    loadIndex,
    writeIndex,
    pickFolder,
    doRun,
    stop: () => {
      S.stopFlag = true
      abortAllInflight()
    },
    pause: (v) => {
      S.paused = !!v
    },
    setCreator: (v) => {
      const el = shadow && shadow.getElementById('creator')
      if (el) el.value = v
    },
    setOpt: (id, v) => {
      const el = shadow && shadow.getElementById(id)
      if (!el) return false
      if (el.type === 'checkbox') el.checked = !!v
      else el.value = String(v)
      return true
    },
    getOpt: (id) => {
      const el = shadow && shadow.getElementById(id)
      return el ? (el.type === 'checkbox' ? el.checked : el.value) : null
    },
    stats: () => JSON.parse(JSON.stringify(S.stats)),
    failed: () => S.failed.slice(),
    indexSize: () => S.index.size,
    writeBuffer,
    fileOk,
    getSize,
    restoreParent,
    queryPerm: async () => (S.parent ? await S.parent.queryPermission({ mode: 'readwrite' }) : 'none'),
    parentName: () => (S.parent ? S.parent.name : null),
    artDirName: () => (S.artistDir ? S.artistDir.name : null),
    getDir: async (folder) => (S.artistDir ? await S.artistDir.getDirectoryHandle(folder) : null),
    listDir: async (dir) => {
      const out = []
      for await (const [n, h] of dir.entries()) out.push({ name: n, kind: h.kind })
      return out.sort((a, b) => a.name.localeCompare(b.name))
    },
    readFile: async (dir, name) => {
      const f = await (await dir.getFileHandle(name)).getFile()
      return { size: f.size, head: await f.slice(0, 32).text() }
    },
    openPanel: () => shadow && shadow.getElementById('panel').classList.add('on'),
    closePanel: () => shadow && shadow.getElementById('panel').classList.remove('on'),
  }
  try {
    const W = typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window
    W.__FFDL = TEST
  } catch (e) {
    try {
      window.__FFDL = TEST
    } catch (e2) {
      /* 忽略 */
    }
  }
})()

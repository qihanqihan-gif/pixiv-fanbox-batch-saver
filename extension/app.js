/* 画师文件夹下载器 · 工作台（0.3.34 起由「Fanbox 文件夹下载器」改名，功能不变）
 * 设计要点（为什么不是直接改原插件的下载层）：
 *   安卓 Chromium 的 chrome.downloads 只保留文件名最后一段，不建子文件夹，
 *   所以这里改用 File System Access API（showDirectoryPicker）自己写文件，
 *   路径 = 所选目录/画师名/投稿文件夹/文件。
 *   API 只能从 fanbox 页面域发起（扩展域直连会 400），故通过 content.js 代理。
 */
'use strict'

const $ = (s) => document.querySelector(s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 间隔加抖动（B31）：等距的请求节奏本身就是"这是脚本"的特征，±30% 抖动足够打散；
 *  0 表示不限速（用户自己选的），照旧立刻走。 */
function jit(ms) {
  const base = Math.max(0, Number(ms) || 0)
  if (!base) return 0
  return Math.round(base * (0.7 + Math.random() * 0.6))
}
const pad = (n, w = 3) => String(n).padStart(w, '0')

const S = {
  parent: null, // 用户选的父目录
  artistDir: null, // 画师总文件夹
  running: false,
  paused: false,
  stopFlag: false,
  tabId: null,
  creatorId: '',
  stats: { postsTotal: 0, postsDone: 0, filesDone: 0, skip: 0, skipPosts: 0, fail: 0, bytes: 0 },
  records: [], // 本轮新增/覆盖的记录
  failed: [], // 本轮失败的文件（跑完集中补一轮，并落成 _失败清单.json）
  index: new Map(), // 上一轮清单：key=文件夹|文件名 → record
  logLines: [],
  dlCtrls: new Set(), // 正在下载的 AbortController 集合（支持并发多文件），停止时全部打断
  wakeLock: null, // 屏幕常亮锁
  audioCtx: null, // 保活音频（让浏览器认为在放媒体，降低被冻结/Doze 断网概率）
  keepAliveTimer: null, // 每 30s 给代理页续保活的定时器
  progSig: '', // 本轮进度签名（目录 + 选项），换目录后旧进度不认
  totalFolder: '',
  done: {}, // 已下完的投稿标记：{ postId: 1 }，用于“投稿级”断点续传
  posts: [], // 本轮（或缓存）的投稿列表
  importedPosts: null, // 手工导入的枚举 JSON（一次性使用）
  importedFor: null, // 上面那份清单是给「哪个站点 + 哪个画师」导入的 { site, creator }
  singlePostId: '', // 单篇模式：只下这一篇（从投稿页按钮进来的）
  singlePostKind: '', // 单篇的类型提示：'novel' 或空。pixiv 的小说 id 和插画 id 是两条独立序列，
  //                     同一个数字两边都存在 → 不能靠"取插画失败再试小说"来猜，必须由页面告诉我们
  site: 'fanbox', // 目标站点：fanbox / pixiv
  scanned: [], // 选完目录后扫描出来的画师文件夹（画师卡片）
  scanning: false,
  presetArtist: null, // 从画师卡片点「继续这一位」带过来的 { folder, creatorId, site }
  verified: {}, // 本轮真正“整篇跑完”的篇：{ postId: 1 }，落进 _完成篇.jsonl 当证据
  optsCur: null, // 本轮的选项快照（写进 _进度.json，用于判断“清单是在什么选项下写的”）
  diskFolders: null, // 画师目录下现存的投稿文件夹名集合（跳过闸门要确认文件真的还在）
  diskFoldersDir: null, // 上面那个集合是哪个目录扫的（换目录要重扫）
  rangeResume: true, // B41：断流后保留半截、下次用 Range 续传
  parts: {}, // _半截.json 的内存副本：{ 文件名: { exp: 应有字节, got: 已有字节, ts } }
  partsLoaded: false,
  partsDir: null, // 上面那份台账属于哪个目录（换画师目录要重读）
  partsSaveTimer: null, // 台账攒批落盘的定时器
}

/* ---------------- 基础工具 ---------------- */

function log(msg) {
  const t = new Date().toTimeString().slice(0, 8)
  S.logLines.push(`[${t}] ${msg}`)
  if (S.logLines.length > 400) S.logLines.splice(0, S.logLines.length - 400)
  // 每写一行就整块重排 <pre> + 强制同步布局，千篇级要重写两万次、白等几百秒。
  // 合并到一次 setTimeout 里刷（不用 rAF：页面在后台时 rAF 不跑，日志就不动了）
  if (!S._logDirty) {
    S._logDirty = true
    setTimeout(flushLog, 200)
  }
}

function flushLog() {
  S._logDirty = false
  const el = $('#log')
  if (!el) return
  // 0.3.34：只在用户本来就贴着底部时才自动跟随。以前无条件滚到底，
  // 上翻看旧日志时每来一行就被拽回去，根本读不完。
  const nearBottom = el.scrollHeight - el.scrollTop - (el.clientHeight || 0) < 48
  el.textContent = S.logLines.join('\n')
  if (nearBottom) el.scrollTop = el.scrollHeight
  const lb = $('#logBrief')
  if (lb) lb.textContent = S.logLines.length + ' 行'
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'
  return (n / 1073741824).toFixed(2) + ' GB'
}

/** 文件/文件夹名清洗：去掉非法字符、控制字符、首尾点，限制长度 */
function sanitize(s, max = 60) {
  let out = String(s == null ? '' : s)
    // 控制符（Cc）+ 格式符（Cf：ZWJ/ZWNJ/BOM/方向覆盖等）。
    // 实测：标题里带 U+200D 会让 getDirectoryHandle 直接抛
    // 「TypeError: Name is not allowed.」——Chromium 的 FSA 自己就会拒，跟文件系统无关。
    // 但变体选择符 U+FE0F（Mn 类）是合法的，不能一起删。
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
  // slice 可能把 emoji 的代理对切成半个，切掉孤立的高位代理
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1)
  out = out.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  return out || '无题'
}

function guessExt(url) {
  const m = String(url).match(/\.([a-z0-9]{2,5})(?:\?|$)/i)
  return m ? m[1].toLowerCase() : 'bin'
}

/** 从输入解析 pixiv uid（纯数字 / /users/<uid> 链接）。pixiv 的 uid 是数字，与 fanbox 的 creatorId 不是一套。 */
function parsePixivUid(input) {
  const s = String(input || '').trim()
  if (!s) return ''
  if (/^\d+$/.test(s)) return s
  const m = s.match(/pixiv\.net\/(?:[a-z]{2}\/)?users\/(\d+)/i)
  if (m) return m[1]
  return ''
}

/** 从输入解析 creatorId */
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

/* ---------------- 本机缓存（枚举列表 / 投稿进度） ---------------- */

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

/* ---------------- IndexedDB：记住上次选的目录 ---------------- */

function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('fanbox-folder-dl', 1)
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

/* ---------------- 目录选择与写盘 ---------------- */

async function pickFolder() {
  if (typeof showDirectoryPicker !== 'function') {
    throw new Error('此浏览器不支持目录选择（File System Access API 不可用）')
  }
  const h = await showDirectoryPicker({ id: 'fanbox-folder-dl', mode: 'readwrite' })
  S.parent = h
  // 换了根目录，上一张卡片记下的「续跑这个文件夹」就不作数了（那个文件夹在新目录里未必存在）
  S.presetArtist = null
  await idbSet('parent', h)
  $('#dirName').textContent = '已选：' + h.name
  log('保存目录：' + h.name)
  // 选完就扫：里面有哪些画师、各自下了多少，免得用户还得自己填 creatorId 才不会重下
  await scanArtists()
}

async function ensurePermission() {
  if (!S.parent) throw new Error('请先选择保存文件夹')
  let p = await S.parent.queryPermission({ mode: 'readwrite' })
  if (p === 'granted') return
  // 权限弹窗只能在页面前台弹出来；后台时 requestPermission 会一直悬着，必须提前拦掉
  if (document.visibilityState !== 'visible') {
    throw new Error('授权弹窗需要页面在前台：请切回工作台页面再点「开始下载」')
  }
  p = await Promise.race([
    S.parent.requestPermission({ mode: 'readwrite' }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('等待授权超时 30 秒，请重试并在弹窗里点「允许」')), 30000)),
  ])
  if (p !== 'granted') throw new Error('没有目录写入权限')
}

async function writeBuffer(dir, name, buf) {
  // B36：这三步都可能永远不返回（B23/B33 都见过 SAF 桥接层偶发不返回），
  // 而它承载的是清单/索引/进度/投稿信息——一旦挂住，整轮会“看着还在跑、其实什么都没记”。
  const fh = await withTimeout(dir.getFileHandle(name, { create: true }), tmo('handle'), '建文件 ' + name)
  const w = await withTimeout(fh.createWritable(), tmo('handle'), '开可写流 ' + name)
  try {
    await withTimeout(w.write(new Blob([buf])), tmo('write'), '写盘 ' + name)
    await withTimeout(w.close(), tmo('close'), '关闭 ' + name)
  } catch (e) {
    // 不 abort 的话这条流会一直锁着文件，之后每次 createWritable 都会失败 →
    // 清单/索引/进度/投稿信息 txt 整轮静默停更（本轮审计发现的坑）
    try {
      await withTimeout(w.abort(), tmo('handle'), 'abort ' + name)
    } catch (e2) {
      /* 已经结束，忽略 */
    }
    throw e
  }
}

async function writeText(dir, name, text) {
  await writeBuffer(dir, name, new TextEncoder().encode(text))
}

/* ---------------- B41：Range 续传的半截文件台账 ----------------
 * 痛点：一篇 200 MB 的 zip 下到 190 MB 断网，旧逻辑只能整篇重下。收藏这种千篇级批量，
 *       一条链路半天抖一次，等于白下几 GB。
 * 为什么不能「看到盘上有半截就直接接着下」：fileOk() 的唯一判据是 size>0，
 *       半截文件会被当成完整文件永久跳过（B27/B36 就是靠「失败就 truncate(0)」堵这个洞的）。
 * 所以台账是续传的**前提**：
 *   ① 失败时不清空，但把 { 文件名: { exp: 应有字节, got: 已有字节 } } 写进 _半截.json；
 *   ② 只有台账里登记过的文件才允许续传（进程被杀/断电留下的半截仍按老逻辑重下）；
 *   ③ fileOk() 见到台账条目直接判「不完整」，续传成功后把条目销掉。
 * 期望字节未知时一律不留（不知道总长就没法判「下完了没有」）。 */
const PART_FILE = '_半截.json'
async function loadParts(dir) {
  if (S.partsLoaded && S.partsDir === dir) return S.parts
  S.parts = {}
  try {
    // B36 类坑：SAF 的 getFileHandle 会偶发永不返回。这里如果裸 await，
    // 每个文件下载前的这一步就能把整轮静默挂死（真机上踩过一次，比下载本身更隐蔽）。
    const j = JSON.parse(
      await withTimeout(
        (async () => (await dir.getFileHandle(PART_FILE)).getFile().then((f) => f.text()))(),
        tmo('handle'),
        '读 ' + PART_FILE,
      ),
    )
    if (j && typeof j === 'object' && !Array.isArray(j)) S.parts = j
  } catch (e) {
    /* 没有台账文件（或读超时）：当空台账，正常 */
  }
  S.partsDir = dir
  S.partsLoaded = true
  return S.parts
}
async function saveParts(dir) {
  if (S.partsSaveTimer) {
    clearTimeout(S.partsSaveTimer)
    S.partsSaveTimer = null
  }
  try {
    await writeText(dir, PART_FILE, JSON.stringify(S.parts))
  } catch (e) {
    log('! 写 _半截.json 失败：' + ((e && e.message) || e))
  }
}
function scheduleSaveParts(dir) {
  // 断网时几十个文件会一起失败，逐条落盘会把 SAF 和日志都压满 → 攒 3 秒写一次
  if (S.partsSaveTimer) clearTimeout(S.partsSaveTimer)
  S.partsSaveTimer = setTimeout(() => {
    S.partsSaveTimer = null
    saveParts(dir).catch(() => {})
  }, 3000)
}
async function partSet(dir, name, exp, got) {
  await loadParts(dir)
  S.parts[name] = { exp: Number(exp) || 0, got: Number(got) || 0, ts: Date.now() }
  scheduleSaveParts(dir)
}
async function partClear(dir, name) {
  await loadParts(dir)
  if (S.parts[name]) {
    delete S.parts[name]
    await saveParts(dir)
  }
}

async function fileOk(dir, name, expectBytes) {
  try {
    // B41：台账登记过的半截文件永远不算完成（哪怕 size>0，甚至尾标碰巧对得上）
    if (S.rangeResume && (await loadParts(dir))[name]) return false
    const fh = await withTimeout(dir.getFileHandle(name), tmo('handle'), '查文件 ' + name)
    const f = await withTimeout(fh.getFile(), tmo('handle'), '读属性 ' + name)
    if (f.size <= 0) return false
    // 有上一轮记录的字节数时，比它小就是半截文件（崩溃/断流留下），重下
    if (expectBytes && f.size < expectBytes) return false
    return true
  } catch (e) {
    return false
  }
}

async function getSize(dir, name) {
  try {
    const f = await withTimeout(
      (async () => (await dir.getFileHandle(name)).getFile())(),
      tmo('handle'),
      '量大小 ' + name,
    )
    return f.size
  } catch (e) {
    return 0
  }
}

/** 用「格式终止符」判断文件是否真的下完。
 *  downloads.fanbox.cc 不返回 Content-Length（实测 content-length=0），所以字节数比对没用；
 *  而连接“干净结束”也可能少字节。JPEG 必须以 FFD9 结尾、PNG 必须以 IEND 结尾，
 *  这两个判据实测能准确抓出被截断的文件（真机上靠它定位过 3 张坏图）。
 *  其它格式（zip/psd/mp4…）没有统一终止符，只能放行，靠下一轮重下兜底。 */
async function tailOk(dir, name) {
  try {
    const f = await (await dir.getFileHandle(name)).getFile()
    if (f.size < 4) return false
    const m = name.match(/\.([A-Za-z0-9]{1,5})$/)
    const ext = m ? m[1].toLowerCase() : ''
    if (ext === 'jpeg' || ext === 'jpg') {
      const b = new Uint8Array(await f.slice(f.size - 2).arrayBuffer())
      return b[0] === 0xff && b[1] === 0xd9
    }
    if (ext === 'png') {
      if (f.size < 8) return false
      const b = new Uint8Array(await f.slice(f.size - 8).arrayBuffer())
      const sig = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]
      for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) return false
      return true
    }
    if (ext === 'gif') {
      const b = new Uint8Array(await f.slice(f.size - 1).arrayBuffer())
      return b[0] === 0x3b
    }
    if (ext === 'zip') {
      // zip 以 EOCD（PK\x05\x06）结尾，后面可能跟最多 64KB 的注释。
      // 光找魔数会误判（压缩数据里也可能出现这 4 个字节），必须再校验
      // 「EOCD 起点 + 22 + 注释长度 === 文件末尾」。pixiv 的动图 zip 实测有 Content-Length。
      const tailLen = Math.min(f.size, 66000)
      const b = new Uint8Array(await f.slice(f.size - tailLen).arrayBuffer())
      const u16 = (o) => b[o] | (b[o + 1] << 8)
      for (let i = b.length - 22; i >= 0; i--) {
        if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) {
          const cmt = u16(i + 20)
          if (i + 22 + cmt === b.length) return true
        }
      }
      return false
    }
    return true
  } catch (e) {
    return false
  }
}

/** 这个扩展名有没有可靠的「文件末尾标记」可以验完整性。
 *  jpg/png/gif/zip 有；psd/psb/mp4/pdf/webp 之类没有统一尾标。
 *  分这一刀是为了解决一个真窟窿：进程被杀留下的半截 .psd，清单里没有字节数记录，
 *  tailOk 又对未知格式一路放行 → 会被当成「已下完」永久跳过。 */
function tailVerifiable(name) {
  const m = String(name).match(/\.([A-Za-z0-9]{1,5})$/)
  const ext = m ? m[1].toLowerCase() : ''
  return ext === 'jpg' || ext === 'jpeg' || ext === 'png' || ext === 'gif' || ext === 'zip'
}

/** 判定「磁盘上这个文件是不是真的完整」。
 *  expect>0（清单里有字节数记录）→ 只比大小（调用方已用 fileOk 比过，这里直接放行）
 *  expect=0（清单里没这条：首轮 / 清单损坏 / 收尾前被打断）→ 只能靠格式尾标；
 *            没有尾标的格式无法确认，宁可重下一次，也不能把半截文件当完成品永久留着。 */
async function fileComplete(dir, name, expect) {
  if (Number(expect) > 0) return true
  if (!tailVerifiable(name)) {
    log('  · ' + name + ' 存在但无法校验完整性（该格式没有尾标），重下一次')
    return false
  }
  return await tailOk(dir, name)
}

/* ---------------- 站点标记：画师文件夹怎么命名、怎么认 ---------------- */

/** 新文件夹的站点后缀。半角括号 + 前面一个空格：Windows / 安卓 / 分享给他人电脑都不会出问题 */
const SITE_SUFFIX = { fanbox: ' (FANBOX)', pixiv: ' (PIXIV)' }

function siteTag(site) {
  return site === 'pixiv' ? 'PIXIV' : 'FANBOX'
}

/** 新画师文件夹该叫什么：名字本体先截断，后缀在截断之后再拼，
 *  否则长画师名会把「(FANBOX)」本身切掉，反而看不出站点 */
function folderNameFor(artistName, site) {
  const suf = SITE_SUFFIX[site === 'pixiv' ? 'pixiv' : 'fanbox']
  return sanitize(artistName || '', Math.max(8, 60 - suf.length)) + suf
}

/** 去掉站点后缀（老的「纯名字」文件夹与新的「名字 (站点)」要能对上） */
function stripSiteSuffix(name) {
  return String(name || '')
    .replace(/\s*\((?:FANBOX|PIXIV)\)\s*$/i, '')
    .trim()
}

/** 认一个画师文件夹是哪个站的：_站点.json → _进度.json.site → 名字后缀，三选一 */
async function readSiteOf(dir) {
  const out = { site: '', creatorId: '', creatorName: '' }
  try {
    const j = JSON.parse(await (await dir.getFileHandle('_站点.json')).getFile().then((f) => f.text()))
    if (j && (j.site === 'fanbox' || j.site === 'pixiv')) out.site = j.site
    if (j && j.creatorId) out.creatorId = String(j.creatorId)
    if (j && j.creatorName) out.creatorName = String(j.creatorName)
  } catch (e) {
    /* 没有标记文件：老文件夹 */
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

/** 往画师文件夹里写站点标记（老文件夹只补这一个文件，绝不改名） */
async function writeSiteFile(dir, creatorId, creatorName) {
  try {
    await writeText(
      dir,
      '_站点.json',
      JSON.stringify(
        {
          site: S.site,
          creatorId: creatorId || '',
          creatorName: creatorName || stripSiteSuffix(dir.name),
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

/** 老文件夹没有 _站点.json 时，从内容反推它属于哪个站（清单里的 url 域名是最硬的证据）。
 *  证据优先于假设：盲写标记会把另一个站的老目录永久标错，而程序里没有撤销路径。 */
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
    if (Array.isArray(j)) {
      // pixiv 线的 _投稿列表.json 带 kind（novel/illust），fanbox 线恒为空串
      if (j.some((x) => x && (x.kind === 'novel' || x.kind === 'illust'))) return 'pixiv'
    }
  } catch (e) {
    /* 没投稿列表 */
  }
  return ''
}

/** 解析该画师的落盘文件夹。
 *  规则（兼容三种形态，避免「改了命名规则就把已下的几百篇另起一个目录重下一遍」）：
 *   ① 先看老的「纯名字」文件夹：存在且站点为空或与本次相同 → 沿用，只补写 _站点.json；
 *   ② 再看新的「名字 (站点)」：存在且站点相符 → 直接用；
 *   ③ 都不行 → 新建「名字 (站点)」。 */
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
      continue // 不存在
    }
    const info = await readSiteOf(d)
    if (info.site && info.site !== S.site) {
      log(`! 「${name}」已标记为 ${siteTag(info.site)}，与本次 ${siteTag(S.site)} 不同，跳过它`)
      continue
    }
    if (!info.site) {
      // 老文件夹没有标记：先嗅一下内容属于哪个站，别盲写
      const sniffed = await sniffSite(d)
      if (sniffed && sniffed !== S.site) {
        log(`! 「${name}」里的清单是 ${siteTag(sniffed)} 的内容，与本次 ${siteTag(S.site)} 不符，跳过它`)
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

/* ---------------- 选完目录就扫描：里面有哪些画师、各自进度 ---------------- */

/** 扫描父目录下的画师文件夹。
 *  默认只读两个小文件（_站点.json / _进度.json），毫秒级；
 *  老的 _进度.json 没有 bytes 字段时才去数一遍 _清单.jsonl（一次性的）。 */
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
      // 文件数 / 体积一律以清单为准：_进度.json 里的 files/bytes 可能是老版本写的「本轮统计」，
      // 单篇模式跑过之后会变成 1，照抄会显示成「4 篇已完成 · 1 个文件」（真机踩到过）
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
        // 没有清单（空文件夹 / 首轮）：退回 _进度.json 的记录
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
    // 单篇模式跑过之后 _进度.json 里的 total 可能只有 1，而 donePosts 是累计的 →
    // 直接显示「3/1 篇」像 bug，这种情况退化成「3 篇已完成」
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
    // 跨站的卡片不给「继续这一位」：当前站点和这个文件夹的站点不同，
    // 按下去会把文件写进另一个站的画师文件夹，还会把它的 _站点.json 覆盖成错的站点
    const crossSite = !!it.site && it.site !== S.site
    if (it.creatorId && !crossSite) {
      const b = document.createElement('button')
      b.className = 'btn mini'
      b.textContent = '继续这一位'
      b.addEventListener('click', (ev) => {
        ev.stopPropagation()
        useArtist(it)
      })
      btns.appendChild(b)
    }
    if (!it.site) {
      const b2 = document.createElement('button')
      b2.className = 'btn mini ghost'
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

/** 点「继续这一位」：把站点/画师/文件夹一次填好，点开始就续跑，不重下已有文件 */
function useArtist(it) {
  if (S.running) {
    log('正在下载，先点「停止」再换目标')
    return
  }
  S.site = it.site || S.site
  S.presetArtist = { folder: it.folder, creatorId: it.creatorId, site: S.site }
  $('#creator').value = it.creatorId
  saveForm()
  const info = $('#creatorInfo')
  if (info) info.textContent = `[${siteTag(S.site)}] ${it.folder}：点开始就续跑这个文件夹（已有文件不会重下）`
  log(`已选中「${it.folder}」：[${siteTag(S.site)}] ${it.creatorId}`)
}

/* ---------------- 后台保活 ---------------- */

/** 静音“媒体播放”：浏览器把正在放音频的页面排除在冻结/定时器节流之外，也能减少 Doze 断网 */
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
    gain.gain.value = 0.0001 // 不是 0，避免被判定为“无输出”而优化掉
    osc.frequency.value = 220
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    S.audioCtx = ctx
    // 新建的 AudioContext 在“没有用户手势”时会是 suspended：不出声、也不算在放媒体，
    // 保活等于没做。到调用这里时用户手势窗口多半已过，必须主动 resume（content.js 里是这么做的）。
    ctx.resume().catch(() => {})
  } catch (e) {
    /* 忽略 */
  }
}

/** 请求屏幕常亮（页面不可见时浏览器会自动释放） */
async function keepScreenOn() {
  try {
    if (S.wakeLock || !navigator.wakeLock) return
    const l = await navigator.wakeLock.request('screen')
    S.wakeLock = l
    l.addEventListener('release', () => {
      S.wakeLock = null
    })
  } catch (e) {
    /* 用户拒绝或系统不支持 */
  }
}

/** 让 fanbox 代理页也进入保活状态（它被冻结的话 API 就断了） */
function keepFanboxTabAlive() {
  if (!S.tabId) return
  try {
    chrome.tabs.sendMessage(S.tabId, { type: 'keepalive' }).catch(() => {})
  } catch (e) {
    /* 忽略 */
  }
}

/** 收尾：松开亮屏锁、停掉保活音频与定时器 */
function stopKeepAlive() {
  try {
    if (S.keepAliveTimer) clearInterval(S.keepAliveTimer)
  } catch (e) {
    /* 忽略 */
  }
  S.keepAliveTimer = null
  try {
    if (S.audioCtx) S.audioCtx.close()
  } catch (e) {
    /* 忽略 */
  }
  S.audioCtx = null
  try {
    if (S.wakeLock) S.wakeLock.release()
  } catch (e) {
    /* 忽略 */
  }
  S.wakeLock = null
}


/** 给代理页发一条 keepalive 当探针，能回就说明内容脚本活着（顺带完成保活） */
async function probeTab(tabId) {
  try {
    await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'keepalive' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('probe-timeout')), 1200)),
    ])
    return true
  } catch (e) {
    return false
  }
}

async function ensureTab() {
  if (!S.tabId) {
    const r = await chrome.runtime.sendMessage({
      type: 'ensure-fanbox-tab',
      creatorId: S.creatorId,
    })
    if (!r || !r.ok || !r.tabId) throw new Error('无法打开 fanbox 标签页')
    S.tabId = r.tabId
  }
  // 探针：扩展被重载/更新后，**已经开着的** fanbox 页里没有新的内容脚本，消息必然失败，
  // 而且只有让页面重新导航一次才会重新注入。所以探不通就先 reload 它一次（实测这一步是必须的）。
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 6; i++) {
      if (await probeTab(S.tabId)) return S.tabId
      await sleep(800)
    }
    if (round > 0) break
    log('代理页无响应，重新加载它（扩展重载后旧页面里没有内容脚本）')
    try {
      await chrome.tabs.reload(S.tabId)
    } catch (e) {
      // 标签页已经被关掉了：向后台要一个新的再试
      S.tabId = null
      const r = await chrome.runtime.sendMessage({ type: 'ensure-fanbox-tab', creatorId: S.creatorId })
      if (r && r.ok && r.tabId) S.tabId = r.tabId
      if (!S.tabId) throw new Error('无法打开 fanbox 标签页')
      continue
    }
    await sleep(2500)
  }
  log('! 代理页内容脚本仍未就绪（约 12 秒），继续尝试发请求')
  return S.tabId
}

/** 经 fanbox 页面域代理调用 API */
// 代理链路彻底坏掉时，每篇一次 api() 最多要空转 5×(12s+20s)，1000 篇能爬到天亮。
// 连续失败到阈值就直接收工，把原因顶到日志上。
let apiFailStreak = 0
const API_FAIL_LIMIT = 12

async function api(path) {
  const url = /^https?:/.test(path) ? path : 'https://api.fanbox.cc/' + path
  let lastErr = null
  let gotHttp = false
  for (let i = 0; i < 5; i++) {
    try {
      const tabId = await ensureTab()
      // 代理页被冻结时 sendMessage 不会 reject（消息排队等解冻），必须自己加超时
      const r = await Promise.race([
        chrome.tabs.sendMessage(tabId, { type: 'fapi', url }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('代理页无响应（可能被后台冻结）')), 20000)),
      ])
      if (r && r.ok) {
        apiFailStreak = 0
        return r.data
      }
      lastErr = new Error((r && r.error) || 'API 返回空')
      if (/HTTP \d\d\d/.test(lastErr.message)) gotHttp = true
      // 403/404 是确定性结果（没买 / 已删 / 登录态失效），重试 5 次只是每篇白等 18 秒
      if (/HTTP 4\d\d/.test(lastErr.message)) break
    } catch (e) {
      lastErr = e // SW 唤醒失败 / 内容脚本未就绪 / 标签页已关
    }
    S.tabId = null
    await sleep(1500)
  }
  // 能拿到 HTTP 状态码（哪怕是 4xx）说明代理链路是通的，不算“链路故障”
  if (gotHttp) apiFailStreak = 0
  else if (++apiFailStreak >= API_FAIL_LIMIT) {
    S.stopFlag = true
    throw new Error(
      '连续 ' + apiFailStreak + ' 次代理调用失败，已自动停止；检查 fanbox 标签页是否还在、是否还登录着',
    )
  }
  throw new Error('API 失败：' + url + '（' + (lastErr && lastErr.message) + '）')
}

/** 扩展域直接流式下载并写盘（fetch + FileSystemWritableFileStream，带卡死检测） */
/** 目录句柄还活着吗。
 *  安卓上 SAF → FSA 的桥接层会在**目录其实还在**的情况下偶发 `NotFoundError`
 *  （"A requested file or directory could not be found at the time an operation was processed"），
 *  同一目录前几个文件刚写成功也会中招（B23）。所以拿到这类错误先探一次活，
 *  活着就按"单文件失败"处理（交给重试/失败清单），别整轮停机。 */
async function dirAlive(dir) {
  try {
    if (!dir || typeof dir.entries !== 'function') return true // 判不了就当活着（宁可重试，不要误停）
    const it = dir.entries()
    if (!it || typeof it.next !== 'function') return true
    await it.next()
    return true
  } catch (e) {
    return false
  }
}

/** 兜底量长度（B27）：只在响应没给 content-length 时才调，用 HEAD 再问一次。
 *  实测 fanbox CDN 的 GET 和 HEAD 都带 content-length，所以正常情况下这条路一次都不会走；
 *  一旦走了，说明链路变了，值得多花这一个请求换到字节级判据。失败就返回 0（退化成只验格式尾标）。 */
async function headLength(url) {
  try {
    // B36：这条以前是裸 fetch。链路半死时它会永远不返回，而它恰好是“没给长度”时每个文件的必经之路。
    const r = await withTimeout(
      fetch(url, { method: 'HEAD', credentials: 'include' }),
      tmo('head'),
      'HEAD 量长度',
    )
    if (!r || !r.ok) return 0
    return Number(r.headers.get('content-length') || 0) || 0
  } catch (e) {
    return 0
  }
}

/** 统计计数（B27）：S.stats 只在 runStart 里重建，单测/单文件路径下可能没有这个键，
 *  直接 `S.stats.x++` 会得到 NaN。统一走这里，缺就补 0。 */
function bump(k, n = 1) {
  if (!S.stats || typeof S.stats !== 'object') S.stats = {}
  const cur = Number(S.stats[k])
  S.stats[k] = (Number.isFinite(cur) ? cur : 0) + n
}

/* ---------------- B36：给“可能永远不返回”的步骤套超时 ----------------
 * 真机实测（2026-11-17）：链路把响应体掐掉但不断连时，fetch 头能拿到 200、body 永远读不完；
 * 这种时候 content-length 恰好是空的，于是每个文件都会走 headLength() 再补一次 HEAD ——
 * 那条是裸 fetch，没有超时，整轮会静默挂死：界面仍显示“运行中”，日志停在上一行，
 * 磁盘上留下一堆 0 字节文件，失败数还是 0。SAF 桥接层的 getFileHandle/createWritable/
 * write/close 同理（B23/B33 都见过偶发不返回）。
 * 所以：任何一步都不允许无限等待，超时一律转成普通失败（可重试、可计数、可进 _失败清单）。
 */
const TMO_DEFAULT = { handle: 15000, write: 60000, close: 60000, tail: 20000, head: 15000 }
function tmo(key) {
  const v = S.tmo && Number(S.tmo[key])
  return Number.isFinite(v) && v > 0 ? v : TMO_DEFAULT[key]
}
function withTimeout(p, ms, tag) {
  let timer = null
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('超时 ' + Math.round(ms / 1000) + ' 秒：' + tag)), ms)
  })
  return Promise.race([
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(timer)
        return v
      },
      (e) => {
        clearTimeout(timer)
        throw e
      },
    ),
    guard,
  ])
}

async function downloadToFile(dir, name, url) {
  const ctrl = new AbortController()
  S.dlCtrls.add(ctrl)
  const startedAt = Date.now()
  let lastTick = Date.now()
  // 两道闸：
  //  ① 45 秒没有新数据 → abort（网络半死）
  //  ② 单个文件 10 分钟绝对上限 → abort（大文件正常但极慢时也该收工，否则整轮无限期挂着）
  const timer = setInterval(() => {
    const now = Date.now()
    if (now - lastTick > 45000 || now - startedAt > 600000) ctrl.abort()
  }, 5000)
  let fh = null
  let w = null
  let reader = null
  let startAt = 0 // 续传起点：盘上已有、且台账登记过的字节数
  let got = 0 // 本次请求收到的字节
  let knownTotal = 0 // 整个文件应有的字节（0 = 不知道）
  let resumed = false
  try {
    // B41：只有台账登记过的半截才续传（未登记的一律按老逻辑从头下）
    if (S.rangeResume) {
      const rec = (await loadParts(dir))[name]
      if (rec) {
        let have = 0
        try {
          // 量不到（SAF 抽风/超时）就当没有半截，走常规下载，绝不会因此卡住
          have = await withTimeout(getSize(dir, name), tmo('handle'), '量半截 ' + name)
        } catch (e2) {
          have = 0
        }
        const exp = Number(rec.exp) || 0
        if (have > 0 && exp > have) {
          startAt = have
          knownTotal = exp
        } else if (have > 0 && exp > 0 && have >= exp) {
          await partClear(dir, name) // 上次刚写完就中断（close 了但没销账）：交给尾校验
        }
      }
    }
    const resp = await fetch(url, {
      credentials: 'include',
      signal: ctrl.signal,
      headers: startAt > 0 ? { Range: 'bytes=' + startAt + '-' } : undefined,
    })
    if (startAt > 0) {
      if (resp.status === 206) {
        const cr = String(resp.headers.get('content-range') || '')
        const m = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i)
        if (m && Number(m[1]) === startAt) {
          resumed = true
          if (m[3] !== '*') knownTotal = Number(m[3]) || knownTotal
        } else {
          log(`  · ${name} 服务器回的 Content-Range 对不上（${cr || '空'}），从头下`)
          startAt = 0
        }
      } else {
        // fanbox 的 downloads.* 实测不吃 Range（照样 200 全量），这种就老实从头下
        log(`  · ${name} 服务器不支持续传（HTTP ${resp.status}），从头下`)
        startAt = 0
      }
    }
    if (!resp.ok) throw new Error('HTTP ' + resp.status)
    if (!resp.body) throw new Error('无响应体')
    const cl0 = Number(resp.headers.get('content-length') || 0)
    // 206 的 content-length 只是「剩余长度」，总长要加上起点
    if (cl0) knownTotal = Math.max(knownTotal, resumed ? startAt + cl0 : cl0)
    reader = resp.body.getReader()
    for (;;) {
      // 关键：reader.read() 可能**永远不返回**（连接半死、代理掐流）。
      // 只靠 setInterval + ctrl.abort() 还不够：页面被节流时定时器本身会延迟，
      // 实测出现过「45 秒看门狗没生效、日志停在下载前、进度 0」的整轮挂死。
      // 这里给每次读取单独套一个超时，保证一定会走到 catch 里记失败。
      const idleMs = 60000
      let idleTimer = null
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise((_, rej) => {
          idleTimer = setTimeout(() => rej(new Error('读取超时：' + Math.round(idleMs / 1000) + ' 秒没收到数据')), idleMs)
        }),
      ]).finally(() => {
        // 每次读块都建一个定时器、又从不清理 → 大文件会攒下成百上千个悬挂定时器
        if (idleTimer) clearTimeout(idleTimer)
      })
      if (done) break
      if (S.stopFlag) throw new Error('已停止')
      // 拿到第一块数据才创建/截断目标文件：连接失败不会毁掉已存在的完整文件
      if (!w) {
        fh = await withTimeout(dir.getFileHandle(name, { create: true }), tmo('handle'), '建文件 ' + name)
        // B41：续传必须 keepExistingData，否则一开流就把盘上那 190 MB 抹掉
        w = await withTimeout(
          resumed ? fh.createWritable({ keepExistingData: true }) : fh.createWritable(),
          tmo('handle'),
          '开可写流 ' + name,
        )
        if (resumed) {
          bump('resumed')
          log(`  ↺ ${name} 从 ${fmtBytes(startAt)} 接着下${knownTotal ? '（共 ' + fmtBytes(knownTotal) + '）' : ''}`)
        }
      }
      lastTick = Date.now()
      // 续传要用定位写：keepExistingData 的流，普通 write 是从 0 开始覆盖的
      await withTimeout(
        resumed ? w.write({ type: 'write', position: startAt + got, data: value }) : w.write(value),
        tmo('write'),
        '写盘 ' + name,
      )
      // 写完之后再记一次：极慢存储上单次 write 超过 45s 会被看门狗误判成卡死
      lastTick = Date.now()
      got += value.byteLength
    }
    if (!w) throw new Error('响应为空（0 字节）')
    const total = startAt + got
    // 服务器给了长度就校验一次：连接的“干净结束”也可能是被中间设备截断的
    // B27：没有 Content-Length 时先记数（这是**指标**，不是错误）——实测 fanbox CDN 的 GET/HEAD
    // 都带 content-length，一旦这个数不为 0，说明链路变了（代理改写 / 换了 CDN / 被劫持），要立刻知道。
    if (!knownTotal) {
      bump('lenMissing')
      const hl = await headLength(url)
      if (hl) {
        bump('lenFromHead')
        knownTotal = hl
      }
    }
    if (knownTotal && total !== knownTotal) throw new Error('字节数不符 ' + total + '/' + knownTotal)
    // 续传时流里可能还留着起点之后的旧尾巴，收尾显式截到实际长度
    if (resumed) await withTimeout(w.truncate(total), tmo('write'), '截断到实际长度 ' + name)
    await withTimeout(w.close(), tmo('close'), '关闭文件 ' + name)
    await partClear(dir, name) // 完整落盘了，把这笔台账销掉
    // 关掉之后再验一次格式终止符：没 Content-Length 时这是唯一能识破“干净截断”的办法
    if (!(await withTimeout(tailOk(dir, name), tmo('tail'), '尾校验 ' + name)))
      throw new Error('文件末尾校验失败（可能被截断）')
    // 两样都没有（既没长度、格式又没法尾校验，比如 mp4）→ 这个文件其实**无法验证完整性**。
    // 不能拦（否则永远下不完），但必须计数并汇报：这是"看着成功、实际可能半截"的唯一来源。
    if (!knownTotal && !tailVerifiable(name)) {
      bump('unverifiable')
      log(`! 无法校验完整性（服务器没给长度，${name} 也没有可校验的格式尾标）`)
    }
    clearInterval(timer)
    S.dlCtrls.delete(ctrl)
    return total
  } catch (e) {
    clearInterval(timer)
    S.dlCtrls.delete(ctrl)
    // 出错/停止时不取消 reader，连接会一直挂着；千篇级抖动会攒下大量半开连接
    try {
      if (reader) await reader.cancel()
    } catch (e2) {
      /* 忽略 */
    }
    // 这些错误后面每一篇都会必然重现，继续跑只会在“必然失败的重试”上空转几小时：
    //   目录权限失效/目录被移走（NotAllowed/NotFound）、存储写满（QuotaExceeded）、
    //   文件名被系统拒绝（TypeError: ... Name is not allowed.）
    const eName = e && e.name
    const badName = eName === 'TypeError' && /not allowed/i.test(String((e && e.message) || ''))
    // NotAllowed/NotFound 先别急着判死刑：SAF 桥接层会在目录还在的时候偶发 NotFoundError（B23）。
    // 探一次活，活着就只算这个文件失败（重试几轮后进 _失败清单.json，整轮继续）。
    let dirGone = false
    if (eName === 'NotAllowedError' || eName === 'NotFoundError') {
      dirGone = !(await dirAlive(dir))
      if (!dirGone) log(`! 写「${name}」时报 ${eName}，但目录还在 → 按单文件失败重试（不停整轮）`)
    }
    if (dirGone || eName === 'QuotaExceededError' || badName) {
      e.isFatal = true
      S.stopFlag = true
      if (dirGone) log('! 目录权限失效或目录已被移走，已自动停止；重新选一次文件夹再继续')
      if (eName === 'QuotaExceededError') log('! 存储空间不足，已自动停止；清出空间后点开始会续跑')
      if (badName) log('! 文件名被系统拒绝（' + name + '），已自动停止')
    }
    // B41：这次失败要不要把已下的字节留下？只在这四种条件全满足时留：
    //   开了续传 / 不是致命错误 / 真的收到过数据 / 知道整个文件多长（否则没法判「下完了没有」）
    const keep = S.rangeResume && !e.isFatal && w && startAt + got > 0 && knownTotal > startAt + got
    if (keep) {
      try {
        // close() 而不是 abort()：close 会把已写的字节提交到目标文件，
        // 这样磁盘长度和台账里的 got 对得上；abort 会丢掉整段缓冲。
        await withTimeout(w.close(), tmo('close'), '提交半截 ' + name)
      } catch (e2) {
        /* 提不交就退回清空，别留一个长度不明的文件 */
        try {
          await withTimeout(w.abort(), tmo('handle'), 'abort ' + name)
        } catch (e3) {
          /* 忽略 */
        }
      }
      await partSet(dir, name, knownTotal, startAt + got)
      log(`↻ ${name} 已下 ${fmtBytes(startAt + got)}/${fmtBytes(knownTotal)}，保留半截，下次从断点续传`)
    } else {
      try {
        // 关键：close() 只是“提交已写入的字节”，并不会截断。半截文件会被 fileOk() 当成完整文件
        // 永久留下（清单里没记录 → 下次 expect=0 → 只查 size>0），所以必须显式 truncate(0) 再关。
        // 另一个坑：走到“末尾校验失败”那条分支时 w 已经 close 过了，对已关闭的流再 truncate
        // 只会抛异常并被吞掉 → 坏文件原地留盘。必须重开一条流来清。
        if (w) {
          try {
            // B36：写盘超时的那条流，abort() 自己也可能不返回，必须带超时
            await withTimeout(w.abort(), tmo('handle'), 'abort ' + name)
          } catch (e2) {
            /* 已 close/已提交，忽略 */
          }
        }
        if (fh) {
          const w2 = await withTimeout(fh.createWritable(), tmo('handle'), '重开流清空 ' + name)
          await withTimeout(w2.truncate(0), tmo('write'), '截断 ' + name)
          await withTimeout(w2.close(), tmo('close'), '关闭清空流 ' + name)
        }
      } catch (e2) {
        log('! 清空残文件失败（' + name + '）：' + ((e2 && e2.message) || e2))
      }
      await partClear(dir, name)
    }
    throw e
  }
}

/** 带退避重试的下载（停止时不再重试） */
async function downloadToFileRetry(dir, name, url, times = 3) {
  let last = null
  for (let i = 0; i < times; i++) {
    try {
      return await downloadToFile(dir, name, url)
    } catch (e) {
      last = e
      if (S.stopFlag) break
      // B38：以前重试完全静默（只有最后一次失败才打 ✗），链路半死时界面看上去就是“卡死”。
      // 另外超时/断流类错误再重试只会把同一段时间再赔一遍，第二次之后就收手——
      // 剩下的交给收尾的「补漏轮」和 _失败清单.json，别在一篇上耗十分钟。
      const timeoutish = /超时|network error|Failed to fetch|中止|中断/i.test(String((e && e.message) || ''))
      if (timeoutish && i >= 1) {
        log(`! ${name} 连续超时/断流，停止重试，交给补漏轮（${(e && e.message) || e}）`)
        break
      }
      log(`↻ 重试 ${i + 1}/${times - 1}：${name}（${(e && e.message) || e}）`)
      await sleep(1500 * (i + 1))
    }
  }
  throw last
}

/* ---------------- 投稿解析 ---------------- */

/** 从 post.info 的 body 里收集要下载的文件 */
function collectFiles(p, opts) {
  const out = []
  const seen = new Set()
  const add = (url, ext, name, kind, size) => {
    if (!url) return
    const key = url.split('?')[0]
    if (seen.has(key)) return
    seen.add(key)
    out.push({ url, ext: (ext || guessExt(url)).replace(/^\./, ''), name: name || '', kind, size: Number(size) || 0 })
  }
  const b = p.body || {}
  for (const im of b.images || []) add(im.originalUrl, im.extension, '', 'image')
  // 老接口只给 imageMap：上面那条会拿到 0 条，而下面的守卫（bodyHasAttach）却认 imageMap，
  // 于是每篇都被判成“接口改版、可疑”、整站 0 下载。这里补上，别让两处判据互相打架。
  if (!(b.images || []).length && b.imageMap) {
    for (const k of Object.keys(b.imageMap)) {
      const im = b.imageMap[k] || {}
      add(im.originalUrl, im.extension, '', 'image')
    }
  }
  if (opts.files) for (const f of b.files || []) add(f.url, f.extension, f.name || '', 'file', f.size)
  if (opts.cover && p.coverImage) add(p.coverImage.originalUrl, p.coverImage.extension, '', 'cover')
  // 兜底：视频/音频等其它带 url 的附件
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

/** 「单文件上限」过滤（B30）。
 *  为什么需要：盘装不下时只能先要图、把上百 MB 的特典包留到下一轮。
 *  只对**接口给了大小**的文件生效（附件 zip/mp4 带 size；图片接口不给 size，一律不拦）——
 *  绝不能为了判断大小去 HEAD 每个图片，那是拿请求量换一个没必要的判断。
 *  返回 { keep, skipped }，skipped 里的文件本轮不下。
 *  ⚠️ 关键：**有文件被这里跳过的篇，绝不能记完成**。否则下一轮放开上限时，
 *  该篇已被 _完成篇.jsonl 判为「跑完过」，超限的大文件就永远补不下来——B01/B02 的翻版。 */
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

function postDate(p) {
  const s = String(p.publishedDatetime || p.updatedDatetime || '')
  // 优先用字符串里的日期部分，避免跨时区把 00:30 的投稿算到前一天
  const m = s.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/)
  if (m) return m[1] + m[2] + m[3]
  const d = new Date(s)
  if (isNaN(d.getTime())) return '00000000'
  return d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2)
}

function folderNameOf(p) {
  const title = sanitize(p.title, 52)
  return `${postDate(p)}-${p.id}-${title}`
}

/** 音视频扩展名（B33）。实测：**本机 SAF 提供方不允许创建 video/audio MIME 的文件**
 *  （`getFileHandle(name,{create:true})` 直接 NotFoundError；mp4/webm/mov/m4a/mp3/wav/mkv/avi/ts/ogv/3gp 全中，
 *  而 bin/txt/zip/jpeg/png/gif/psd/rar/7z/tmp 都能建），`move()` 也不可用，所以没法"先写后改名"。
 *  唯一可行的是用 **Chromium 不认识的扩展名** 落盘（.mp4.bin / .mp4x / .video 实测都行），数据完整、改名即可播。 */
const VID_AUDIO_EXT = /\.(mp4|webm|mov|m4a|mp3|wav|flac|mkv|avi|ts|ogv|3gp|m2ts|f4v|flv)$/i

/** 落盘用的真实文件名：音视频在"加后缀"模式下追加 .bin（可关）。
 *  注意：清单里记的就是这个名字，所以续跑/跳过都按它比对，改名后会被当成新文件重下——别手动改名。 */
function diskNameOf(name, opts) {
  const s = String(name || '')
  if (!s) return s
  const fallback = !(opts && opts.vidBin === false) // 默认开
  if (fallback && VID_AUDIO_EXT.test(s)) return s + '.bin'
  return s
}

function fileDisplayName(f, idx) {
  const n = pad(idx + 1, 3)
  if (f.kind === 'file' && f.name) {
    const base = sanitize(f.name, 48)
    const ext = String(f.ext || '')
      .replace(/^\./, '')
      .toLowerCase()
    // 只认“真的等于接口给的扩展名”的结尾。「原稿 v1.2」「设定集.v2」这种名字里也有点和字母数字，
    // 用 /\\.[A-Za-z0-9]{1,5}$/ 判断会误判成“已有扩展名”，附件就不补扩展名了（看图/解压都认不出）。
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

/* ---------------- 枚举 ---------------- */

async function enumerate(creatorId, opts) {
  log('开始枚举投稿列表…')
  const first = await api('post.paginateCreator?creatorId=' + encodeURIComponent(creatorId))
  const body = (first && first.body) || {}
  // 形状校验：登录态失效/接口改版时，这里必须是数组，否则后面会“0 篇也当成功”
  if (!Array.isArray(body.posts) && !Array.isArray(body.pageUrls)) {
    throw new Error('枚举返回异常，可能是登录态失效：' + JSON.stringify(Object.keys(body)).slice(0, 120))
  }
  const posts = Array.isArray(body.posts) ? body.posts.slice() : []
  const pageUrls = Array.isArray(body.pageUrls) ? body.pageUrls.slice() : []
  if (!posts.length && !pageUrls.length) {
    throw new Error('该画师枚举到 0 篇（检查 creatorId 是否正确、浏览器是否还登录着）')
  }
  log(`第 1 页：${posts.length} 篇；后续页 ${pageUrls.length} 个`)
  // 完整性：中途停止、或某页返回体里没有 posts 时，这份列表是残缺的。
  // 残缺表一旦写进「用上次枚举」缓存，往后每轮都在残表上续跑，缺的篇永远不出现。
  let complete = true
  for (let i = 0; i < pageUrls.length; i++) {
    if (S.stopFlag) {
      complete = false
      break
    }
    await waitIfPaused()
    const d = await api(pageUrls[i])
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
  if (!complete) log('! 本次枚举不完整（中途停止或某页异常）：结果不写入缓存，下次会重新枚举')
  // 去重 + 按发布时间倒序
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

/* ---------------- 主流程 ---------------- */

function waitIfPaused() {
  return new Promise((resolve) => {
    const tick = () => {
      // 停止时也必须放行，否则“暂停→停止”会把整轮永久挂死
      if (!S.paused || S.stopFlag) return resolve()
      setTimeout(tick, 300)
    }
    tick()
  })
}

function refreshStats() {
  const st = S.stats
  const pct = st.postsTotal ? Math.floor((st.postsDone / st.postsTotal) * 100) : 0
  $('#barFill').style.width = pct + '%'
  $('#stats').textContent =
    `进度 ${st.postsDone}/${st.postsTotal} 篇（${pct}%） · 文件 ${st.filesDone} · 跳过文件 ${st.skip} / 整篇 ${st.skipPosts} · 失败 ${st.fail} · 已写 ${fmtBytes(st.bytes)}`
}

async function handlePost(post, artistDir, opts) {
  const failAtStart = S.stats.fail
  let p = post
  try {
    const info = await api('post.info?postId=' + encodeURIComponent(post.id))
    const got = info && info.body && info.body.post
    if (got) p = got
  } catch (e) {
    S.stats.fail++
    log(`✗ 取投稿信息失败 ${post.id}：${e.message}`)
    S.failed.push({
      post_id: post.id,
      title: post.title,
      folder: '',
      file: '',
      url: '',
      kind: 'post.info',
      error: String((e && e.message) || e),
    })
    return { status: 'fail', total: 0, attempted: 0 }
  }
  if (p.isRestricted) {
    S.stats.skipPosts++
    log(`- 受限未购买，跳过：${post.id} ${sanitize(p.title, 30)}`)
    return { status: 'restricted', total: 0, attempted: 0 }
  }
  const allFiles = collectFiles(p, opts)
  // 先按「单文件上限」筛一遍（B30）：超限的文件本轮不下，但会在下面被记成"这篇没跑完"
  const capRes = applySizeCap(allFiles, opts)
  const files = capRes.keep
  let capSkip = capRes.skipped.length
  if (capSkip) {
    let capBytes = 0
    for (const f of capRes.skipped) capBytes += Number(f.size) || 0
    S.stats.capSkip += capSkip
    S.stats.capSkipBytes += capBytes
    log(`· 上限跳过 ${capSkip} 个文件（约 ${fmtBytes(capBytes)}，该篇不记完成，放开上限后会补）`)
  }
  const hasText = !!(opts.text && p.body && (p.body.text || p.body.html))
  // 接口改版的拦截点：body 里明明有**本轮本该下载的**附件字段，却一个都没解析出来 → 不写完成标记，
  // 否则一旦 FANBOX 改了 images 的结构，整站会“1000 篇全 ✓（0 个文件）”并被永久记为完成。
  // 注意必须按当前勾选判断：没勾「附件/压缩包」时，只有附件的投稿解析出 0 个文件是正常的，
  // 不能算接口改版（实测踩过这个误判）。
  // 也要用**过滤前**的 allFiles 判断：全被上限拦掉不等于接口改版（那是我们自己的选择）。
  const bodyHasAttach =
    !!(p.body && p.body.imageMap && Object.keys(p.body.imageMap).length) ||
    !!(p.body && p.body.images && p.body.images.length) ||
    !!(opts.files && p.body && p.body.files && p.body.files.length)
  if (!allFiles.length && bodyHasAttach) {
    S.stats.fail++
    log(`✗ ${post.id} 有附件字段却解析出 0 个文件（接口可能改版），不记完成`)
    S.failed.push({
      post_id: p.id,
      title: p.title,
      folder: '',
      file: '',
      url: '',
      kind: '接口改版（有附件字段但解析为 0 个文件）',
      error: 'suspect',
    })
    return { status: 'suspect', total: 0, attempted: 0 }
  }
  // 只有正文的投稿也要留下 投稿信息.txt，不能因为“没有文件”就整篇丢掉
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
    // 权限被撤 / 目录被移走：后面每一篇都会以同样方式失败，必须立刻收工，
    // 否则用户会看到“进度条跑满、失败 1000”却不知道是权限问题。
    // 但先探活：SAF 桥接层偶发的 NotFoundError 不代表目录真没了（B23）。
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
  const jobs = files.map((f, i) => {
    const orig = fileDisplayName(f, i)
    return { f, orig, name: diskNameOf(orig, opts) }
  })
  let cursor = 0
  // 并发是“多个文件同时下”，不是单文件分块——Fanbox 文件服务器不支持 Range（实测 Range 请求仍返回 200 全量），
  // 所以 IDM 那种单文件多线程在这里做不了，只能靠多文件并发吃满带宽。
  const worker = async () => {
    for (;;) {
      if (S.stopFlag) return
      await waitIfPaused()
      if (S.stopFlag) return // 暂停时点停止：放行后要再判一次，否则会白领任务
      const idx = cursor++
      if (idx >= jobs.length) return
      attempted++
      const { f, name, orig } = jobs[idx]
      // B33：音视频落盘时被加了 .bin（本机 SAF 不允许建 video/audio），第一次遇到时说清楚
      if (orig && name !== orig && !S.vidBinNoticed) {
        S.vidBinNoticed = true
        log(`! 本机 SAF 不允许创建音视频文件（mp4/mp3…），已改用「原文件名+.bin」保存：数据完整，改名去掉 .bin 即可播放`)
      }
      const old = S.index.get(folder + '|' + name)
      const expect = old && Number(old.bytes) > 0 ? Number(old.bytes) : 0
      // expect=0（清单里没这条记录：首轮/清单丢失/清单在收尾前被打断）时不能只信 size>0 ——
      // 坏文件也是 size>0，一旦被当成“已下完”就永久跳过。这种必须再验一次格式尾标。
      const sizeOk = await fileOk(dir, name, expect)
      const complete = sizeOk && (await fileComplete(dir, name, expect))
      // 文件级判据**永远**生效，和「跳过已存在」（整篇级）是两件事（B24）。
      // 以前两件事共用一个开关：关掉整篇跳过 = 连"这个文件已经下好且字节对得上"也一起关掉，
      // 于是"复查一遍"就会把几百 MB 全部重下；反过来开着整篇跳过，又会信了被污染的完成标记。
      // 想强制重下就删掉那个文件（删除比"重新下载"更明确）。
      if (complete) {
        S.stats.skip++
        // 跳过也要进清单，否则续跑后清单永久缺这一段
        S.records.push({
          post_id: p.id,
          title: p.title,
          date: p.publishedDatetime,
          fee: p.feeRequired,
          folder: folder,
          file: name,
          url: f.url,
          bytes: await getSize(dir, name),
          skipped: true,
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
        S.records.push({
          post_id: p.id,
          title: p.title,
          date: p.publishedDatetime,
          fee: p.feeRequired,
          folder: folder,
          file: name,
          url: f.url,
          bytes: bytes,
        })
      } catch (e) {
        // fatal 必须先判：downloadToFile 里已经顺手置了 stopFlag，先判 stopFlag 会把这条彻底吞掉，
        // 用户只会看到“已停止、失败 0”，永远不知道是目录权限失效
        if (e && e.isFatal) {
          S.stats.fail++
          refreshStats() // B36：失败后立刻刷新，别让状态栏一直停在“失败 0”
          log(`✗ 下载失败 ${p.id}/${name}：${e.message}`)
          log('! 目录权限失效或目录已被移走，已自动停止；重新选一次文件夹再继续')
          S.failed.push({
            post_id: p.id,
            title: p.title,
            folder: folder,
            file: name,
            url: f.url,
            kind: '致命错误（权限/空间/文件名）',
            error: String((e && e.message) || e),
          })
          S.stopFlag = true
          return
        }
        if (S.stopFlag) return // 主动停止不算失败
        S.stats.fail++
        refreshStats() // B36：以前失败不刷新，状态栏会一直显示“失败 0”，看着像没出错
        log(`✗ 下载失败 ${p.id}/${name}：${e.message}`)
        log('   ' + f.url)
        // 记下来，跑完集中补一轮；也落成 _失败清单.json 方便事后排查
        S.failed.push({
          post_id: p.id,
          title: p.title,
          date: p.publishedDatetime,
          fee: p.feeRequired,
          folder: folder,
          file: name,
          url: f.url,
          error: String((e && e.message) || e),
        })
      }
      await sleep(jit(opts.interval))
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(3, opts.concurrency || 1)) }, worker))
  if (S.stopFlag) {
    log(`⊘ ${p.id} 中断（已下 ${savedHere}/${jobs.length}，下次会补齐剩余）`)
    return { status: 'stopped', total: jobs.length, attempted }
  }
  // 有文件失败就别打 ✓ —— 断网时这里会打出「✓ xxx（1 个文件，新增 0）」，看着像成功
  const failedHere = S.stats.fail - failAtStart
  if (failedHere > 0) log(`△ ${p.id} ${sanitize(p.title, 34)}（${files.length} 个文件，新增 ${savedHere}，失败 ${failedHere}）`)
  else log(`✓ ${p.id} ${sanitize(p.title, 34)}（${files.length} 个文件，新增 ${savedHere}）`)
  return { status: 'ok', total: jobs.length, attempted, filtered: capSkip }
}

/** 读清单文件。
 *  返回 { map, bad, size }：bad 是解析失败的行数。
 *  为什么要数坏行：清单是逐行 JSON，写入被中断（断电/进程被杀）会留下**截断的末行**。
 *  以前只有「解析出 0 条」才算损坏，于是半截清单会被当成好的、_清单.bak.jsonl 永不回退，
 *  丢掉的那几行让对应文件 expect=0（最坏重下一遍）。 */
async function readManifest(name) {
  const m = new Map()
  const f = await (await S.artistDir.getFileHandle(name)).getFile()
  const txt = await f.text()
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

/** 读上一轮清单到内存（用于“半截文件”判断和续跑合并） */
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
  // 主清单被截断过时，把备份里有、主清单里缺的条目**补回来**（不覆盖已解析的部分，
  // 所以不会丢掉本轮的记录，只是把丢的那几行找回来）。
  const mainBad = main ? main.bad : 0
  let added = 0
  if (bak && bak.map.size) {
    for (const [k, v] of bak.map) {
      if (!S.index.has(k)) {
        S.index.set(k, v)
        added++
      }
    }
  }
  if (added > 0) {
    log(`! 主清单少了 ${added} 条且备份更完整，已从 _清单.bak.jsonl 补齐（合计 ${S.index.size} 条）`)
  } else if (mainBad > 0) {
    log(`! 主清单有 ${mainBad} 行解析失败（上次写入可能被中断），已跳过这些行`)
  }
}

/* ---------------- 「这一篇到底整篇跑完过没有」的落盘证据 ----------------
 * 旧做法是「_清单.jsonl 里出现过这个投稿文件夹就算下过」，实测会踩两个坑：
 *   ① 中断在半篇（5 个文件只写了 1 个）：文件夹在、清单里也有 1 条 → 判完成 → 剩下 4 个文件
 *      **永远不会**再下（不是"下次补齐"，是整篇被跳过）；
 *   ② 同一个文件夹后来勾上「附件/压缩包」再跑：签名变了、槽位是空的，但反推会把上一轮那些
 *      只下过图片的篇全标完成 → 一个附件都不下，还把错标记 saveProg 存下去（下一轮继续错）。
 * 所以另记一份 _完成篇.jsonl：只有「这一轮真的整篇跑完」的篇才写进去，并记下当时的选项；
 * 反推时还要求当时的选项**覆盖**本轮要下的东西（文件种类只增不减才算覆盖）。
 */
function optsFlags(opts) {
  return { files: opts && opts.files ? 1 : 0, cover: opts && opts.cover ? 1 : 0, text: opts && opts.text ? 1 : 0 }
}

/** have 是否覆盖 need（要下 3 类的记过，就覆盖只要 2 类的） */
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

/** 读 _完成篇.jsonl → Map(postId → { id, files, cover, text, t }) */
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
        /* 坏行跳过，不影响别的篇 */
      }
    }
  } catch (e) {
    /* 没有这份文件 = 老文件夹，正常 */
  }
  return out
}

/** 把这轮确认跑完的篇并进 _完成篇.jsonl（保留旧记录的原始选项，不覆盖成当前选项） */
async function writeDonePosts() {
  if (!S.artistDir) return
  try {
    const all = await readDonePosts(S.artistDir)
    const cur = optsFlags(S.optsCur)
    const t = new Date().toISOString()
    for (const id of Object.keys(S.verified || {})) all.set(String(id), { id: String(id), files: cur.files, cover: cur.cover, text: cur.text, t })
    if (!all.size) return // 一篇都没确认过就别建空文件
    await writeText(S.artistDir, '_完成篇.jsonl', Array.from(all.values()).map((r) => JSON.stringify(r)).join('\n'))
  } catch (e) {
    log('! 写 _完成篇.jsonl 失败：' + e.message)
  }
}

/** 从落盘证据反推篇级进度（换手机 / 重装 / 清 localStorage 之后用）。
 *  只认「跑完过」且「当时选项覆盖本轮」的篇——不够就宁可逐篇核对，也不能把没下的当下了。 */
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

/** 扫一遍画师目录里现存的投稿文件夹名（跳过闸门用它确认文件真的还在） */
async function loadDiskFolders(dir) {
  const s = new Set()
  try {
    for await (const [name, h] of dir.entries()) if (h && h.kind === 'directory') s.add(name)
  } catch (e) {
    /* 列不出来：留空集，后面靠直查兜底 */
  }
  S.diskFolders = s
  S.diskFoldersDir = dir
  return s
}

function diskHasPost(post) {
  const set = S.diskFolders
  if (!set || !set.size) return false
  // fanbox 的枚举就带标题 → 直接比文件夹全名，最准
  if (post.title) {
    try {
      if (set.has(folderNameOf(post))) return true
    } catch (e) {
      /* 名字算不出来就走下面的 id 段匹配 */
    }
  }
  // pixiv 的枚举列表只有 id（标题要取详情才知道）→ 按「YYYYMMDD-<id>-标题」里的 -id- 段认
  let re = null
  try {
    re = new RegExp('(^|-)' + String(post.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-')
  } catch (e) {
    return false
  }
  for (const n of set) if (re.test(n)) return true
  return false
}

/** 跳过闸门：有完成标记 + 磁盘上文件夹还在 + 不是单篇指名 → 才整篇跳过。
 *  只靠 localStorage 标记是不行的：用户手动删掉几篇文件夹后，那几篇会被永远跳过，
 *  日志里只剩"整篇跳过 N"，完全看不出文件已经没了。 */
async function shouldSkipPost(artistDir, post, opts) {
  if (!opts || !opts.skip || S.singlePostId) return false
  if (!post || post.id == null || !S.done[post.id]) return false
  if (!artistDir) return false
  if (!S.diskFolders || S.diskFoldersDir !== artistDir) await loadDiskFolders(artistDir)
  if (diskHasPost(post)) return true
  // 缓存里没有可能是运行途中被删/刚建，重扫一次再定
  await loadDiskFolders(artistDir)
  if (diskHasPost(post)) return true
  log(`! ${post.id} 记着已完成，但磁盘上找不到它的文件夹，重新处理`)
  delete S.done[post.id]
  return false
}

async function writeIndex() {
  if (!S.artistDir) return
  try {
    for (const r of S.records) S.index.set(r.folder + '|' + r.file, r)
    S.records = []
    const all = Array.from(S.index.values())
    // FSA 没有原子 rename，只能留一份上一版备份：写到一半被杀/断电时，下次还能从这里读回来
    try {
      const oldF = await (await S.artistDir.getFileHandle('_清单.jsonl')).getFile()
      if (oldF.size > 0) await writeText(S.artistDir, '_清单.bak.jsonl', await oldF.text())
    } catch (e) {
      /* 首次运行，没有旧清单 */
    }
    await writeText(S.artistDir, '_清单.jsonl', all.map((r) => JSON.stringify(r)).join('\n'))
    const head = 'post_id,date,fee,folder,file,bytes,url\n'
    const rows = all
      .map((r) => [r.post_id, r.date || '', r.fee == null ? '' : r.fee, r.folder, r.file, r.bytes, r.url].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    await writeText(S.artistDir, '_索引.csv', '\ufeff' + head + rows)
    log(`已写清单：${all.length} 条（_清单.jsonl / _索引.csv）`)
  } catch (e) {
    log('! 写清单失败：' + e.message)
  }
}

/* ---------------- 投稿级进度：按「目录 + 选项」签名分槽存放 ----------------
 * 存档形状：{ runs: { [签名]: { dir, done, t } } }
 * 分槽是为了让「换一份枚举 / 换个总文件夹名试跑」不会把正式那轮的完成标记冲掉。
 *
 * 历史格式兼容（实测在真机上遇到的）：
 *   v0.1.2 及更早：localStorage 里直接就是 { "<作品id>": 1, "<作品id>": 1, ... }（裸 done 表）
 *   v0.1.7       ：{ sig, dir, done }（单槽）
 *   v0.1.8       ：{ runs: {...} }（本版）
 */
const LEGACY_FLAT = '__旧版直存__'

function readProgStore(progKey) {
  let cur = null
  try {
    cur = JSON.parse(localStorage.getItem(progKey) || 'null')
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
  if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
    runs[LEGACY_FLAT] = { dir: '', done: cur, t: 0 }
  }
  return runs
}

/** 从一个进度槽位名里解析出它当时的选项。两种历史格式：
 *    JSON 签名 {"parent":…,"folder":…,"files":0,"cover":0,"text":1,"skip":1}
 *    老的分隔格式 folder|files|cover|text|skip
 *  解析不出来（例如 v0.1.2 的裸 done 表）就返回 null。 */
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

function loadProg(progKey, curSig, legacySig, folder, need) {
  const runs = readProgStore(progKey)
  // 一个槽位能不能认领：看它那一轮下过的东西，够不够本轮要的。
  // 选项**不可知**的槽位（v0.1.2 那种裸 done 表、或签名里没带选项的旧版）：
  //   本轮只要图片 → 认领（老槽位至少下过图片）；
  //   本轮要附件/封面 → **不认领**。否则那几十篇会被整篇跳过，附件永远下不到
  //   ——和 B02 同源，只是入口在进度槽而不是清单反推（B22）。
  //   不认领的代价很小：逐篇核对后已下好的图片会按清单字节数 + 尾标跳过，不会重下。
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
  // 兼容旧签名（目录|files|cover|text|skip）：保住上机跑过的老进度，不让它白丢
  if (!picked && legacySig && runs[legacySig] && canClaim(legacySig)) {
    picked = runs[legacySig]
    how = 'legacy'
  }
  if (!picked && runs[LEGACY_FLAT] && canClaim(LEGACY_FLAT)) {
    picked = runs[LEGACY_FLAT]
    how = 'flat'
  }
  // 最后一层兜底：老版本可能用了别的签名格式，只要「首段就是同一个总文件夹名」就认领，
  // 否则用户升级后那几十篇已经下好的几百 MB 会被整盘重下。宁可多提示一句也不要白重下。
  if (!picked) {
    let best = null
    const base = stripSiteSuffix(folder)
    for (const k of Object.keys(runs)) {
      if (k === LEGACY_FLAT) continue
      const head = String(k).split('|')[0]
      if (!head) continue
      // 只认「完全同名」和「老的纯名字」两种形态：
      //  加了站点后缀之后，老槽位名是「某画师」，新目录名是「某画师 (FANBOX)」，得能对上；
      //  但「某某 (PIXIV)」的槽位绝不能被 fanbox 认领，否则同名画师跨站会互相串进度。
      if (head !== folder && head !== base) continue
      const rec = runs[k]
      if (rec && rec.site && rec.site !== S.site) continue
      // 光名字对上还不够：那一轮的选项必须**覆盖**本轮要下的东西。
      // 否则「同一个文件夹、这次多勾了附件/封面」会认领上一轮只下过图片的完成标记 →
      // 整站被判完成、一个附件都不下（和清单反推那个坑同源，只是入口不同）。
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
  // progSig 要到「算完目录和选项」之后才有值；提前退出（枚举失败/预检/权限失败）时不写，
  // 否则会把上一轮的完成标记覆盖成空表
  if (!S.progSig || !S.creatorId) return
  // 注意：键必须过 siteStoreKey —— 否则 pixiv 的进度会写进 fanbox 的键里，
  // 下次读的是 prog:pixiv:<uid>，读到空表就等于每轮都从零开始（实测踩过）
  const key = 'prog:' + siteStoreKey(S.creatorId)
  const runs = readProgStore(key)
  runs[S.progSig] = { dir: S.totalFolder, done: S.done, t: Date.now(), site: S.site }
  // 只留最近 20 组，防止 localStorage 无限膨胀（按时间倒序，刚写的这组不会掉）
  const keys = Object.keys(runs).sort((a, b) => (runs[b].t || 0) - (runs[a].t || 0))
  for (const k of keys.slice(20)) delete runs[k]
  lsSet(key, { runs })
}

/** 一次运行的公共外壳：置位 UI（开始/预检禁用、暂停/停止可用） */
function beginRunUI() {
  S.paused = false
  S.stopFlag = false
  S.stats = { postsTotal: 0, postsDone: 0, filesDone: 0, skip: 0, skipPosts: 0, fail: 0, bytes: 0, capSkip: 0, capSkipBytes: 0, lenMissing: 0, lenFromHead: 0, unverifiable: 0 }
  S.records = []
  S.failed = []
  S.artistDir = null
  S.posts = []
  S.done = {}
  // 必须清空：否则预检/枚举失败这类提前退出会拿着上一轮的 progSig 去写进度
  S.progSig = ''
  S.totalFolder = ''
  S.verified = {}
  S.optsCur = null
  S.diskFolders = null
  S.diskFoldersDir = null
  S.postsAll = null
  S.enumComplete = true
  $('#start').disabled = true
  $('#precheck').disabled = true
  $('#pause').disabled = false
  $('#stop').disabled = false
  // 0.3.34：#runBrief 以前永远是「就绪」，吸顶栏等于少了一半信息
  const rb0 = $('#runBrief')
  if (rb0) rb0.textContent = '运行中'
}

/** 一次运行的公共收尾：不管正常结束、中断还是崩溃路径，都把清单和进度落一次 */
async function endRunUI() {
  stopKeepAlive()
  try {
    await writeIndex()
  } catch (e) {
    /* writeIndex 自己会记日志 */
  }
  try {
    saveProg() // progSig 为空时（预检 / 枚举失败 / 权限失败）不会写，避免冲掉上一轮进度
    if (S.artistDir && S.stats.postsTotal) {
      // 单篇模式下 S.posts 只有一篇，写进去会把「全量投稿列表」这份存档覆盖成一条
      if (!S.singlePostId && S.enumComplete !== false) {
        await writeText(
          S.artistDir,
          '_投稿列表.json',
          JSON.stringify(
            // 用 postsAll（「最多篇数」截断之前的完整表）：把截断表当全量存档，
            // 换机后按它免枚举续跑就会永久漏掉后面的篇
            (S.postsAll && S.postsAll.length ? S.postsAll : S.posts).map((p) => ({ id: p.id, title: p.title, date: p.publishedDatetime, fee: p.feeRequired, kind: p.kind || '' })),
            null,
            1,
          ),
        )
      }
      await writeText(
        S.artistDir,
        '_进度.json',
        JSON.stringify(
          (() => {
            // files / bytes 用**累计**口径（清单里所有记录的合计），不是本轮统计：
            // 否则「选目录扫描」会把一个 12 个文件的文件夹显示成「本轮才下的 2 个」
            const recs = Array.from(S.index.values())
            const sum = recs.reduce((a, r) => a + (Number(r && r.bytes) || 0), 0)
            return {
              site: S.site,
              creatorId: S.creatorId,
              folder: S.totalFolder,
              // 这份清单/完成篇是在什么选项下跑出来的：以后换了选项再加文件种类时，
              // 靠它判断「上一轮的完成标记还算不算数」（少了它就会把没下的附件当成已下）
              opts: optsFlags(S.optsCur),
              total: S.stats.postsTotal,
              donePosts: Object.keys(S.done).length,
              files: recs.length,
              bytes: sum,
              lastRun: { files: S.stats.filesDone, bytes: S.stats.bytes, fail: S.stats.fail },
              skip: S.stats.skip,
              skipPosts: S.stats.skipPosts,
              fail: S.stats.fail,
              updatedAt: new Date().toISOString(),
            }
          })(),
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
  $('#start').disabled = false
  $('#precheck').disabled = false
  $('#pause').disabled = true
  $('#stop').disabled = true
  $('#pause').textContent = '暂停'
  // 0.3.34：收尾时把吸顶栏的状态词改回来（运行中 / 已停止 / 完成有失败 / 已完成）
  const rbEnd = $('#runBrief')
  if (rbEnd) {
    const st = S.stats || {}
    rbEnd.textContent = !st.postsTotal ? '就绪' : S.stopFlag ? '已停止' : st.fail ? '完成（有失败）' : '已完成'
  }
}

/** 收藏夹按画师分组（B32，纯函数，好用例测）。
 *  输入 [{ id, kind, userId, userName }]，输出 [{ key, userId, name, works }]，件数多的在前。
 *  为什么要分组：收藏里是「很多画师各几件」，混在一个文件夹里 300 个作品文件夹看不出结构；
 *  分组后每个画师还是一个正常画师文件夹，现有的清单/进度/完成证据原样能用。 */
function groupByArtist(works) {
  const m = new Map()
  for (const w of works || []) {
    const key = String(w.userId || 'unknown')
    if (!m.has(key)) {
      const nm = String(w.userName || '').trim()
      m.set(key, { key, userId: key, name: nm ? sanitize(nm, 60) : 'uid' + key, works: [] })
    }
    m.get(key).works.push(w)
  }
  return [...m.values()].sort((a, b) => b.works.length - a.works.length)
}

/** 下载「我的收藏」（B32）。
 *  复用现成的整条 pixiv 管线：把每一组作品通过「导入枚举」通道灌进 runPixiv，
 *  用「总文件夹名」输入框钉住这一组的文件夹名 —— 这样落盘/清单/进度/完成证据
 *  **一行都不用改**，也不会出现两套并行的写盘逻辑。
 *  layout='flat'    → <下载根>/_我的收藏 (PIXIV)/<作品文件夹>/
 *  layout='group'   → <下载根>/_我的收藏 (PIXIV)/<画师名> (PIXIV)/<作品文件夹>/
 */
async function runFav(mode, uid, layout) {
  const PL = window.PixivLine
  if (!PL || !PL.getBookmarks) throw new Error('pixiv-line.js 版本过旧（没有 getBookmarks），请一起更新')
  const group = layout === 'group'
  log(`枚举收藏（uid ${uid}）：插画/漫画 + 小说…`)
  const illus = await PL.getBookmarks(uid, {
    kind: 'illust',
    onPage: (n, total) => log(`  · 收藏已读 ${n}${total ? '/' + total : ''} 条`),
  })
  const novels = await PL.getBookmarks(uid, { kind: 'novel' })
  const seen = new Set()
  let works = illus.concat(novels).filter((w) => (seen.has(w.id) ? false : (seen.add(w.id), true)))
  log(`收藏共 ${works.length} 件（插画/漫画 ${illus.length}，小说 ${novels.length}，去重后 ${works.length}）`)
  if (!works.length) throw new Error('这个 uid 没有收藏（或没登录 / uid 不对）')
  // 0.3.36：整份收藏清单存一条（posts:pixiv:fav:<uid>），「导出枚举 JSON」在收藏模式直接读它。
  // 存在「最多篇数」截断之前：和 _投稿列表.json 一样，存枚举全量，不是本轮要下的子集。
  // 键里带 fav: 前缀，不会和该 uid 作为画师时的 posts:pixiv:<uid> 撞。
  lsSet(
    'posts:pixiv:fav:' + uid,
    works.map((w) => ({ id: w.id, title: w.title || '', kind: w.kind || '', user: { name: w.userName || '' } })),
  )

  const limit = Math.max(0, Number($('#optLimit').value) || 0)
  if (limit) works = works.slice(0, limit) // 日志交给 runPixiv 打印，别重复两条
  const groups = group ? groupByArtist(works) : [{ key: 'all', userId: '', name: '_我的收藏', works }]
  if (group) log(`按画师分组：${groups.length} 位画师（${groups.slice(0, 3).map((g) => g.name + '×' + g.works.length).join('、')}${groups.length > 3 ? ' …' : ''}）`)

  const rootParent = S.parent
  const folderInput = $('#optArtistFolder')
  const oldFolderValue = folderInput ? folderInput.value : ''
  try {
    if (group) {
      // 把「下载根」临时下移一层：分组时每个画师都是一个正常的画师文件夹
      S.parent = await rootParent.getDirectoryHandle('_我的收藏 (PIXIV)', { create: true })
      log('写入位置：_我的收藏 (PIXIV)/<画师名> (PIXIV)/<作品文件夹>/')
    } else if (folderInput) {
      log('写入位置：_我的收藏 (PIXIV)/<作品文件夹>/')
    }
    for (let gi = 0; gi < groups.length; gi++) {
      if (S.stopFlag) break
      const g = groups[gi]
      if (group) log(`—— 画师 ${gi + 1}/${groups.length}：${g.name}（${g.works.length} 件）`)
      if (folderInput) folderInput.value = g.name
      const cid = 'fav:' + uid + (group ? ':' + g.userId : '')
      S.importedPosts = g.works.map((w) => ({ id: w.id, kind: w.kind }))
      S.importedFor = { site: 'pixiv', creator: cid }
      await runPixiv(mode, cid)
    }
  } finally {
    S.parent = rootParent
    if (folderInput) folderInput.value = oldFolderValue
  }
}

async function doRun(mode) {
  if (S.running) return
  S.running = true
  try {
    // beginRunUI 必须放在 try 里：它要碰 DOM，一旦抛错而 S.running 已经置真，
    // 按钮会全灰且再也点不动（只能刷新页面）
    beginRunUI()
    // B40：目录写权限必须「趁用户手势还热」就请求。
    // 真机实测：收藏模式先枚举上千件（约 1 分钟）后才 requestPermission，
    // 浏览器的 transient activation 早过期 → 必然失败「User activation is required」，
    // 用户看到的就是「枚举完了、突然中断」。所以在任何耗时操作之前先把权限拿到。
    try {
      await ensurePermission()
    } catch (e) {
      const m = String((e && e.message) || e)
      if (/user activation/i.test(m)) {
        throw new Error('目录写权限需要「刚点过按钮」才能申请：请再点一次「开始下载」（权限只需授权一次）')
      }
      throw e
    }
    const rawCreator = $('#creator') ? $('#creator').value : ''
    // B37：收藏是 pixiv 专属功能，判定只认「来源」下拉，不再依赖 S.site 当时是什么。
    // 以前这里要求 S.site==='pixiv'，而 #creator 的 input 监听器会无条件把站点改回 fanbox，
    // 于是「选了我的收藏 → 画师框留空/填 uid」必然报「画师 ID 解析失败」（真机 2026-11-17 复现）。
    // 0.3.33：判定以 S.mode 为准（同步出口），隐藏下拉只作兼容副本——
    // 真机上出现过「三段模式停在收藏、#optSource 却是 artist」的不一致，只看下拉会下错东西。
    const favSel = S.mode === 'pixiv-fav' || !!($('#optSource') && $('#optSource').value === 'fav')
    if (favSel && S.site !== 'pixiv') {
      S.site = 'pixiv'
      const b0 = $('#siteBadge')
      if (b0) {
        b0.textContent = 'PIXIV'
        b0.classList.toggle('is-px', true)
      }
      log('! 来源＝我的收藏 → 自动切到 pixiv 线')
    }
    let creatorId = S.site === 'pixiv' ? parsePixivUid(rawCreator) : parseCreator(rawCreator)
    const favSrc = favSel
    if (!creatorId && favSrc) {
      // 收藏夹没填 uid 时自己认一下（dashboard 页面里的 pixiv.user.id）
      creatorId = await window.PixivLine.getSelfUid()
      if (creatorId) log(`用当前登录账号的 uid：${creatorId}`)
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
    // 站点分叉：pixiv 的 uid 与 fanbox 的 creatorId 是两套体系，绝不能混着请求
    if (S.site === 'pixiv') {
      if (favSrc) await runFav(mode, creatorId, ($('#optFavLayout') && $('#optFavLayout').value) || 'flat')
      else await runPixiv(mode, creatorId)
    } else await runFanbox(mode, creatorId)
  } catch (e) {
    log('✗ 中断：' + (e && e.message ? e.message : e))
  } finally {
    await endRunUI()
  }
}

async function runFanbox(mode, creatorId) {
  try {
    await ensurePermission()

    const interval = Math.max(0, Number($('#optInterval').value) || 0)
    const limit = Math.max(0, Number($('#optLimit').value) || 0)
    const opts = {
      interval,
      concurrency: Math.max(1, Math.min(3, Number($('#optConcurrency').value) || 1)),
      skip: $('#optSkip').checked,
      files: $('#optFiles').checked,
      cover: $('#optCover').checked,
      text: $('#optText').checked,
      useCache: $('#optUseCache').checked,
      maxMB: Math.max(0, Number($('#optMaxMB').value) || 0),
      vidBin: !($('#optVidBin') && $('#optVidBin').checked === false),
      rangeResume: !($('#optRange') && $('#optRange').checked === false),
    }
    S.optsCur = opts
    S.rangeResume = opts.rangeResume

    // 枚举列表缓存 + 投稿级进度：中断后不用重新枚举，也不会重下已完成的投稿
    const listKey = 'posts:' + creatorId
    const progKey = 'prog:' + creatorId
    let posts = []
    // 从「画师卡片」进来时，先用文件夹里的 _投稿列表.json 顶替枚举：
    // 换手机 / 重装扩展 / 清掉 localStorage 之后也能不联网枚举就直接续跑
    let presetPosts = null
    const importedF = takeImported(creatorId) // 导入的清单要先验来源（站点/画师对不上就作废）
    if (!importedF && opts.useCache && S.presetArtist && S.presetArtist.folder) {
      try {
        const d0 = await S.parent.getDirectoryHandle(S.presetArtist.folder)
        const arr = JSON.parse(await (await d0.getFileHandle('_投稿列表.json')).getFile().then((f) => f.text()))
        if (Array.isArray(arr) && arr.length) {
          const nm = S.presetArtist.artistName || stripSiteSuffix(S.presetArtist.folder)
          presetPosts = arr
            .map((p) => ({
              id: String(p.id),
              title: p.title || '',
              publishedDatetime: p.date || p.publishedDatetime || '',
              feeRequired: p.fee,
              user: { name: nm },
            }))
            .filter((p) => p.id)
          if (presetPosts.length) log(`用文件夹里的 _投稿列表.json：${presetPosts.length} 篇（免枚举）`)
        }
      } catch (e) {
        /* 没有就说没有 */
      }
    }
    if (importedF) {
      posts = importedF
      log(`用导入的枚举：${posts.length} 篇`)
      // 先别清：预检也要用这份清单，等过了预检分支再消费掉
    } else {
      const cached = opts.useCache ? lsGet(listKey, null) : null
      if (Array.isArray(cached) && cached.length) {
        posts = cached
        log(`用上次枚举：${posts.length} 篇（跳过枚举，省 1 分钟左右；要重新枚举就取消勾「用上次枚举」）`)
      } else if (presetPosts && presetPosts.length) {
        posts = presetPosts
      } else {
        posts = await enumerate(creatorId, opts)
        if (S.enumComplete === false) {
          log('! 枚举不完整，这份列表不写进缓存（避免往后每轮都在残表上续跑）')
        } else {
          lsSet(
            listKey,
            posts.map((p) => ({
              id: p.id,
              title: p.title,
              publishedDatetime: p.publishedDatetime,
              feeRequired: p.feeRequired,
              tags: p.tags,
              user: p.user ? { name: p.user.name } : null,
            })),
          )
          log(`枚举列表已存档（${posts.length} 篇）`)
        }
      }
    }
    let list = posts
    // 单篇模式：从投稿页的按钮进来时只保留这一篇。
    // 不用「最多篇数」实现，因为那会按倒序截前 N 篇，目标若在下标靠后就永远轮不到。
    if (S.singlePostId) {
      const one = posts.filter((p) => String(p.id) === String(S.singlePostId))
      if (!one.length) {
        // 缓存枚举可能是昨天的：今天新发的投稿点「下载本篇」不该直接失败。
        // 与 pixiv 线对齐——post.info 会补上标题/日期，handlePost 里的文件夹名才是准的。
        log(`! ${S.singlePostId} 不在枚举结果里，仍按单篇处理（post.info 会补标题）`)
        list = [{ id: S.singlePostId, title: '', publishedDatetime: '', user: (posts[0] && posts[0].user) || null }]
      } else {
        list = one
        log(`单篇模式：只处理投稿 ${S.singlePostId}`)
      }
    }
    if (limit > 0) list = list.slice(0, limit)
    S.postsAll = list.slice() // 「最多篇数」截断前的完整表：截断表不能当全量存档（换机会永久漏篇）
    S.posts = list
    S.postsCreator = creatorId
    S.stats.postsTotal = list.length
    refreshStats()

    if (mode === 'precheck') {
      // 预检只取前 3 篇估算文件数；不建目录、不下载
      const sample = Math.max(1, Math.min(3, list.length))
      let files = 0
      for (const p of list.slice(0, sample)) {
        try {
          const info = await api('post.info?postId=' + p.id)
          const got = info && info.body && info.body.post
          if (got) files += collectFiles(got, opts).length
          await sleep(jit(interval))
        } catch (e) {
          /* 忽略 */
        }
      }
      const avg = files / sample
      log(`预检：约 ${list.length} 篇，平均 ${avg.toFixed(1)} 个文件/篇 → 约 ${Math.round(avg * list.length)} 个文件，≈ ${fmtBytes(Math.round(avg * list.length * 4.5 * 1024 * 1024))}`)
      log('预检结束（没有下载任何文件）')
      return
    }

    // 过了预检分支才真正消费掉导入的清单：否则点一次「预检」就把导入的 JSON 吃掉了
    S.importedPosts = null
    S.importedFor = null

    // 只有真正下载才挂保活：亮屏 + 静音音频 + 每 30s 给代理页续一次
    keepScreenOn()
    startSilentAudio()
    keepFanboxTabAlive()
    S.keepAliveTimer = setInterval(keepFanboxTabAlive, 30000)

    const artistName = sanitize((posts[0] && posts[0].user && posts[0].user.name) || creatorId, 60)
    const folderOverride = String($('#optArtistFolder').value || '').trim()
    // 落盘文件夹：① 手工指定 → 就用它；② 从画师卡片进来 → 就用卡片上那个文件夹（老文件夹得以延续）；
    // ③ 都没给 → 新建「画师名 (站点)」，把站点写进名字里，两份同名画师不会互相污染清单
    let totalFolder = folderOverride ? sanitize(folderOverride, 60) : ''
    let resolved = null
    if (!totalFolder && S.presetArtist && S.presetArtist.folder) {
      // 只认「同一站点」的预设，并且核对文件夹里的站点标记。
      // 否则：先点过某张 pixiv 卡片、再跑 fanbox 同名画师时，文件会写进上一个站的文件夹，
      // 还会把它的 _站点.json 覆盖成错的站点（永久误标，程序里没有撤销路径）。
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
    S.totalFolder = totalFolder // 以前从没赋值，finally 写进度时 dir 是空串，续跑永远对不上
    // 进度签名：换父目录、换总文件夹名、改勾选之后，旧的完成标记一律不算数。
    // 父目录名必须进签名——否则在 SD 卡和内置存储各有一个同名 FANBOX 目录时，
    // 切到另一个空目录会认领旧标记 → 每篇都“跳过”、新目录却一篇都没有。
    const sigObj = {
      parent: (S.parent && S.parent.name) || '',
      folder: totalFolder,
      files: opts.files ? 1 : 0,
      cover: opts.cover ? 1 : 0,
      text: opts.text ? 1 : 0,
      skip: opts.skip ? 1 : 0,
    }
    S.progSig = JSON.stringify(sigObj)
    const legacySig = [totalFolder, sigObj.files, sigObj.cover, sigObj.text, sigObj.skip].join('|')
    const prog = loadProg(progKey, S.progSig, legacySig, totalFolder, optsFlags(opts))
    S.artistDir = resolved.dir
    await writeSiteFile(S.artistDir, creatorId, artistName)
    // 「旧版进度兜底」只看总文件夹名，不认父目录：在 SD 卡和内置存储各有一个同名总文件夹时，
    // 切到另一个空目录会认领别人的完成标记 → 整站一篇不下、进度条跑满，还把新目录永久记成“已完成”。
    // 空目录里不可能有已完成的投稿，作为存在性抽查足够。
    let progDone = prog.done
    let progLen = prog.len
    const progHow = prog.how
    if (progLen && progHow !== 'sig') {
      let hasSub = false
      try {
        for await (const [, h] of S.artistDir.entries()) {
          if (h.kind === 'directory') {
            hasSub = true
            break
          }
        }
      } catch (e) {
        hasSub = true // 列不出来就别乱丢，按老行为走
      }
      if (!hasSub) {
        log(`! 旧版进度（${progLen} 篇）在本目录里找不到任何作品文件夹，判定是另一个目录的同名文件夹，不沿用`)
        progDone = {}
        progLen = 0
      }
    }
    S.done = progDone
    if (progLen) {
      const tag = progHow === 'sig' ? '' : '（沿用旧版进度；若改过选项请取消勾「跳过已存在」）'
      log(`续跑：已有 ${progLen} 篇完成标记${tag}`)
    } else {
      log('这一组设置（父目录+总文件夹名+选项）没有旧进度，从头开始记')
    }
    await loadIndex()
    // 进度以文件夹为准：只认「确实整篇跑完过」+「当时选项覆盖本轮」的篇（换机 / 重装 / 清 localStorage 都不丢）
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

    let lastFlushBytes = 0 // B29：上次落盘时的累计字节，用来触发"攒够 200 MB 就落一次"
    for (let i = 0; i < list.length; i++) {
      if (S.stopFlag) {
        log('已停止')
        break
      }
      await waitIfPaused()
      const post = list[i]
      // 投稿级续跑：上一轮已完整下完的投稿直接跳过（不再请求 post.info）
      // 但「下载本篇」是用户明确指名点的那一篇，不能因为旧完成标记就什么都不做——
      // 那正好是最需要"重新核对一遍"的时候（可能上次失败/文件缺失）。已存在的文件仍会被 fileOk 跳过。
      // 跳过闸门：不只看 localStorage 标记，还要确认磁盘上这篇的文件夹还在（被删/被移走就得重下）
      if (await shouldSkipPost(S.artistDir, post, opts)) {
        S.stats.skipPosts++
        S.stats.postsDone = i + 1
        refreshStats()
        continue
      }
      const failBefore = S.stats.fail
      const r = await handlePost(post, S.artistDir, opts)
      // 只有“整篇真的跑完”才写完成标记：停止、失败、没走完全部文件都不算。
      // 「被单文件上限跳过」（r.filtered）同样不算完成——否则放开上限也补不回来（B30）。
      const complete = !S.stopFlag && !!r && r.status === 'ok' && S.stats.fail === failBefore && r.attempted === r.total && !r.filtered
      if (complete) {
        S.done[post.id] = 1
        S.verified[post.id] = 1 // 这才是「整篇跑完」的落盘证据，清单里"出现过文件夹"不算
      } else delete S.done[post.id]
      S.stats.postsDone = i + 1
      refreshStats()
      // 每 20 篇落一次清单和进度：中途崩了/被系统杀掉也不至于白跑。
      // B29：一篇大 zip 就上百 MB，只按篇数落盘的话，被杀时最多丢 19 篇的记录；
      // 再加一条「攒够 200 MB 也落一次」，把丢记录的窗口按字节也压住（实测有 9 个 zip 落盘却没进清单）。
      if ((i + 1) % 20 === 0 || S.stats.bytes - lastFlushBytes > 200 * 1048576) {
        lastFlushBytes = S.stats.bytes
        await writeIndex()
        await writeDonePosts()
        saveProg()
      }
    }
    // 收尾补漏：手机网络抖动很常见，单个文件一轮只试 4 次就放弃；
    // 全部跑完再集中重试一轮，比让用户手动再跑一整遍（要重新遍历几百篇、每篇还要请求 post.info）划算得多。
    // 注意这里**不**顺手标完成标记：下次运行会重新过一遍这篇，届时 fileOk() 会跳过已存在的文件。
    if (!S.stopFlag && S.failed.length) {
      const retry = S.failed.slice()
      const retryable = retry.filter((it) => it.url && it.file && it.folder)
      // 取投稿信息失败 / 接口改版这类条目没有 url，补下没有意义，原样留在失败清单里
      S.failed = retry.filter((it) => !(it.url && it.file && it.folder))
      log(`补漏：${retryable.length} 个文件失败，集中重试一轮`)
      let ok = 0
      // 熔断：连续 8 个补下都失败说明链路已经断了，再逐个硬撞下去会白耗几小时
      //（实测断网时单个文件重试 6 次约 68 秒，1000 个就是 19 小时）
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
          S.records.push({
            post_id: it.post_id,
            title: it.title,
            date: it.date,
            fee: it.fee,
            folder: it.folder,
            file: it.file,
            url: it.url,
            bytes: bytes,
          })
        } catch (e) {
          S.failed.push(it)
          streakFail++
          log(`  ✗ 补下仍失败 ${it.file}：${e.message}`)
          if (streakFail >= 8) {
            log('! 连续 8 个文件补下都失败，疑似网络中断，补漏轮提前结束（这些条目留在 _失败清单.json，下次运行会重试）')
            break
          }
        }
        await sleep(jit(opts.interval))
      }
      log(`补漏结束：成功 ${ok}，仍失败 ${S.failed.length}`)
      // B39：补漏轮把某篇的最后一个失败文件补下来后，必须补写该篇的「完成」标记。
      // 以前这里只加 filesDone/records 不写 done —— 真机 2026-11-17 实测：清单 9 条、_完成篇 只有 1 条，
      // 之后每次运行都会把它当"没下完"反复复查，审计时还会显示成「有记录但没完成」。
      // 条件收紧：本轮没有被上限跳过的文件（capSkip）才敢补记，否则可能把"还差一个大包"的篇记成完成。
      if (ok > 0 && !S.stopFlag && !S.stats.capSkip) {
        const stillFailed = new Set(S.failed.map((f) => String(f.post_id)))
        const fixedPosts = new Set()
        for (const it of retryable) {
          const pid = String(it.post_id)
          if (!stillFailed.has(pid) && !S.done[pid]) fixedPosts.add(pid)
        }
        if (fixedPosts.size) {
          for (const pid of fixedPosts) {
            S.done[pid] = 1
            S.verified[pid] = 1
          }
          await writeDonePosts()
          log(`补漏后补记完成：${fixedPosts.size} 篇`)
        }
      }
    }
    // 这里不再重复 writeIndex()：finally 里已经保证写一次，连写两遍在安卓上要白花几秒，
    // 还多一次「写到一半被杀 → 清单变半截」的窗口
    log(`${S.stopFlag ? '已中止：' : '完成：'}新增 ${S.stats.filesDone} 个文件，跳过文件 ${S.stats.skip} / 整篇 ${S.stats.skipPosts}，失败 ${S.stats.fail}，共 ${fmtBytes(S.stats.bytes)}`)
    if (S.stats.capSkip) log(`! 单文件上限跳过了 ${S.stats.capSkip} 个文件（约 ${fmtBytes(S.stats.capSkipBytes)}），这些篇没有记完成；把「单文件上限」改大或设 0 再跑同一组，会把它们补下来（已下的文件仍然跳过）`)
    if (S.stats.lenMissing) log(`! 有 ${S.stats.lenMissing} 个响应没给 Content-Length（其中 ${S.stats.lenFromHead} 个用 HEAD 补到了），链路可能变了`)
    if (S.stats.unverifiable) log(`! 其中 ${S.stats.unverifiable} 个既无长度、格式也没法尾校验（如 mp4）：这些只能"读完即算完"，做完整性审计时别把它们当成已验证`)
  } catch (e) {
    log('✗ 中断：' + (e && e.message ? e.message : e))
  }
}

/* ---------------- Pixiv 下载线 ---------------- */

/** localStorage 键要按站点分开：pixiv 的 uid 与 fanbox 的 creatorId 万一数字相同会互相覆盖。
 *  fanbox 保持原样不加前缀，否则现有进度存档会全部失联。 */
function siteStoreKey(id) {
  return (S.site === 'pixiv' ? 'pixiv:' : '') + id
}

/** 取「手工导入的枚举」：只有导入时记下的站点/画师与本次一致才算数。
 *  不一致就作废——否则导入了 A 的清单、输入框又改成 B，会把 A 的清单灌进 B 的文件夹；
 *  而且这个标志如果不清，「用上次枚举」会被永久关掉（B14）。
 *  注意：这里只「取用」，真正消费（清空）要等过了预检分支。 */
function takeImported(creatorId) {
  const list = S.importedPosts
  if (!Array.isArray(list) || !list.length) return null
  const f = S.importedFor
  const cid = String(creatorId || '')
  if (f && (String(f.site || '') !== String(S.site || '') || String(f.creator || '') !== cid)) {
    log(`! 导入的枚举属于 ${siteTag(f.site)} 的 ${f.creator || '（未填画师）'}，与本次 ${siteTag(S.site)} 的 ${cid || '（未填画师）'} 不同，作废不用`)
    S.importedPosts = null
    S.importedFor = null
    return null
  }
  return list
}

/** pixiv 的 createDate 形如 "2026/11/15 22:33:46"（JST），转成 fanbox 那种 ISO 串好复用 postDate() */function toIso(d) {
  const s = String(d || '')
  const m = s.match(/^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00`
  return s
}

/** 把 pixiv 作品整理成「和 fanbox 投稿同形」的对象，folderNameOf / 记录字段直接复用 */
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

/** pixiv 版的「投稿信息.txt」 */
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

/** 极简 HTML → 纯文本（小说正文用；不用 DOMParser，避免把几千字塞进 DOM） */
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

/** 一件作品要下哪些文件（kind 决定命名与后续处理） */
async function buildPixivFiles(w, detail, opts) {
  const PL = window.PixivLine
  if (w.kind === 'novel') return [] // 小说没有图片文件，只写正文 txt
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
    return url ? [{ url, ext: PL.guessExt(url), name: '', kind: 'image', seq: PL.pad(1, 3) }] : []
  }
  const pages = await PL.getPages(detail.id)
  return PL.filesFromPages(pages)
}

/** 文件名：001.png / 001_ugoira.zip /（ugoira 帧另见拆帧函数） */
function pixivFileName(f) {
  if (f.kind === 'ugoira_zip') return `${f.seq}_ugoira.${f.ext}`
  return `${f.seq}.${f.ext}`
}

/** 不拆帧时写一份「怎么播放这个 zip」的说明：帧名顺序 + 每帧延时（毫秒）。
 *  pixiv 的 ugoira 原始文件就是一个 zip，播放器需要这份延时表才能放对速度。 */
async function writeUgoiraInfo(dir, zipName, detail) {
  const meta = detail.ugoiraMeta || {}
  const frames = (meta.frames || []).map((f) => ({ file: f.file, delay: f.delay }))
  try {
    await writeText(
      dir,
      '动图信息.json',
      JSON.stringify(
        { id: String(detail.id), mime: meta.mime_type || '', zip: zipName, frameCount: frames.length, frames },
        null,
        1,
      ),
    )
  } catch (e) {
    log('! 写 动图信息.json 失败：' + e.message)
  }
}

/** 处理一件 pixiv 作品：取详情 → 建文件夹 → 下文件 → 写信息 */
async function handlePixivWork(w, artistDir, opts) {
  const PL = window.PixivLine
  const failAtStart = S.stats.fail
  const isNovel = w.kind === 'novel'
  let detail = null
  try {
    detail = isNovel ? await PL.getNovel(w.id) : await PL.getIllust(w.id)
  } catch (e) {
    S.stats.fail++
    log(`✗ 取作品信息失败 ${w.id}：${(e && e.message) || e}`)
    S.failed.push({ post_id: w.id, folder: '', file: '', url: '', kind: 'work.info', error: String((e && e.message) || e) })
    return { status: 'fail', total: 0, attempted: 0 }
  }
  const post = pixivWorkToPost(detail)
  let files = []
  try {
    files = await buildPixivFiles({ id: w.id, kind: isNovel ? 'novel' : 'illust' }, detail, opts)
  } catch (e) {
    S.stats.fail++
    log(`✗ 取文件列表失败 ${w.id}：${(e && e.message) || e}`)
    S.failed.push({ post_id: w.id, folder: '', file: '', url: '', kind: 'work.files', error: String((e && e.message) || e) })
    return { status: 'fail', total: 0, attempted: 0 }
  }
  // pixiv 侧同样受「单文件上限」约束（会命中的主要是动图 zip / 大图，普通图片接口不给 size 不受影响）
  const capRes = applySizeCap(files, opts)
  const capSkip = capRes.skipped.length
  if (capSkip) {
    let capBytes = 0
    for (const f of capRes.skipped) capBytes += Number(f.size) || 0
    S.stats.capSkip += capSkip
    S.stats.capSkipBytes += capBytes
    log(`· 上限跳过 ${capSkip} 个文件（约 ${fmtBytes(capBytes)}，该篇不记完成，放开上限后会补）`)
  }
  const filesAll = files
  files = capRes.keep
  if (!filesAll.length && !isNovel) {
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
      // 没勾「投稿信息 txt」时小说没有任何文件可写：不能建个空文件夹然后记成完成，
      // 否则以后勾上 txt 也不会再补写正文（这篇已被判定完成）
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
  const jobs = files.map((f) => {
    const orig = pixivFileName(f)
    return { f, orig, name: diskNameOf(orig, opts) }
  })
  let cursor = 0
  const worker = async () => {
    for (;;) {
      if (S.stopFlag) return
      await waitIfPaused()
      if (S.stopFlag) return
      const idx = cursor++
      if (idx >= jobs.length) return
      attempted++
      const { f, name, orig } = jobs[idx]
      // B33：同 fanbox 侧——音视频在这台手机上只能加 .bin 落盘（SAF 的 MIME 限制）
      if (orig && name !== orig && !S.vidBinNoticed) {
        S.vidBinNoticed = true
        log(`! 本机 SAF 不允许创建音视频文件（mp4/mp3…），已改用「原文件名+.bin」保存：数据完整，改名去掉 .bin 即可播放`)
      }
      const old = S.index.get(folder + '|' + name)
      const expect = old && Number(old.bytes) > 0 ? Number(old.bytes) : 0
      const sizeOk = await fileOk(dir, name, expect)
      const complete = sizeOk && (await fileComplete(dir, name, expect))
      // 文件级判据**永远**生效，和「跳过已存在」（整篇级）是两件事（B24），理由见 fanbox 侧同一处注释
      if (complete) {
        S.stats.skip++
        if (f.kind === 'ugoira_zip') {
          zipName = name
          zipOk = true
        }
        S.records.push({
          post_id: post.id,
          title: post.title,
          date: post.publishedDatetime,
          folder: folder,
          file: name,
          url: f.url,
          bytes: await getSize(dir, name),
          skipped: true,
        })
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
        S.records.push({
          post_id: post.id,
          title: post.title,
          date: post.publishedDatetime,
          folder: folder,
          file: name,
          url: f.url,
          bytes: bytes,
        })
      } catch (e) {
        if (e && e.isFatal) {
          S.stats.fail++
          refreshStats() // B36：失败后立刻刷新，别让状态栏一直停在“失败 0”
          log(`✗ 下载失败 ${post.id}/${name}：${e.message}`)
          S.failed.push({ post_id: post.id, folder: folder, file: name, url: f.url, kind: '致命错误', error: String(e.message || e) })
          S.stopFlag = true
          return
        }
        if (S.stopFlag) return
        S.stats.fail++
        refreshStats() // B36
        log(`✗ 下载失败 ${post.id}/${name}：${e.message}`)
        log('   ' + f.url)
        S.failed.push({
          post_id: post.id,
          title: post.title,
          folder: folder,
          file: name,
          url: f.url,
          error: String((e && e.message) || e),
        })
      }
      await sleep(jit(opts.interval))
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(3, opts.concurrency || 1)) }, worker))
  // 动图只落两样东西：原始 zip（画师上传的那个包，一个文件）+ 一份帧延时说明。
  // 不拆帧：拆帧要每帧写一个文件，几百帧在手机上要几十秒，而且本质是在复制 zip 里已有的数据。
  if (zipOk && !S.stopFlag) await writeUgoiraInfo(dir, zipName, detail)
  if (S.stopFlag) {
    log(`⊘ ${post.id} 中断（已下 ${savedHere}/${jobs.length}，下次会补齐剩余）`)
    return { status: 'stopped', total: jobs.length, attempted }
  }
  // 有文件失败就别打 ✓ —— 实测断网时这里会打出「✓ xxx（1 个文件，新增 0）」，看着像成功
  const failedHere = S.stats.fail - failAtStart
  if (failedHere > 0) log(`△ ${post.id} ${sanitize(post.title, 34)}（${jobs.length} 个文件，新增 ${savedHere}，失败 ${failedHere}）`)
  else log(`✓ ${post.id} ${sanitize(post.title, 34)}（${jobs.length} 个文件，新增 ${savedHere}）`)
  return { status: 'ok', total: jobs.length, attempted, filtered: capSkip }
}

/** pixiv 主流程：枚举 → 每件一个文件夹 → 复用清单/索引/进度/补漏 */
async function runPixiv(mode, creatorId) {
  const PL = window.PixivLine
  if (!PL) throw new Error('pixiv-line.js 没加载（检查 app.html 里 script 的顺序）')
  await ensurePermission()

  const interval = Math.max(0, Number($('#optInterval').value) || 0)
  const limit = Math.max(0, Number($('#optLimit').value) || 0)
  const opts = {
    interval,
    concurrency: Math.max(1, Math.min(3, Number($('#optConcurrency').value) || 1)),
    skip: $('#optSkip').checked,
    files: $('#optFiles').checked,
    cover: $('#optCover').checked,
    text: $('#optText').checked,
    useCache: $('#optUseCache').checked,
    maxMB: Math.max(0, Number($('#optMaxMB').value) || 0),
    vidBin: !($('#optVidBin') && $('#optVidBin').checked === false),
    rangeResume: !($('#optRange') && $('#optRange').checked === false),
  }
  S.optsCur = opts
  S.rangeResume = opts.rangeResume

  const listKey = 'posts:' + siteStoreKey(creatorId)
  const progKey = 'prog:' + siteStoreKey(creatorId)

  // ---- 枚举 ----
  let list = null
  let artistName = ''
  // 手工导入的枚举：pixiv 线以前完全不认这份清单，而标志位又永远不清 → 导入过一次之后
  // 「用上次枚举」永久失效（B14）。这里与 fanbox 线对齐：认它、用完清它，类型缺省按插画，
  // 导入文件里写了 kind:'novel' 的按小说走（取详情时类型不对会各自报错，不会静默下错）。
  const importedP = takeImported(creatorId)
  if (importedP) {
    list = importedP.map((p) => ({ id: String(p.id), kind: p.kind === 'novel' ? 'novel' : 'illust' }))
    log(`用导入的枚举：${list.length} 件（类型没标的一律按插画处理）`)
  }
  if (!list && opts.useCache) {
    const c = lsGet(listKey, null)
    if (Array.isArray(c) && c.length) {
      list = c
      log(`用上次枚举：${c.length} 件（跳过枚举；要重新枚举就取消勾「用上次枚举」）`)
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
      // 目标可能不在这位画师的公开列表里（直接点别人作品页进来的）。
      // 单篇是用户明确指名的，照样下；具体类型在取详情时才知道。
      works = [{ id: S.singlePostId, kind: S.singlePostKind || 'illust' }]
      log('! 这篇不在该画师的公开列表里，仍按单篇处理' + (S.singlePostKind ? '（' + S.singlePostKind + '）' : ''))
    }
  }
  if (limit) {
    works = works.slice(0, limit)
    log('限制最多 ' + limit + ' 件')
  }
  S.postsAll = works.slice()
  S.posts = works
  S.stats.postsTotal = works.length
  refreshStats()

  // ---- 预检：只列清单 ----
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
      await sleep(jit(interval))
    }
    log('预检结束（没有下载任何文件）')
    return
  }

  // 过了预检分支才消费掉导入的清单（与 fanbox 线同一条规矩）
  S.importedPosts = null
  S.importedFor = null

  // ---- 画师名 / 总文件夹 ----
  if (!artistName) {
    try {
      const d0 = await PL.getIllust(works[0].id)
      artistName = d0.userName || ''
    } catch (e) {
      /* 取不到就退回 uid */
    }
  }
  const folderOverride = String($('#optArtistFolder').value || '').trim()
  let totalFolder = folderOverride ? sanitize(folderOverride, 60) : ''
  let resolvedP = null
  if (!totalFolder && S.presetArtist && S.presetArtist.folder) {
    // 与 fanbox 线同一条规矩：跨站的卡片预设绝不能用（会写进另一站的文件夹并改坏 _站点.json）
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
  const sigObj = {
    parent: (S.parent && S.parent.name) || '',
    folder: totalFolder,
    files: opts.files ? 1 : 0,
    cover: opts.cover ? 1 : 0,
    text: opts.text ? 1 : 0,
    skip: opts.skip ? 1 : 0,
  }
  S.progSig = JSON.stringify(sigObj)
  S.artistDir = resolvedP.dir
  await writeSiteFile(S.artistDir, creatorId, artistName || creatorId)
  const prog = loadProg(progKey, S.progSig, '', totalFolder, optsFlags(opts))
  let progDone = prog.done
  let progLen = prog.len
  // 与 fanbox 线同一条抽查：老进度只看总文件夹名、不认父目录，
  // 换到另一个空目录（SD 卡 / 内置存储各有一份同名）时会把旧标记整套认领过来 →
  // 进度条瞬间跑满、一件不下，还把空目录永久记成已完成。空目录里不可能有已完成的作品。
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
      hasSub = true // 列不出来就别乱丢
    }
    if (!hasSub) {
      log(`! 旧版进度（${progLen} 件）在本目录里找不到任何作品文件夹，判定是另一个目录的同名文件夹，不沿用`)
      progDone = {}
      progLen = 0
    }
  }
  S.done = progDone
  if (progLen) log(`续跑：已有 ${progLen} 件完成标记`)
  else log('这一组设置没有旧进度，从头开始记')
  await loadIndex()
  // 进度以文件夹为准：只认「确实整件跑完过」+「当时选项覆盖本轮」的件
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

  // ---- 主循环 ----
  let lastFlushBytes = 0 // B29：攒够 200 MB 也落一次盘，别等满 20 篇
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
    // 被单文件上限跳过的篇不算完成（B30），放开上限后会补
    const complete = !S.stopFlag && !!r && r.status === 'ok' && S.stats.fail === failBefore && r.attempted === r.total && !r.filtered
    if (complete) {
      S.done[w.id] = 1
      S.verified[w.id] = 1
    } else delete S.done[w.id]
    S.stats.postsDone = i + 1
    refreshStats()
    if ((i + 1) % 20 === 0 || S.stats.bytes - lastFlushBytes > 200 * 1048576) {
      lastFlushBytes = S.stats.bytes
      await writeIndex()
      saveProg()
    }
    await sleep(jit(interval))
  }

  // ---- 收尾补漏（只补有 url 的文件；拆帧/信息类失败留清单里等下一轮） ----
  if (!S.stopFlag && S.failed.length) {
    const retry = S.failed.slice()
    const retryable = retry.filter((it) => it.url && it.file && it.folder)
    S.failed = retry.filter((it) => !(it.url && it.file && it.folder))
    log(`补漏：${retryable.length} 个文件失败，集中重试一轮`)
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
        streakFail = 0
        log(`  ✓ 补下 ${it.file} ${fmtBytes(bytes)}`)
        refreshStats()
        S.records.push({
          post_id: it.post_id,
          title: it.title,
          date: it.date,
          folder: it.folder,
          file: it.file,
          url: it.url,
          bytes: bytes,
        })
      } catch (e) {
        S.failed.push(it)
        streakFail++
        log(`  ✗ 补下仍失败 ${it.file}：${(e && e.message) || e}`)
        if (streakFail >= 8) {
          log('! 连续 8 个文件补下都失败，疑似网络中断，补漏轮提前结束（条目留在 _失败清单.json，下次运行会重试）')
          break
        }
      }
    }
    log(`补漏结束：成功 ${retryable.length - S.failed.length}，仍失败 ${S.failed.length}`)
    // B39（pixiv 线）：补漏成功的篇也要补记「完成」，否则下次仍被当成没下完（同 fanbox 线）
    if (!S.stopFlag && !S.stats.capSkip) {
      const stillFailed = new Set(S.failed.map((f) => String(f.post_id)))
      const fixedPosts = new Set()
      for (const it of retryable) {
        const pid = String(it.post_id)
        if (!stillFailed.has(pid) && !S.done[pid]) fixedPosts.add(pid)
      }
      if (fixedPosts.size) {
        for (const pid of fixedPosts) {
          S.done[pid] = 1
          S.verified[pid] = 1
        }
        await writeDonePosts()
        log(`补漏后补记完成：${fixedPosts.size} 件`)
      }
    }
  }
  log(`完成：新增 ${S.stats.filesDone} 个文件，跳过文件 ${S.stats.skip} / 整件 ${S.stats.skipPosts}，失败 ${S.stats.fail}，共 ${fmtBytes(S.stats.bytes)}`)
  if (S.stats.capSkip) log(`! 单文件上限跳过了 ${S.stats.capSkip} 个文件（约 ${fmtBytes(S.stats.capSkipBytes)}），这些件没有记完成；把「单文件上限」改大或设 0 再跑同一组会补下`)
  if (S.stats.lenMissing) log(`! 有 ${S.stats.lenMissing} 个响应没给 Content-Length（其中 ${S.stats.lenFromHead} 个用 HEAD 补到了），链路可能变了`)
  if (S.stats.unverifiable) log(`! 其中 ${S.stats.unverifiable} 个既无长度、格式也没法尾校验（如 mp4）：只能"读完即算完"`)
}

/* ---------------- 事件绑定 ---------------- */

function bind() {
  $('#pick').addEventListener('click', async () => {
    // 运行中换目录：S.parent 变了但 S.artistDir 还是旧 handle，后半段会写旧目录、
    // 进度却按新签名记 —— 直接挡掉，让用户先停止
    if (S.running) {
      log('运行中不能换目录，请先点「停止」')
      return
    }
    try {
      await pickFolder()
    } catch (e) {
      log('选择目录失败：' + e.message)
    }
  })

  // 0.3.34：目录名胶囊本身就是「换目录」入口（真机上手会去点那一行）
  const dirNameEl = $('#dirName')
  if (dirNameEl) {
    dirNameEl.addEventListener('click', () => {
      if (S.running) {
        log('运行中不能换目录，请先点「停止」')
        return
      }
      $('#pick').click()
    })
  }

  $('#parse').addEventListener('click', () => {
    // 0.3.34：以前不管什么模式都按 Fanbox 的 creatorId 解析，
    // Pixiv 画师 / 收藏模式下填数字 uid 会被当成 creatorId 显示成「creatorId = 12345」。
    const raw = $('#creator').value
    const isPx = S.site === 'pixiv'
    const id = isPx ? parsePixivUid(raw) : parseCreator(raw)
    const info = $('#creatorInfo')
    if (id) {
      info.textContent = (isPx ? 'uid = ' : 'creatorId = ') + id
      log('画师：' + id)
    } else if (isPx && !String(raw).trim() && S.mode === 'pixiv-fav') {
      info.textContent = '留空 = 当前登录账号，可以直接开始'
    } else {
      info.textContent = isPx ? '没解析出来，直接填数字 uid 试试' : '没解析出来，直接填 creatorId 试试'
    }
  })

  $('#precheck').addEventListener('click', () => {
    doRun('precheck').catch((e) => log('✗ ' + (e && e.message ? e.message : e)))
  })
  $('#start').addEventListener('click', () => {
    doRun('run').catch((e) => log('✗ ' + (e && e.message ? e.message : e)))
  })

  // 兜底：任何漏网的 async 异常都写进日志，不要静默失败
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason
    log('✗ 未捕获异常：' + (r && r.message ? r.message : r))
  })

  // 切走再切回来时，浏览器会释放亮屏锁/挂起音频，这里重新申请
  document.addEventListener('visibilitychange', () => {
    if (S.running && document.visibilityState === 'visible') {
      keepScreenOn()
      startSilentAudio()
    }
  })

  $('#pause').addEventListener('click', () => {
    S.paused = !S.paused
    $('#pause').textContent = S.paused ? '继续' : '暂停'
    const rb = $('#runBrief')
    if (rb) rb.textContent = S.paused ? '已暂停' : '运行中'
    log(S.paused ? '已暂停（当前文件下载完才停）' : '已继续')
  })

  $('#stop').addEventListener('click', () => {
    S.stopFlag = true
    for (const c of S.dlCtrls) c.abort() // 打断正在下的那几个 5MB
    const rb = $('#runBrief')
    if (rb) rb.textContent = '停止中…'
    log('正在停止…')
  })

  // 枚举 JSON：导出到自选路径 / 从自选文件导入
  $('#exportPosts').addEventListener('click', async () => {
    try {
      // 0.3.35：按当前模式挑解析器。以前一律 parseCreator —— Pixiv 模式下填的是数字 uid，
      // 被当成 Fanbox 的 creatorId 之后查的是另一套键，导出永远报「还没有可导出的枚举」。
      const isPx = S.site === 'pixiv'
      const rawId = $('#creator').value
      const id = isPx ? parsePixivUid(rawId) : parseCreator(rawId)
      // 0.3.36：收藏模式导出的是「这个 uid 的全部收藏」。清单在 runFav 枚举完就整份存了一条
      // （posts:pixiv:fav:<uid>）；分组管线写的 fav:<uid>:<画师uid> 是碎片，不能拿来当全量。
      const isFav = S.mode === 'pixiv-fav'
      const favUid = isFav ? id || S.creatorId || '' : ''
      // 只有“当前列表确实属于这个画师”才用它导出，避免把 A 的清单导成 B 的文件名
      const cachedList = isFav
        ? favUid
          ? lsGet('posts:pixiv:fav:' + favUid, null)
          : null
        : lsGet('posts:' + siteStoreKey(id), null)
      // 单篇模式下 S.posts 只有一篇，导出它没意义；优先用枚举缓存里的全量
      const list =
        S.singlePostId && Array.isArray(cachedList) && cachedList.length
          ? cachedList
          : !isFav && S.postsCreator === id && Array.isArray(S.posts) && S.posts.length
            ? S.posts
            : cachedList
      if (!Array.isArray(list) || !list.length) {
        throw new Error(
          isFav
            ? '还没有收藏清单：在收藏模式点一次「只列清单」（或跑一次收藏），跑完会把整份清单存下来'
            : '还没有可导出的枚举：先点一次预检或开始',
        )
      }
      const data = JSON.stringify(
        list.map((p) => ({ id: p.id, title: p.title, date: p.publishedDatetime, fee: p.feeRequired, user: p.user ? { name: p.user.name } : null })),
        null,
        1,
      )
      const name = isFav
        ? `pixiv_收藏_${favUid || 'me'}_${list.length}篇.json`
        : `${isPx ? 'pixiv' : 'fanbox'}_枚举_${id || 'creator'}_${list.length}篇.json`
      if (typeof showSaveFilePicker === 'function') {
        const h = await showSaveFilePicker({ suggestedName: name, types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }] })
        const w = await h.createWritable()
        await w.write(new Blob([data]))
        await w.close()
        log('已导出枚举到：' + h.name)
      } else if (S.parent) {
        await writeText(S.parent, name, data)
        log('已导出枚举到所选目录：' + name)
      } else {
        throw new Error('浏览器不支持另存为，且还没选保存目录')
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return
      log('导出枚举失败：' + (e && e.message))
    }
  })

  $('#importPosts').addEventListener('click', async () => {
    try {
      // 0.3.36：收藏模式没有「一份清单 = 一个目录」这回事（按画师分组各下各的），
      // 导进来的清单根本没落点，先拦下再弹选文件框 —— 否则用户白挑一次文件。
      if (S.mode === 'pixiv-fav') throw new Error('收藏模式不支持导入清单：收藏是按画师分组分别下的，没有对应目录')
      if (typeof showOpenFilePicker !== 'function') throw new Error('这个浏览器不支持选择文件')
      const [h] = await showOpenFilePicker({ types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }] })
      const text = await (await h.getFile()).text()
      const arr = JSON.parse(text)
      if (!Array.isArray(arr) || !arr.length) throw new Error('不是有效的枚举 JSON（应为非空数组）')
      // 文件里的 JSON 常常没有 user 字段（_投稿列表.json 就不带），缺了它总文件夹名会
      // 静默从「画师名」退化成 creatorId，等于另起一个目录重下一遍，所以从枚举缓存里补
      // 0.3.35：和导出一致，按模式挑解析器（Pixiv 的 uid 是数字，parseCreator 会认错键）
      const id = S.site === 'pixiv' ? parsePixivUid($('#creator').value) : parseCreator($('#creator').value)
      const cachedP = id ? lsGet('posts:' + siteStoreKey(id), []) : []
      const cachedUser = (Array.isArray(cachedP) && cachedP[0] && cachedP[0].user) || null
      const seenIds = new Set()
      let badId = 0
      const list = []
      for (const p of arr) {
        const raw = String((p && (p.id || p.post_id)) || '')
        const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '')
        // 清洗只能「拒绝」不能「改写」：把 "12.345" 删成 "12345" 会静默下成另一篇
        if (!cleaned || cleaned !== raw) {
          badId++
          continue
        }
        if (seenIds.has(cleaned)) continue // 同一 id 重复出现会跑两遍
        seenIds.add(cleaned)
        list.push({
          id: cleaned,
          title: (p && p.title) || '',
          publishedDatetime: (p && (p.date || p.publishedDatetime)) || '',
          feeRequired: p ? (p.fee != null ? p.fee : p.feeRequired) : null,
          user: (p && p.user) || cachedUser,
        })
      }
      if (!list.length) throw new Error('JSON 里没有可用的投稿 id')
      if (badId) log(`! 有 ${badId} 条的投稿 id 含非法字符，已跳过`)
      S.importedPosts = list
      S.importedFor = { site: S.site, creator: id || '' } // 记下这份清单是谁的：换了站点/画师就作废
      if (id) lsSet('posts:' + siteStoreKey(id), list)
      log(`已导入枚举：${list.length} 篇（${h.name}），点开始就会用这份清单`)
    } catch (e) {
      if (e && e.name === 'AbortError') return
      log('导入枚举失败：' + (e && e.message))
    }
  })

  $('#saveLog').addEventListener('click', async () => {
    try {
      if (!S.parent) throw new Error('先在「选择文件夹」里选一次，日志会存到那个目录')
      const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)
      await writeText(S.parent, `_日志-${ts}.txt`, S.logLines.join('\n'))
      log(`日志已存到所选目录：_日志-${ts}.txt`)
    } catch (e) {
      log('保存日志失败：' + e.message)
    }
  })

  $('#copyLog').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(S.logLines.join('\n'))
      log('日志已复制')
    } catch (e) {
      log('复制失败：' + e.message)
    }
  })

  $('#clearLog').addEventListener('click', () => {
    S.logLines = []
    $('#log').textContent = ''
    const lb = $('#logBrief')
    if (lb) lb.textContent = '0 行'
  })
  // 0.3.34：日志卡片默认折叠，折叠时 scrollHeight 是 0 —— 展开那一刻再滚到底才有意义
  const logMod = document.querySelector('.mod[data-mod="log"]')
  if (logMod) {
    logMod.addEventListener('toggle', () => {
      const el = $('#log')
      if (logMod.open && el) el.scrollTop = el.scrollHeight
    })
  }

  // 记住上次填的内容（只存本机 localStorage，不联网）
  const FORM_KEY = 'fanbox-folder-dl-form'
  const textFields = ['creator', 'optLimit', 'optInterval', 'optArtistFolder', 'optConcurrency', 'optMaxMB']
  const checkFields = ['optSkip', 'optFiles', 'optCover', 'optText', 'optUseCache', 'optVidBin', 'optRange']
  const selectFields = ['optSource', 'optFavLayout']
  /** 模块摘要（0.3.27）：把 UI 拆成「一个卡片=一个功能」之后，
   *  每张卡片折叠时也要能直接看出当前设置，否则用户还得逐个点开确认。 */
  function refreshBriefs() {
    const val = (id) => {
      const e = $('#' + id)
      return e ? String(e.value || '') : ''
    }
    const on = (id) => {
      const e = $('#' + id)
      return !!(e && e.checked)
    }
    const setB = (id, txt) => {
      const e = $('#' + id)
      if (e) e.textContent = txt
    }
    const src = val('optSource') === 'fav'
    const name = val('creator').trim()
    const kind = modeCur === 'pixiv-fav' ? 'Pixiv 收藏' : modeCur === 'pixiv-artist' ? 'Pixiv 画师' : 'Fanbox 画师'
    setB(
      'targetBrief',
      src || modeCur === 'pixiv-fav'
        ? 'Pixiv 收藏' + (name ? '（' + name + '）' : '（当前账号）')
        : kind + ' · ' + (name || '未填'),
    )
    // 0.3.34：收藏模式下账号框常显了，里面可能还留着上一位画师的 creatorId（字母）。
    // 那串东西会被当成「没填」而回落到当前登录账号 —— 不说清楚，用户会以为在下他的收藏。
    const ci = $('#creatorInfo')
    const LEFTOVER = '这行不是数字 uid → 会按「当前登录账号」处理'
    if (ci) {
      if (src || modeCur === 'pixiv-fav') {
        const v = name.trim()
        ci.textContent = v && !/^\d+$/.test(v) ? LEFTOVER : ''
      } else if (ci.textContent === LEFTOVER) {
        // 切回画师模式时这句话就不成立了（那串字母正是 creatorId），必须收掉
        ci.textContent = ''
      }
    }
    const types = []
    if (on('optFiles')) types.push('附件')
    if (on('optCover')) types.push('封面')
    if (on('optText')) types.push('txt')
    if (on('optVidBin')) types.push('音视频.bin')
    setB('fileBrief', types.length ? types.join(' · ') : '不下任何文件')
    const lim = Number(val('optLimit')) || 0
    const mb = Number(val('optMaxMB')) || 0
    const iv = Number(val('optInterval')) || 0
    const cc = Number(val('optConcurrency')) || 1
    // 0.3.34：摘要只写「非默认」的东西。以前不管有没有设过都拼上「不限篇数 · 不限体积」，
    // 11.5px 字号下 210px 都装不下，折叠标题行只能截断 —— 信息没少，但白占了地方。
    const bits = []
    if (lim) bits.push(lim + ' 篇')
    if (mb) bits.push('≤' + mb + 'MB')
    bits.push(iv <= 0 ? '不限速×' + cc : (iv % 1000 ? (iv / 1000).toFixed(1) : iv / 1000) + 's×' + cc)
    if (on('optRange')) bits.push('续传')
    setB('paceBrief', bits.join(' · '))
    const dm = $('#dirName')
    const db = $('#dirBrief')
    if (db) {
      // 0.3.31：目录摘要改成每次用 dirName 现算。以前只在「空」时才填，而刷新发生在
      // IndexedDB 恢复目录之前 → 模块 2 折叠时永远写「未选择」（真机目检抓到）。
      const t = dm ? String(dm.textContent || '') : ''
      if (t.indexOf('已选：') === 0) db.textContent = t.slice(3)
      else if (t.indexOf('已切入：') === 0) db.textContent = t.slice(4)
      else if (t.indexOf('上次：') === 0) db.textContent = t.slice(3).replace(/\s*（.*$/, '') + '（待授权）'
      else db.textContent = '未选择'
    }
  }

  function saveForm() {
    const o = {}
    textFields.forEach((id) => (o[id] = $('#' + id).value))
    checkFields.forEach((id) => (o[id] = $('#' + id).checked))
    selectFields.forEach((id) => (o[id] = $('#' + id).value))
    // 站点也要一起存：否则浏览器重启/扩展重载后 site 复位成 fanbox，
    // 而画师框里还留着 pixiv 的数字 uid → 点开始就去请求 fanbox 的
    // post.paginateCreator?creatorId=12345，直接 HTTP 400（实测踩到）
    o._site = S.site
    o._mode = modeCur // 0.3.32：三段模式记住，重开时直接回到上次那一种
    try {
      localStorage.setItem(FORM_KEY, JSON.stringify(o))
    } catch (e) {
      /* 忽略 */
    }
    refreshBriefs()
  }
  function restoreForm() {
    try {
      const o = JSON.parse(localStorage.getItem(FORM_KEY) || 'null')
      if (!o) return
      textFields.forEach((id) => {
        if (typeof o[id] === 'string') $('#' + id).value = o[id]
      })
      checkFields.forEach((id) => {
        if (typeof o[id] === 'boolean') $('#' + id).checked = o[id]
      })
      selectFields.forEach((id) => {
        if (typeof o[id] === 'string') $('#' + id).value = o[id]
      })
      if (o._site === 'pixiv' || o._site === 'fanbox') S.site = o._site
      // 0.3.33：老表单里没有 _mode（0.3.32 之前存的），按旧字段反推，别把用户上次选的「我的收藏」丢掉
      if (typeof o._mode === 'string' && MODES[o._mode]) modeCur = o._mode
      else if (o.optSource === 'fav') modeCur = 'pixiv-fav'
      else if (o._site === 'pixiv') modeCur = 'pixiv-artist'
    } catch (e) {
      /* 忽略 */
    }
  }
  textFields.concat(checkFields).concat(selectFields).forEach((id) => $('#' + id).addEventListener('change', saveForm))
  // 0.3.32：三段模式（Fanbox 画师 / Pixiv 画师 / Pixiv 我的收藏）。
  // 以前是两个下拉叠在一起，用户反馈「看不出这三种下载方式的区别」，而且说明文字太长。
  // 现在：三块大按钮选模式，只有当前模式该填的框才出现，解释性文字收进折叠区。
  const MODES = {
    'fanbox-artist': { site: 'fanbox', source: 'artist', hint: '填 creatorId（主页 @ 后面那段）或整条主页链接', ph: 'https://www.fanbox.cc/@creatorId' },
    'pixiv-artist': { site: 'pixiv', source: 'artist', hint: '填 Pixiv 画师 uid 或主页链接（和 Fanbox 不是一套）', ph: 'https://www.pixiv.net/users/12345678' },
    // 0.3.38：收藏模式的 hint 清空 —— 说明由 #creatorLabel 承担，动态校验仍归 #creatorInfo
    'pixiv-fav': { site: 'pixiv', source: 'fav', hint: '', ph: '数字 uid（留空 = 当前登录账号）' },
  }
  let modeCur = 'fanbox-artist'
  /** keep = true：不改站点、不清单篇目标（页面带目标进来时用） */
  function syncModeUI(m, keep) {
    const d = MODES[m] || MODES['fanbox-artist']
    modeCur = m
    // 0.3.33：模式写进 S。doRun 是顶层函数、拿不到 bind() 里的 modeCur；
    // 而隐藏的 #optSource 在真机上出现过「模式=收藏、下拉值却是 artist」的不一致，
    // 所以判定「是不是收藏」要以 S.mode 为准，下拉只作为兼容副本。
    S.mode = m
    if (!keep) {
      S.site = d.site
      S.singlePostId = ''
      S.singlePostKind = ''
    }
    const ss = $('#optSource')
    if (ss) ss.value = d.source
    const badge = $('#siteBadge')
    if (badge) {
      badge.textContent = d.site === 'pixiv' ? 'PIXIV' : 'FANBOX'
      badge.classList.toggle('is-px', d.site === 'pixiv')
    }
    const btns = document.querySelectorAll('#modeSeg .mode')
    for (const b of btns) b.classList.toggle('on', b.getAttribute('data-mode') === m)
    // 0.3.34：画师框常显。收藏模式下 doRun 本来就支持「留空 = 当前账号 / 填 uid = 他人公开收藏」
    // （app.js 里 2168 行那段兜底），以前把它整个 hidden 掉，等于把现成能力藏死。
    const ab = $('#artistBox')
    const fb = $('#favBox')
    if (ab) ab.hidden = false
    if (fb) fb.hidden = d.source !== 'fav'
    const inp = $('#creator')
    if (inp && d.ph) inp.placeholder = d.ph
    const mh = $('#modeHint')
    if (mh) mh.textContent = d.hint
    const lab = $('#creatorLabel')
    if (lab) {
      lab.textContent =
        d.source === 'fav'
          ? '账号 uid（留空 = 当前账号）'
          : d.site === 'pixiv'
            ? 'Pixiv 画师 uid / 主页链接'
            : 'Fanbox creatorId / 主页链接'
    }
  }
  const modeSeg = $('#modeSeg')
  if (modeSeg) {
    modeSeg.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('.mode') : null
      const m = b && b.getAttribute('data-mode')
      if (!m) return
      // 0.3.34：下载途中切模式会翻转 S.site、清掉单篇目标，比换目录更危险
      // （#pick / #mkdir 早就挡住了，只有这里没挡）。按钮不置灰：点下去给一句明确解释比灰着更好懂。
      if (S.running) {
        log('! 正在下载，先点「停止」再换模式')
        return
      }
      syncModeUI(m)
      saveForm()
    })
  }
  // 旧流程（脚本 / 恢复 / 页面带目标）直接改 #optSource 时也要能同步成对应模式
  const srcSel = $('#optSource')
  if (srcSel) {
    srcSel.addEventListener('change', () => {
      syncModeUI(srcSel.value === 'fav' ? 'pixiv-fav' : S.site === 'pixiv' ? 'pixiv-artist' : 'fanbox-artist')
    })
  }

  // 「新建子文件夹并切入」（B34）：不用再走系统选目录，就能在当前根下建一层并当作新下载根
  const mkBtn = $('#mkdir')
  if (mkBtn) {
    mkBtn.addEventListener('click', async () => {
      if (S.running) {
        log('! 正在下载，先停止再换目录')
        return
      }
      const raw = ($('#mkdirName') && $('#mkdirName').value) || ''
      const name = sanitize(raw, 60)
      if (!name) {
        log('! 先填新文件夹名（例如 2026-11）')
        return
      }
      if (!S.parent) {
        log('! 先「选择文件夹」拿到一个目录，再新建子文件夹')
        return
      }
      try {
        const d = await S.parent.getDirectoryHandle(name, { create: true })
        S.parent = d
        S.presetArtist = null
        S.scanned = null
        const lab = $('#dirName')
        if (lab) lab.textContent = '已切入：' + name
        const br = $('#dirBrief')
        if (br) br.textContent = name
        log('已新建并切入子文件夹：' + name + '（本次下载会写进它里面）')
        await scanArtists()
      } catch (e) {
        log('✗ 新建子文件夹失败：' + ((e && e.name) || '') + ' ' + ((e && e.message) || e))
      }
    })
  }
  restoreForm()
  // 0.3.32：恢复表单后统一按「模式」刷一遍界面（站点徽标 / 可见块 / 提示 / 输入框标题），
  // 再重算折叠摘要。以前这里散着两段补丁（0.3.29 补提示、0.3.30 补摘要），
  // 现在模式是唯一真相，一处就够。
  syncModeUI(modeCur)
  {
    const info0 = $('#creatorInfo')
    const id0 = $('#creator').value
    if (info0 && id0 && modeCur !== 'pixiv-fav') info0.textContent = '上次的目标：' + id0
  }
  refreshBriefs()

  /** 应用「站点 / 画师 / 单篇」目标，并把当前模式写在界面上（避免用户不知道点开始会下什么） */
  function applyTarget(creatorId, postId, mode, site, kind) {
    // 换目标就把上一张卡片的「续跑这个文件夹」作废：否则新目标会落进上一位画师的文件夹
    S.presetArtist = null
    if (site) S.site = site === 'pixiv' ? 'pixiv' : 'fanbox'
    if (creatorId) {
      $('#creator').value = creatorId
      saveForm()
    }
    S.singlePostId = mode === 'post' && postId ? String(postId) : ''
    S.singlePostKind = S.singlePostId && kind === 'novel' ? 'novel' : ''
    // 0.3.32：页面带目标进来时，模式胶囊也要跟着高亮（keep=true 保留刚设好的站点/单篇）
    syncModeUI(S.site === 'pixiv' ? 'pixiv-artist' : 'fanbox-artist', true)
    const info = $('#creatorInfo')
    if (!info) return
    const tag = S.site === 'pixiv' ? 'Pixiv' : 'Fanbox'
    if (S.singlePostId) {
      info.textContent = '[' + tag + '] 单篇模式：只下 ' + S.singlePostId
    } else if (creatorId) {
      info.textContent = '[' + tag + '] 全量模式：' + creatorId + ' 的全部作品'
    }
    refreshBriefs()
  }

  // 0.3.32：输入框不再自己改站点——模式由三段按钮决定。
  // 以前这里会在「非 fanbox」时强行把站点打回 fanbox（B37 的补丁），
  // 但新增「Pixiv 画师」模式后，那样会让 pixiv 目标打一个字就坏掉。
  $('#creator').addEventListener('input', () => {
    S.singlePostId = ''
    S.singlePostKind = ''
    refreshBriefs()
  })

  // 自动认画师：优先 URL 参数（从 fanbox 页点按钮进来时带的），否则问后台“当前 fanbox 标签页是谁”
  ;(async () => {
    const sp = new URLSearchParams(location.search)
    const qc = sp.get('creator') || ''
    const qp = sp.get('post') || ''
    const qm = sp.get('mode') || 'all'
    const qs = sp.get('site') || ''
    const qk = sp.get('kind') || ''
    if (qs === 'pixiv') S.site = 'pixiv'
    if (qc) {
      applyTarget(qc, qp, qm, qs, qk)
      log('从页面带出：[' + (S.site === 'pixiv' ? 'Pixiv' : 'Fanbox') + '] ' + qc + (qp ? '（单篇 ' + qp + '）' : ''))
      return
    }
    if ($('#creator').value) return
    try {
      const r = await chrome.runtime.sendMessage({ type: 'detect-creator' })
      if (r && r.ok && r.creatorId) {
        applyTarget(r.creatorId, '', 'all', 'fanbox')
        log('自动识别画师：' + r.creatorId)
      }
    } catch (e) {
      /* 忽略 */
    }
  })()

  // 已开着工作台时，从 fanbox 页点按钮会广播目标（不刷新页面，避免打断正在进行的下载）
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.creatorId) return
    if (msg.type === 'set-target') {
      // 运行中改目标会让 S.singlePostId 变化，把「单篇过滤」的判断打乱 →
      // 已完成的几百篇会被重新拉一遍 post.info。运行期间直接忽略。
      if (S.running) {
        log('! 正在下载，忽略新的目标：' + msg.creatorId)
        return
      }
      applyTarget(msg.creatorId, msg.postId, msg.mode || 'all', msg.site || 'fanbox', msg.kind || '')
      log(
        '收到目标：[' +
          (S.site === 'pixiv' ? 'Pixiv' : 'Fanbox') +
          '] ' +
          (S.singlePostId ? '单篇 ' + S.singlePostId : msg.creatorId + ' 全部'),
      )
      return
    }
    // 旧版后台还在发 set-creator 时也要能用
    if (msg.type === 'set-creator') {
      applyTarget(msg.creatorId, '', 'all', 'fanbox')
      log('收到画师：' + msg.creatorId)
    }
  })

  // 恢复上次目录 + 立刻扫描里面的画师
  // 注意：句柄能从 IndexedDB 捞回来，但读权限每次会话都要重新给一次，
  // 权限没给就不扫（否则 entries() 直接抛 NotAllowedError，看着像坏了）
  ;(async () => {
    try {
      const h = await idbGet('parent')
      if (h) {
        S.parent = h
        const p = await h.queryPermission({ mode: 'readwrite' })
        $('#dirName').textContent = '上次：' + h.name + (p === 'granted' ? '' : '（重新选一次才能扫描）')
        refreshBriefs() // 0.3.31：恢复目录后要把模块 2 的摘要补上（此时才知道目录名）
        if (p === 'granted') await scanArtists()
      }
    } catch (e) {
      /* 忽略 */
    }
  })()

  const rescanBtn = $('#rescan')
  if (rescanBtn) {
    rescanBtn.addEventListener('click', async () => {
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
      } catch (e) {
        log('! 重扫失败：' + e.message)
      }
    })
  }

  // 版本号从 manifest 读：写死在 app.html 里升级后会一直显示旧版本（实测踩过）
  try {
    const vt = $('#verTag')
    if (vt) vt.textContent = 'v' + chrome.runtime.getManifest().version
  } catch (e) {
    /* 忽略 */
  }

  log('就绪。填入画师 ID → 选择文件夹 → 开始下载。')
}

bind()

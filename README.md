# 画师文件夹下载器（Fanbox / Pixiv）

把**某位画师的全部作品**（或**你自己的 Pixiv 收藏**）按
`总文件夹（画师名）/ 每篇投稿一个文件夹 / 文件`
直接写进你在手机上选好的目录，绕开安卓浏览器「下载只能平铺」的限制。

- 扩展版：Chrome MV3（`extension/`），适用于支持扩展的安卓 Chromium 内核浏览器与桌面 Chrome/Edge
- 油猴版：单文件 userscript（`userscript/`），Tampermonkey / 篡改猴即可跑
- 版本：扩展 **v0.3.38** · 油猴 **v0.2.3**

## 为什么需要它

安卓上的 `chrome.downloads` 会把路径拍平，`a.download` 也不给建子目录。本项目统一用
**File System Access API**（`showDirectoryPicker` + `createWritable`）自己写盘，
所以「一篇投稿一个文件夹」在手机上才成立。

## 功能

| | 说明 |
|---|---|
| 三种来源 | FANBOX 画师（creatorId / 主页链接）、PIXIV 画师（uid / 主页链接）、PIXIV 我的收藏 |
| 收藏落点 | 平铺 `_我的收藏 (PIXIV)/<日期-作品id-标题>/`；分组 `_我的收藏 (PIXIV)/<画师名> (PIXIV)/<作品>/` |
| 目录约定 | 画师文件夹带 ` (FANBOX)` / ` (PIXIV)` 后缀 + `_站点.json` 标识站点；老文件夹只标记不改名 |
| 断点续传 | 扩展：单连接流式写盘；油猴：Range 分块（6 MB）+ 定位写 + `_半截.json` 台账 |
| 完整性 | 尾标校验（jpg FFD9 / png IEND / zip EOCD 等）、清单字节数、`_完成篇.jsonl` 三级判定 |
| 幂等 | 「跳过已存在」+ 二次运行跳过、清单自愈（`_清单.bak.jsonl`）、失败清单 |
| 其它 | 间隔/并发/篇数上限/单文件 MB 上限、暂停/继续/停止、导出/导入枚举 JSON、预检 |

产物结构：

```
你选的目录/
└── 画师名 (PIXIV)/
    ├── _站点.json  _清单.jsonl  _索引.csv  _进度.json  _完成篇.jsonl  _失败清单.json
    └── 20260101-12345678-标题/
        ├── 001.jpg  002.jpg …
        └── 投稿信息.txt
```

## 安装

### 1. 扩展（Load unpacked，推荐）

1. 浏览器打开 `chrome://extensions`，打开「开发者模式」
2. 「加载已解压的扩展程序」→ 选本仓库的 `extension/` 目录（**要带 `icons/` 子目录**）
3. 点扩展图标 → 打开「画师文件夹下载器」页面

也可以先打包成 CRX（Chrome 官方打包器）：

```powershell
chrome.exe --pack-extension="<本仓库>\extension" --pack-extension-key="<你自己的>.pem" --user-data-dir="<临时目录>"
```

> CRX 的扩展 ID 由打包密钥决定；换密钥 = 换 ID，**进度和记住的目录不通用**。
> 本仓库不附带 `.pem`，也不附带他人签名的 CRX。

### 2. 油猴脚本

1. 装 Tampermonkey / 篡改猴
2. 新建脚本 → 粘贴 `userscript/文件夹下载器-油猴版.user.js` 全文 → 保存
3. 打开任一 fanbox / pixiv 页面，右下角出现「📁」，点开就是面板

手机上装脚本：手机浏览器打不开 `file://` 的 `.user.js`，可用
`adb reverse tcp:8765 tcp:8765` + 电脑起个静态服务，手机访问
`http://127.0.0.1:8765/xxx.user.js`，篡改猴会自己拦截并弹安装页。

详细步骤见 `extension/安装说明.txt`（扩展）与 `userscript/油猴版说明.txt`（油猴）。

## 兼容性

| 环境 | 结论 |
|---|---|
| 安卓 Chromium 内核 + 支持扩展的浏览器（如 Kiwi、Bare Browser、Edge Canary） | ✅ 实测可用 |
| 桌面 Chrome / Edge（Windows / macOS / Linux） | ✅ 可用（`showDirectoryPicker` 支持良好） |
| Firefox / Safari | ❌ 没有 `showDirectoryPicker`，无法建目录（油猴版会退化成平铺或直接不可用） |
| 安卓 Chrome 正式版 | ❌ 不支持扩展 |

## 已知限制（说实话版）

- 每次**刷新页面后目录权限会回到 `prompt`**，需要重新点一次「允许」——浏览器行为，不是 bug。
- 收藏枚举走带 cookie 的请求，未登录时只能读到「公开收藏」。
- 油猴版拿不到响应流，所以断点续传是「按区间重发」；超大单文件的内存峰值取决于分块大小。
- 单篇模式（下载本篇）**故意不跳过**已完成的投稿（与扩展版一致）：只有 txt 的投稿每次都会重写正文。
- 已删除 / 转私密的收藏条目会以「已失效（HTTP 404），跳过」记日志，不计入失败。
- 分组名用的是「枚举那一刻」的画师名，作者改名后同一人可能出现两个文件夹（`_站点.json` 里的 uid 不变，可据此合并）。
- **未验证**：上千条收藏的分页尾页与 429 限流、fanbox 画师全量端到端（数百篇）、不同浏览器内核下的「另存为」弹窗。

## 免责声明

- 仅供**个人备份自己有权访问的内容**；请遵守 pixiv / FANBOX 的服务条款与当地法律。
- 不绕过任何付费墙：能下载的只是当前账号本来就能看到的东西。
- 作者不对使用者的账号状态、数据丢失或平台纠纷负责。

## 许可证

[MIT](LICENSE)
